// diag-cccycle prints, for a single account, the best-fit error at every
// (grace period, cycle length) combination against a specific payment — to
// understand the MAGNITUDE of mismatch (a few dollars = boundary/date-field
// imprecision; hundreds of dollars = a fundamentally different issue like
// partial payments) rather than guessing blindly.
//
// Usage:
//
//	DYNAMODB_TABLE=finance-app-prod go run ./scripts/diag-cccycle --account <accountId>
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"sort"
	"strings"
	"time"

	dbpkg "github.com/smcdermott/finance-app/internal/db"
)

func main() {
	accountID := flag.String("account", "", "accountId to diagnose (required)")
	months := flag.Int("months", 6, "months of history to consider")
	flag.Parse()
	if *accountID == "" {
		log.Fatal("--account is required")
	}

	ctx := context.Background()
	db, err := dbpkg.New(ctx)
	if err != nil {
		log.Fatalf("db init: %v", err)
	}

	end := time.Now().UTC()
	start := end.AddDate(0, -*months, 0)
	txns, err := db.GetTransactions(ctx, *accountID, start.Format("2006-01-02"), end.Format("2006-01-02"))
	if err != nil {
		log.Fatalf("get transactions: %v", err)
	}

	type row struct {
		date         time.Time
		authDate     time.Time
		amt          float64
		name         string
		isPayment    bool
	}
	var all []row
	for _, t := range txns {
		if t.Pending || t.Synthetic {
			continue
		}
		d, err := time.Parse("2006-01-02", t.Date)
		if err != nil {
			continue
		}
		ad := d
		if t.AuthorizedDate != "" {
			if parsed, err := time.Parse("2006-01-02", t.AuthorizedDate); err == nil {
				ad = parsed
			}
		}
		name := t.MerchantName
		if name == "" {
			name = t.Name
		}
		all = append(all, row{date: d, authDate: ad, amt: t.Amount, name: name, isPayment: t.Amount < 0 && dbpkg.LooksLikeStatementPayment(name)})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].date.Before(all[j].date) })

	var payments []row
	for _, r := range all {
		if r.isPayment {
			payments = append(payments, r)
		}
	}
	fmt.Printf("Found %d payments for account %s\n", len(payments), *accountID)

	sumUsingDate := func(useAuth bool, afterExclusive, throughInclusive time.Time) float64 {
		var sum float64
		for _, r := range all {
			if r.isPayment {
				continue
			}
			d := r.date
			if useAuth {
				d = r.authDate
			}
			if d.After(afterExclusive) && !d.After(throughInclusive) {
				sum += r.amt
			}
		}
		return sum
	}

	for _, p := range payments {
		amount := -p.amt
		fmt.Printf("\n--- Payment %s: $%.2f (%s) ---\n", p.date.Format("2006-01-02"), amount, strings.TrimSpace(p.name))
		bestErr := 1e18
		bestDesc := ""
		for _, useAuth := range []bool{false, true} {
			label := "Date"
			if useAuth {
				label = "AuthorizedDate"
			}
			for g := 15; g <= 35; g++ {
				closeDate := p.date.AddDate(0, 0, -g)
				for cycleLen := 25; cycleLen <= 32; cycleLen++ {
					cycleStart := closeDate.AddDate(0, 0, -cycleLen)
					sum := sumUsingDate(useAuth, cycleStart, closeDate)
					errAbs := sum - amount
					if errAbs < 0 {
						errAbs = -errAbs
					}
					if errAbs < bestErr {
						bestErr = errAbs
						bestDesc = fmt.Sprintf("field=%s grace=%d cycleLen=%d close=%s sum=$%.2f err=$%.2f",
							label, g, cycleLen, closeDate.Format("2006-01-02"), sum, sum-amount)
					}
				}
			}
		}
		fmt.Printf("  BEST FIT: %s\n", bestDesc)
	}
}

// cccycle-check validates the credit card billing cycle reconstruction
// (internal/db/cccycle.go) against real synced transaction data, without
// needing to deploy anything. Prints the reconstructed cycle plus the raw
// payment events it found, so the result can be sanity-checked against your
// actual statements before wiring this into the cash flow forecast.
//
// Usage:
//
//	DYNAMODB_TABLE=finance-app-prod go run ./scripts/cccycle-check
//	DYNAMODB_TABLE=finance-app-prod go run ./scripts/cccycle-check --account <accountId>
//	DYNAMODB_TABLE=finance-app-prod go run ./scripts/cccycle-check --months 12
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"time"

	dbpkg "github.com/smcdermott/finance-app/internal/db"
	plaidclient "github.com/smcdermott/finance-app/internal/plaid"
)

func main() {
	accountID := flag.String("account", "", "Only check this accountId (default: all credit-type accounts)")
	months := flag.Int("months", 6, "Months of transaction history to consider")
	flag.Parse()

	ctx := context.Background()
	db, err := dbpkg.New(ctx)
	if err != nil {
		log.Fatalf("db init: %v", err)
	}

	userID := plaidclient.UserID()
	accounts, err := db.GetAccounts(ctx, userID)
	if err != nil {
		log.Fatalf("get accounts: %v", err)
	}

	end := time.Now().UTC()
	start := end.AddDate(0, -*months, 0)
	startStr := start.Format("2006-01-02")
	endStr := end.Format("2006-01-02")

	found := 0
	for _, acct := range accounts {
		if acct.Type != "credit" {
			continue
		}
		if *accountID != "" && acct.AccountID != *accountID {
			continue
		}
		found++

		txns, err := db.GetTransactions(ctx, acct.AccountID, startStr, endStr)
		if err != nil {
			log.Printf("error fetching transactions for %s: %v", acct.AccountID, err)
			continue
		}

		fmt.Printf("\n=== %s (%s) — accountId %s ===\n", acct.Institution, acct.Name, acct.AccountID)
		fmt.Printf("Transactions in window [%s, %s]: %d\n", startStr, endStr, len(txns))

		var payments []dbpkg.Transaction
		var chargeCount int
		for _, t := range txns {
			if t.Pending || t.Synthetic {
				continue
			}
			name := t.MerchantName
			if name == "" {
				name = t.Name
			}
			if t.Amount < 0 && dbpkg.LooksLikeStatementPayment(name) {
				payments = append(payments, t)
			} else {
				chargeCount++
			}
		}
		fmt.Printf("Payments found: %d | Other transactions (charges + refunds): %d\n", len(payments), chargeCount)
		for _, p := range payments {
			fmt.Printf("  payment: %s | %-40s | $%.2f\n", p.Date, p.Name, -p.Amount)
		}

		result := dbpkg.ReconstructCreditCardCycle(txns, end)
		fmt.Printf("\nReconstruction result:\n")
		fmt.Printf("  Confidence:          %s\n", result.Confidence)
		fmt.Printf("  Payments considered: %d | fit: %d\n", result.PaymentsConsidered, result.PaymentsFit)
		switch result.Confidence {
		case "high":
			fmt.Printf("  Payment due day:     %d\n", result.PaymentDueDay)
			fmt.Printf("  Grace period (days): %d\n", result.GracePeriodDays)
			fmt.Printf("  Next close date:     %s\n", result.NextCloseDate)
			fmt.Printf("  Next due date:       %s\n", result.NextDueDate)
			fmt.Printf("  Projected next payment (floor, as-of today): $%.2f\n", result.ProjectedNextPaymentAmount)
		case "low":
			fmt.Printf("  [fallback] Mean payment day-of-month: %d\n", result.FallbackMeanDay)
			fmt.Printf("  [fallback] Mean payment amount:       $%.2f\n", result.FallbackMeanAmount)
			fmt.Printf("  Current-cycle window: since %s through %s (%d txns, sum $%.2f)\n",
				result.LastCloseDate, endStr, len(result.WindowTransactions), sumTxns(result.WindowTransactions))
			for _, t := range result.WindowTransactions {
				fmt.Printf("    %s | $%.2f\n", t.Date, t.Amount)
			}
		default:
			fmt.Printf("  Not enough payment history to reconstruct a cycle.\n")
		}
	}

	if found == 0 {
		fmt.Println("No matching credit-type accounts found.")
	}
}

func sumTxns(txns []dbpkg.CCTxnSummary) float64 {
	var sum float64
	for _, t := range txns {
		sum += t.Amount
	}
	return sum
}

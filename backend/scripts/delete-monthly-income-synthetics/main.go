// delete-monthly-income-synthetics removes the old monthly income variance
// synthetic transactions (TransactionID pattern: "variance-income-<srcID>-<YYYY-MM>")
// that were replaced by per-paycheck synthetics ("variance-income-<txnID>").
//
// Usage:
//
//	AWS_PROFILE=aws-profile DYNAMODB_TABLE=finance-app-prod \
//	  go run ./scripts/delete-monthly-income-synthetics [--dry-run]
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"regexp"

	dbpkg "github.com/smcdermott/finance-app/internal/db"
)

// Old monthly IDs look like: variance-income-<uuid>-<YYYY-MM>
// e.g. variance-income-abc123-2026-04
// New per-paycheck IDs look like: variance-income-<plaid-txn-id> (no trailing YYYY-MM)
var oldPattern = regexp.MustCompile(`^variance-income-.+-\d{4}-\d{2}$`)

func main() {
	dryRun := flag.Bool("dry-run", false, "Print what would be deleted without deleting")
	flag.Parse()

	ctx := context.Background()
	db, err := dbpkg.New(ctx)
	if err != nil {
		log.Fatalf("db init: %v", err)
	}

	// All synthetic transactions live in the system account.
	txns, err := db.GetTransactions(ctx, dbpkg.SystemAccountID, "2000-01-01", "2999-12-31")
	if err != nil {
		log.Fatalf("get transactions: %v", err)
	}

	var toDelete []dbpkg.Transaction
	for _, t := range txns {
		if oldPattern.MatchString(t.TransactionID) {
			toDelete = append(toDelete, t)
		}
	}

	if len(toDelete) == 0 {
		fmt.Println("No old monthly income variance synthetics found.")
		return
	}

	for _, t := range toDelete {
		if *dryRun {
			fmt.Printf("  [DRY-RUN] would delete: %s  (%s)\n", t.TransactionID, t.Date)
			continue
		}
		if err := db.DeleteTransaction(ctx, dbpkg.SystemAccountID, t.Date, t.TransactionID); err != nil {
			log.Printf("  [WARN] delete %s: %v", t.TransactionID, err)
			continue
		}
		fmt.Printf("  deleted: %s  (%s)\n", t.TransactionID, t.Date)
	}

	if *dryRun {
		fmt.Printf("\nDry run complete. Would delete %d transaction(s).\n", len(toDelete))
	} else {
		fmt.Printf("\nDone. Deleted %d transaction(s).\n", len(toDelete))
	}
}

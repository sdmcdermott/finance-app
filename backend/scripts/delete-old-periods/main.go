// delete-old-periods removes all budget periods with a start date before a
// given cutoff. Run once to clean up periods that have no transactions.
//
// Usage:
//
//	AWS_PROFILE=aws-profile DYNAMODB_TABLE=finance-app-prod \
//	  go run ./scripts/delete-old-periods --before 2026-04-01
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	dbpkg "github.com/smcdermott/finance-app/internal/db"
	plaidclient "github.com/smcdermott/finance-app/internal/plaid"
)

func main() {
	before := flag.String("before", "", "Delete periods with startDate < this value (YYYY-MM-DD, required)")
	dryRun := flag.Bool("dry-run", false, "Print what would be deleted without deleting")
	flag.Parse()

	if *before == "" {
		fmt.Fprintln(os.Stderr, "error: --before is required (e.g. --before 2026-04-01)")
		os.Exit(1)
	}

	ctx := context.Background()

	db, err := dbpkg.New(ctx)
	if err != nil {
		log.Fatalf("db init: %v", err)
	}

	userID := plaidclient.UserID()
	budgets, err := db.GetBudgets(ctx, userID)
	if err != nil {
		log.Fatalf("get budgets: %v", err)
	}
	fmt.Printf("Found %d budgets\n", len(budgets))

	// We need a raw DynamoDB client for the delete calls.
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		log.Fatalf("aws config: %v", err)
	}
	ddb := dynamodb.NewFromConfig(cfg)
	table := os.Getenv("DYNAMODB_TABLE")
	if table == "" {
		log.Fatal("DYNAMODB_TABLE env var is required")
	}

	totalDeleted := 0
	for _, budget := range budgets {
		periods, err := db.GetBudgetPeriods(ctx, budget.BudgetID)
		if err != nil {
			log.Printf("  [WARN] get periods for %s (%s): %v", budget.Name, budget.BudgetID, err)
			continue
		}

		for _, p := range periods {
			if p.StartDate >= *before {
				continue
			}
			if *dryRun {
				fmt.Printf("  [DRY-RUN] would delete: budget=%q period=%s\n", budget.Name, p.StartDate)
				totalDeleted++
				continue
			}
			_, err := ddb.DeleteItem(ctx, &dynamodb.DeleteItemInput{
				TableName: &table,
				Key: map[string]types.AttributeValue{
					"pk": &types.AttributeValueMemberS{Value: "BUDGET#" + budget.BudgetID},
					"sk": &types.AttributeValueMemberS{Value: "PERIOD#" + p.StartDate},
				},
			})
			if err != nil {
				log.Printf("  [WARN] delete period %s for %s: %v", p.StartDate, budget.Name, err)
				continue
			}
			fmt.Printf("  deleted: budget=%q period=%s\n", budget.Name, p.StartDate)
			totalDeleted++
		}
	}

	if *dryRun {
		fmt.Printf("\nDry run complete. Would delete %d period(s).\n", totalDeleted)
	} else {
		fmt.Printf("\nDone. Deleted %d period(s).\n", totalDeleted)
	}
}

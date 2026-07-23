// backfill-amazon-notes reads an Amazon order CSV, finds already-linked
// transactions (matched via "Amazon Order #<orderID>" in referenceNote), and
// writes the item titles as the transaction note — filling the gap for orders
// that were imported before the note field was introduced.
//
// Usage:
//
//	AWS_PROFILE=aws-profile DYNAMODB_TABLE=finance-app-prod \
//	  go run ./scripts/backfill-amazon-notes --csv ~/downloads/amazon.csv
//
// Flags:
//
//	--csv       Path to the Amazon order CSV (required)
//	--dry-run   Print what would be updated without writing to DynamoDB
//	--overwrite Also update transactions that already have a note set
package main

import (
	"context"
	"encoding/csv"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	dbpkg "github.com/smcdermott/finance-app/internal/db"
)

func main() {
	csvPath := flag.String("csv", "", "Path to the Amazon order CSV (required)")
	dryRun := flag.Bool("dry-run", false, "Print what would be updated without writing")
	overwrite := flag.Bool("overwrite", false, "Also update transactions that already have a note")
	flag.Parse()

	if *csvPath == "" {
		fmt.Fprintln(os.Stderr, "error: --csv is required")
		flag.Usage()
		os.Exit(1)
	}

	table := os.Getenv("DYNAMODB_TABLE")
	if table == "" {
		fmt.Fprintln(os.Stderr, "error: DYNAMODB_TABLE env var is required")
		os.Exit(1)
	}

	// ── Parse CSV ────────────────────────────────────────────────────────────

	orderTitles, err := parseCSV(*csvPath)
	if err != nil {
		log.Fatalf("parse CSV: %v", err)
	}
	fmt.Printf("Parsed %d orders from CSV.\n", len(orderTitles))

	// ── Connect to DynamoDB ──────────────────────────────────────────────────

	ctx := context.Background()
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion("us-east-1"))
	if err != nil {
		log.Fatalf("load AWS config: %v", err)
	}
	ddb := dynamodb.NewFromConfig(cfg)

	dbClient, err := dbpkg.New(ctx)
	if err != nil {
		log.Fatalf("init db client: %v", err)
	}

	// ── For each order, find matching transactions and update notes ───────────

	updated, skipped, notFound := 0, 0, 0

	for orderID, titles := range orderTitles {
		note := strings.Join(titles, ", ")
		prefix := fmt.Sprintf("Amazon Order #%s", orderID)

		txns, err := scanByReferenceNote(ctx, ddb, table, prefix)
		if err != nil {
			log.Printf("WARN: scan for order %s: %v", orderID, err)
			continue
		}

		if len(txns) == 0 {
			fmt.Printf("  [not found] %s — %s\n", orderID, truncate(note, 60))
			notFound++
			continue
		}

		for _, txn := range txns {
			if txn.Note != "" && !*overwrite {
				fmt.Printf("  [skip]      %s  %s  (already has note)\n", txn.Date, txn.DateTransactionID)
				skipped++
				continue
			}

			fmt.Printf("  [update]    %s  %s  → %s\n", txn.Date, txn.DateTransactionID, truncate(note, 60))

			if !*dryRun {
				// DateTransactionID format: <date>#<txnId>
				parts := strings.SplitN(txn.DateTransactionID, "#", 2)
				if len(parts) != 2 {
					log.Printf("WARN: unexpected DateTransactionID format: %s", txn.DateTransactionID)
					continue
				}
				if err := dbClient.UpdateTransactionNote(ctx, txn.AccountID, parts[0], parts[1], note); err != nil {
					log.Printf("WARN: update note for %s: %v", txn.DateTransactionID, err)
					continue
				}
			}
			updated++
		}
	}

	fmt.Printf("\nDone. updated=%d  skipped=%d  not_found=%d", updated, skipped, notFound)
	if *dryRun {
		fmt.Print("  (dry-run — no writes performed)")
	}
	fmt.Println()
}

// parseCSV reads an Amazon order CSV and returns a map of orderID → []title.
// Supports both the native Amazon export and Chrome extension formats.
func parseCSV(path string) (map[string][]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	r := csv.NewReader(f)
	r.LazyQuotes = true
	r.TrimLeadingSpace = true
	records, err := r.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("read CSV: %w", err)
	}
	if len(records) < 2 {
		return nil, fmt.Errorf("CSV has no data rows")
	}

	// Build case-insensitive column index
	colIdx := make(map[string]int)
	for i, h := range records[0] {
		colIdx[strings.ToLower(strings.TrimSpace(h))] = i
	}

	orderIDCol := firstCol(colIdx, "order id", "order_id", "orderid")
	titleCol := firstCol(colIdx, "title", "product name", "item name", "itemtitles")

	if orderIDCol < 0 {
		return nil, fmt.Errorf("could not find Order ID column (headers: %v)", records[0])
	}
	if titleCol < 0 {
		return nil, fmt.Errorf("could not find Title column (headers: %v)", records[0])
	}

	result := make(map[string][]string)
	seen := make(map[string]map[string]bool) // dedup titles per order

	for _, row := range records[1:] {
		if len(row) <= orderIDCol {
			continue
		}
		orderID := strings.TrimSpace(row[orderIDCol])
		if orderID == "" {
			continue
		}
		if seen[orderID] == nil {
			seen[orderID] = make(map[string]bool)
		}
		if titleCol < len(row) {
			raw := strings.TrimSpace(row[titleCol])
			// Chrome extension packs all titles in one cell separated by "|"
			for _, part := range strings.Split(raw, "|") {
				t := strings.TrimSpace(part)
				if t != "" && !seen[orderID][t] {
					seen[orderID][t] = true
					result[orderID] = append(result[orderID], t)
				}
			}
		}
	}

	return result, nil
}

// scanByReferenceNote finds transactions whose referenceNote begins with prefix.
// Uses a FilterExpression scan (fine for a one-off backfill script).
func scanByReferenceNote(ctx context.Context, ddb *dynamodb.Client, table, prefix string) ([]dbpkg.Transaction, error) {
	var txns []dbpkg.Transaction
	var lastKey map[string]types.AttributeValue

	for {
		input := &dynamodb.ScanInput{
			TableName:        aws.String(table),
			FilterExpression: aws.String("begins_with(sk, :txnPrefix) AND begins_with(referenceNote, :refPrefix)"),
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":txnPrefix": &types.AttributeValueMemberS{Value: "TXN#"},
				":refPrefix": &types.AttributeValueMemberS{Value: prefix},
			},
		}
		if lastKey != nil {
			input.ExclusiveStartKey = lastKey
		}

		out, err := ddb.Scan(ctx, input)
		if err != nil {
			return nil, err
		}

		var page []dbpkg.Transaction
		if err := attributevalue.UnmarshalListOfMaps(out.Items, &page); err != nil {
			return nil, err
		}
		txns = append(txns, page...)

		if out.LastEvaluatedKey == nil {
			break
		}
		lastKey = out.LastEvaluatedKey
	}

	return txns, nil
}

func firstCol(idx map[string]int, names ...string) int {
	for _, n := range names {
		if i, ok := idx[n]; ok {
			return i
		}
	}
	return -1
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}

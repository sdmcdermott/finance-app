// backfill-refund-reference-urls copies the referenceUrl (and referenceNote) from
// a credit transaction to its linked debit when the debit has no referenceUrl set.
//
// This mirrors the logic added to confirm-refunds for new pairs: if an Amazon
// refund credit already has an order URL attached, the original charge should
// carry that same link.
//
// Algorithm:
//  1. Scan all TXN# items that have linkedRefundIds (debits with at least one refund).
//  2. For each such debit that has no referenceUrl, look up every credit in its
//     linkedRefundIds list.
//  3. Take the first credit that has a referenceUrl and copy it to the debit.
//
// Usage:
//
//	AWS_PROFILE=aws-profile DYNAMODB_TABLE=finance-app-prod \
//	  go run ./scripts/backfill-refund-reference-urls
//
// Flags:
//
//	--dry-run   Print what would be updated without writing to DynamoDB
package main

import (
	"context"
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
	dryRun := flag.Bool("dry-run", false, "Print what would be updated without writing")
	flag.Parse()

	table := os.Getenv("DYNAMODB_TABLE")
	if table == "" {
		fmt.Fprintln(os.Stderr, "error: DYNAMODB_TABLE env var is required")
		os.Exit(1)
	}

	ctx := context.Background()
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion("us-east-1"))
	if err != nil {
		log.Fatalf("load AWS config: %v", err)
	}
	ddb := dynamodb.NewFromConfig(cfg)

	// ── Pass 1: load every TXN item into memory (we need to resolve credits by DTID) ──

	fmt.Println("Scanning all transactions…")
	allTxns := map[string]dbpkg.Transaction{}                // dateTransactionId → Transaction
	allItems := map[string]map[string]types.AttributeValue{} // dateTransactionId → raw item (for pk/sk)

	var lastKey map[string]types.AttributeValue
	for {
		input := &dynamodb.ScanInput{
			TableName:        &table,
			FilterExpression: aws.String("begins_with(sk, :skPrefix)"),
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":skPrefix": &types.AttributeValueMemberS{Value: "TXN#"},
			},
		}
		if lastKey != nil {
			input.ExclusiveStartKey = lastKey
		}

		out, err := ddb.Scan(ctx, input)
		if err != nil {
			log.Fatalf("scan: %v", err)
		}
		for _, item := range out.Items {
			var txn dbpkg.Transaction
			if err := attributevalue.UnmarshalMap(item, &txn); err != nil {
				log.Printf("WARN: unmarshal: %v", err)
				continue
			}
			allTxns[txn.DateTransactionID] = txn
			// deep-copy the item map so we keep pk/sk for UpdateItem
			itemCopy := make(map[string]types.AttributeValue, len(item))
			for k, v := range item {
				itemCopy[k] = v
			}
			allItems[txn.DateTransactionID] = itemCopy
		}
		if out.LastEvaluatedKey == nil {
			break
		}
		lastKey = out.LastEvaluatedKey
	}
	fmt.Printf("Loaded %d transactions.\n\n", len(allTxns))

	// ── Pass 2: find debits with linkedRefundIds but no referenceUrl ──

	updated, skipped, noCredit := 0, 0, 0

	for dtid, debit := range allTxns {
		if len(debit.LinkedRefundIds) == 0 {
			continue
		}
		if debit.ReferenceURL != "" {
			skipped++
			continue
		}

		// Find the first credit in the list that has a referenceUrl.
		var srcURL, srcNote string
		for _, creditDTID := range debit.LinkedRefundIds {
			credit, ok := allTxns[creditDTID]
			if !ok {
				continue
			}
			if credit.ReferenceURL != "" {
				srcURL = credit.ReferenceURL
				srcNote = credit.ReferenceNote
				break
			}
		}

		if srcURL == "" {
			noCredit++
			continue
		}

		fmt.Printf("  [update]  debit=%s\n            url=%s\n            note=%s\n",
			dtid, truncate(srcURL, 80), truncate(srcNote, 80))

		if !*dryRun {
			item, ok := allItems[dtid]
			if !ok {
				log.Printf("WARN: no raw item for %s", dtid)
				continue
			}
			_, err := ddb.UpdateItem(ctx, &dynamodb.UpdateItemInput{
				TableName: &table,
				Key: map[string]types.AttributeValue{
					"pk": item["pk"],
					"sk": item["sk"],
				},
				// Only write if referenceUrl is still absent (idempotency guard).
				ConditionExpression: aws.String("attribute_not_exists(referenceUrl) OR referenceUrl = :empty"),
				UpdateExpression:    aws.String("SET referenceUrl = :url, referenceNote = :note"),
				ExpressionAttributeValues: map[string]types.AttributeValue{
					":url":   &types.AttributeValueMemberS{Value: srcURL},
					":note":  &types.AttributeValueMemberS{Value: srcNote},
					":empty": &types.AttributeValueMemberS{Value: ""},
				},
			})
			if err != nil {
				if strings.Contains(err.Error(), "ConditionalCheckFailedException") {
					fmt.Printf("            (already has referenceUrl — skipped)\n")
					skipped++
					continue
				}
				log.Printf("WARN: update %s: %v", dtid, err)
				continue
			}
		}
		updated++
	}

	fmt.Printf("\nDone. updated=%d  skipped(already had url)=%d  skipped(no credit url)=%d",
		updated, skipped, noCredit)
	if *dryRun {
		fmt.Print("  (dry-run — no writes performed)")
	}
	fmt.Println()
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

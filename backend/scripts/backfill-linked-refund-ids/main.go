// backfill-linked-refund-ids migrates the legacy 1:1 linkedRefundId field on
// debit transactions to the new linkedRefundIds []string field that supports
// multiple partial refunds per charge.
//
// For each transaction that has linkedRefundId set but linkedRefundIds absent
// (or empty), this script writes linkedRefundIds = [linkedRefundId].
//
// Usage:
//
//	AWS_PROFILE=aws-profile DYNAMODB_TABLE=finance-app-prod \
//	  go run ./scripts/backfill-linked-refund-ids
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

	dbClient, err := dbpkg.New(ctx)
	if err != nil {
		log.Fatalf("init db client: %v", err)
	}
	_ = dbClient // used for account lookup

	// ── Scan all TXN# items ──────────────────────────────────────────────────

	updated, skipped := 0, 0
	var lastKey map[string]types.AttributeValue

	for {
		input := &dynamodb.ScanInput{
			TableName:        &table,
			FilterExpression: aws.String("begins_with(sk, :skPrefix) AND attribute_exists(linkedRefundId) AND (attribute_not_exists(linkedRefundIds) OR size(linkedRefundIds) = :zero)"),
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":skPrefix": &types.AttributeValueMemberS{Value: "TXN#"},
				":zero":     &types.AttributeValueMemberN{Value: "0"},
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

			if txn.LinkedRefundId == "" {
				skipped++
				continue
			}

			fmt.Printf("  [migrate]  %s  linkedRefundId=%s\n", txn.DateTransactionID, truncate(txn.LinkedRefundId, 50))

			if !*dryRun {
				pk := item["pk"]
				sk := item["sk"]

				refundIdsAV, err := attributevalue.MarshalList([]string{txn.LinkedRefundId})
				if err != nil {
					log.Printf("WARN: marshal linkedRefundIds for %s: %v", txn.DateTransactionID, err)
					continue
				}

				_, err = ddb.UpdateItem(ctx, &dynamodb.UpdateItemInput{
					TableName: &table,
					Key: map[string]types.AttributeValue{
						"pk": pk,
						"sk": sk,
					},
					UpdateExpression: aws.String("SET linkedRefundIds = :ids"),
					ExpressionAttributeValues: map[string]types.AttributeValue{
						":ids":  &types.AttributeValueMemberL{Value: refundIdsAV},
						":zero": &types.AttributeValueMemberN{Value: "0"},
					},
					// Only write if linkedRefundIds is still absent (idempotency guard).
					ConditionExpression: aws.String("attribute_not_exists(linkedRefundIds) OR size(linkedRefundIds) = :zero"),
				})
				if err != nil {
					// Condition failed = another process already migrated this item; safe to skip.
					if strings.Contains(err.Error(), "ConditionalCheckFailedException") {
						fmt.Printf("           (already migrated — skipped)\n")
						skipped++
						continue
					}
					log.Printf("WARN: update %s: %v", txn.DateTransactionID, err)
					continue
				}
			}
			updated++
		}

		if out.LastEvaluatedKey == nil {
			break
		}
		lastKey = out.LastEvaluatedKey
	}

	fmt.Printf("\nDone. migrated=%d  skipped=%d", updated, skipped)
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

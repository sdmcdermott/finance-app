// clear-refund-links removes all refund linkage fields from every transaction
// in the table: linkedRefundId, linkedRefundIds, and linkedOriginalId.
//
// Use this to reset refund state so it can be re-confirmed from scratch.
//
// Usage:
//
//	AWS_PROFILE=aws-profile DYNAMODB_TABLE=finance-app-prod \
//	  go run ./scripts/clear-refund-links
//
// Flags:
//
//	--dry-run   Print what would be cleared without writing to DynamoDB
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	dbpkg "github.com/smcdermott/finance-app/internal/db"
)

func main() {
	dryRun := flag.Bool("dry-run", false, "Print what would be cleared without writing")
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

	cleared, skipped := 0, 0
	var lastKey map[string]types.AttributeValue

	for {
		input := &dynamodb.ScanInput{
			TableName:        &table,
			FilterExpression: aws.String("begins_with(sk, :skPrefix) AND (attribute_exists(linkedRefundId) OR attribute_exists(linkedRefundIds) OR attribute_exists(linkedOriginalId))"),
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
				skipped++
				continue
			}

			// Determine which attributes to remove.
			var removeAttrs []string
			if txn.LinkedRefundId != "" {
				removeAttrs = append(removeAttrs, "linkedRefundId")
			}
			if len(txn.LinkedRefundIds) > 0 {
				removeAttrs = append(removeAttrs, "linkedRefundIds")
			}
			if txn.LinkedOriginalId != "" {
				removeAttrs = append(removeAttrs, "linkedOriginalId")
			}
			if len(removeAttrs) == 0 {
				skipped++
				continue
			}

			fmt.Printf("  [clear]  %s  removing: %v\n", txn.DateTransactionID, removeAttrs)

			if !*dryRun {
				updateExpr := "REMOVE"
				for i, attr := range removeAttrs {
					if i > 0 {
						updateExpr += ","
					}
					updateExpr += " " + attr
				}

				_, err := ddb.UpdateItem(ctx, &dynamodb.UpdateItemInput{
					TableName: &table,
					Key: map[string]types.AttributeValue{
						"pk": item["pk"],
						"sk": item["sk"],
					},
					UpdateExpression: aws.String(updateExpr),
				})
				if err != nil {
					log.Printf("WARN: clear %s: %v", txn.DateTransactionID, err)
					skipped++
					continue
				}
			}
			cleared++
		}

		if out.LastEvaluatedKey == nil {
			break
		}
		lastKey = out.LastEvaluatedKey
	}

	fmt.Printf("\nDone. cleared=%d  skipped=%d", cleared, skipped)
	if *dryRun {
		fmt.Print("  (dry-run — no writes performed)")
	}
	fmt.Println()
}

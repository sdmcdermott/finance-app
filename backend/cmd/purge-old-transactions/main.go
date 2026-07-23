// purge-old-transactions scans the DynamoDB table for Transaction (TXN#) and
// TransactionSplit (SPLIT#) items whose date is strictly before a cutoff date,
// then deletes them in batches.
//
// Usage:
//
//	DYNAMODB_TABLE=finance-app-prod \
//	  go run ./cmd/purge-old-transactions [--before YYYY-MM-DD] [--confirm]
//
// Flags:
//
//	--before YYYY-MM-DD   Delete items with a date before this value (default: 2026-04-01)
//	--confirm             Actually delete; omit to do a dry run (prints what would be deleted)
//
// The command uses your ambient AWS credentials (env vars, ~/.aws/credentials, IAM role, etc.)
// and the DYNAMODB_TABLE / DYNAMODB_ENDPOINT env vars, consistent with the rest of the backend.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

const batchSize = 25 // DynamoDB BatchWriteItem maximum

func main() {
	before := flag.String("before", "2026-04-01", "Delete TXN/SPLIT items with a date strictly before this value (YYYY-MM-DD)")
	confirm := flag.Bool("confirm", false, "Actually delete items; omit for a dry run")
	flag.Parse()

	table := os.Getenv("DYNAMODB_TABLE")
	if table == "" {
		log.Fatal("DYNAMODB_TABLE env var is required")
	}

	ctx := context.Background()

	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		log.Fatalf("load AWS config: %v", err)
	}

	var clientOpts []func(*dynamodb.Options)
	if endpoint := os.Getenv("DYNAMODB_ENDPOINT"); endpoint != "" {
		clientOpts = append(clientOpts, func(o *dynamodb.Options) {
			o.BaseEndpoint = aws.String(endpoint)
		})
	}
	ddb := dynamodb.NewFromConfig(cfg, clientOpts...)

	// SK upper bounds (exclusive): everything strictly less than these values
	// is a TXN or SPLIT item dated before the cutoff.
	//
	//   TXN items:   TXN#<YYYY-MM-DD>#<id>   → upper bound = "TXN#<before>"
	//   SPLIT items: SPLIT#<YYYY-MM-DD>#...  → upper bound = "SPLIT#<before>"
	//
	// We use sk < upper (FilterExpression) which DynamoDB supports as a string
	// comparison on the full SK value.
	txnUpper := "TXN#" + *before
	splitUpper := "SPLIT#" + *before

	if *confirm {
		fmt.Printf("MODE: DELETE — items with sk < %q or sk < %q in table %q\n\n", txnUpper, splitUpper, table)
	} else {
		fmt.Printf("MODE: DRY RUN — pass --confirm to actually delete\n")
		fmt.Printf("Looking for items with sk < %q or sk < %q in table %q\n\n", txnUpper, splitUpper, table)
	}

	keys, err := scanOldItems(ctx, ddb, table, txnUpper, splitUpper)
	if err != nil {
		log.Fatalf("scan: %v", err)
	}

	fmt.Printf("Found %d item(s) to delete\n", len(keys))
	if len(keys) == 0 {
		fmt.Println("Nothing to do.")
		return
	}

	if !*confirm {
		fmt.Println("\nDry-run sample (up to 20):")
		for i, k := range keys {
			if i >= 20 {
				fmt.Printf("  ... and %d more\n", len(keys)-20)
				break
			}
			fmt.Printf("  pk=%-45s  sk=%s\n", k["pk"].(*types.AttributeValueMemberS).Value, k["sk"].(*types.AttributeValueMemberS).Value)
		}
		fmt.Println("\nRe-run with --confirm to delete.")
		return
	}

	deleted, err := batchDelete(ctx, ddb, table, keys)
	if err != nil {
		log.Fatalf("delete: %v", err)
	}
	fmt.Printf("\nDeleted %d item(s).\n", deleted)
}

// scanOldItems performs a full-table Scan with a FilterExpression that selects
// only TXN and SPLIT items dated before the cutoff.  It returns just the
// primary key attributes (pk + sk) of each matching item.
func scanOldItems(
	ctx context.Context,
	ddb *dynamodb.Client,
	table, txnUpper, splitUpper string,
) ([]map[string]types.AttributeValue, error) {

	var (
		keys           []map[string]types.AttributeValue
		exclusiveStart map[string]types.AttributeValue
		page           int
	)

	for {
		page++
		input := &dynamodb.ScanInput{
			TableName:            aws.String(table),
			ProjectionExpression: aws.String("pk, sk"),
			// Match any TXN item before the cutoff OR any SPLIT item before the cutoff.
			FilterExpression: aws.String(
				"(begins_with(sk, :txnPfx)  AND sk < :txnUpper) OR " +
					"(begins_with(sk, :splitPfx) AND sk < :splitUpper)",
			),
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":txnPfx":     &types.AttributeValueMemberS{Value: "TXN#"},
				":txnUpper":   &types.AttributeValueMemberS{Value: txnUpper},
				":splitPfx":   &types.AttributeValueMemberS{Value: "SPLIT#"},
				":splitUpper": &types.AttributeValueMemberS{Value: splitUpper},
			},
		}
		if exclusiveStart != nil {
			input.ExclusiveStartKey = exclusiveStart
		}

		out, err := ddb.Scan(ctx, input)
		if err != nil {
			return nil, fmt.Errorf("scan page %d: %w", page, err)
		}

		keys = append(keys, out.Items...)
		fmt.Printf("  Scanned page %d — %d item(s) matched so far\n", page, len(keys))

		if out.LastEvaluatedKey == nil {
			break
		}
		exclusiveStart = out.LastEvaluatedKey
	}

	return keys, nil
}

// batchDelete deletes all supplied primary keys using BatchWriteItem in chunks
// of batchSize (25).  Returns the total number of successfully deleted items.
func batchDelete(
	ctx context.Context,
	ddb *dynamodb.Client,
	table string,
	keys []map[string]types.AttributeValue,
) (int, error) {
	deleted := 0

	for i := 0; i < len(keys); i += batchSize {
		end := i + batchSize
		if end > len(keys) {
			end = len(keys)
		}
		chunk := keys[i:end]

		requests := make([]types.WriteRequest, len(chunk))
		for j, k := range chunk {
			requests[j] = types.WriteRequest{
				DeleteRequest: &types.DeleteRequest{Key: k},
			}
		}

		out, err := ddb.BatchWriteItem(ctx, &dynamodb.BatchWriteItemInput{
			RequestItems: map[string][]types.WriteRequest{
				table: requests,
			},
		})
		if err != nil {
			return deleted, fmt.Errorf("BatchWriteItem chunk %d-%d: %w", i, end-1, err)
		}

		// Unprocessed items should be rare (throttling), but handle them.
		unprocessed := len(out.UnprocessedItems[table])
		processed := len(chunk) - unprocessed
		deleted += processed

		if unprocessed > 0 {
			fmt.Printf("  Warning: %d item(s) were not processed in this batch — they will not be retried. Re-run the command to catch them.\n", unprocessed)
		}

		fmt.Printf("  Deleted items %d–%d (%d total)\n", i+1, i+processed, deleted)
	}

	return deleted, nil
}

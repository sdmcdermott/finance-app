// Package db provides DynamoDB helpers and shared data models.
//
// Single-table design key schema:
//
//	PK                    SK                              Entity
//	USER#<userId>         ACCOUNT#<accountId>             Account
//	USER#<userId>         CATEGORY#<categoryId>           Category
//	USER#<userId>         RULE#<ruleId>                   Rule
//	USER#<userId>         BUDGET#<budgetId>               Budget
//	BUDGET#<budgetId>     PERIOD#<startDate>              BudgetPeriod
//	ACCOUNT#<accountId>   TXN#<date>#<txnId>              Transaction
//	ACCOUNT#<accountId>   SPLIT#<date>#<txnId>#<splitId>  TransactionSplit
package db

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// ── Key helpers ───────────────────────────────────────────────────────────────

func userPK(userID string) string         { return "USER#" + userID }
func accountSK(accountID string) string   { return "ACCOUNT#" + accountID }
func categorySK(categoryID string) string { return "CATEGORY#" + categoryID }
func ruleSK(ruleID string) string         { return "RULE#" + ruleID }
func budgetSK(budgetID string) string     { return "BUDGET#" + budgetID }
func budgetPK(budgetID string) string     { return "BUDGET#" + budgetID }
func periodSK(startDate string) string    { return "PERIOD#" + startDate }
func accountPK(accountID string) string   { return "ACCOUNT#" + accountID }

// txnSK builds a lexicographically sortable sort key: TXN#<date>#<txnId>
// date must be "YYYY-MM-DD" so range queries work correctly.
func txnSK(date, txnID string) string { return fmt.Sprintf("TXN#%s#%s", date, txnID) }

// splitSK builds the SK for a transaction split item.
// Format: SPLIT#<date>#<txnId>#<splitId>
// Co-located with TXN items under the same PK (ACCOUNT#<accountId>).
func splitSK(date, txnID, splitID string) string {
	return fmt.Sprintf("SPLIT#%s#%s#%s", date, txnID, splitID)
}

// splitPrefix returns the SK prefix used to query all splits for a transaction.
func splitPrefix(date, txnID string) string {
	return fmt.Sprintf("SPLIT#%s#%s#", date, txnID)
}

// ── Models ────────────────────────────────────────────────────────────────────

// Account is a linked bank/card account.
type Account struct {
	PK string `dynamodbav:"pk" json:"-"`
	SK string `dynamodbav:"sk" json:"-"`

	UserID      string    `dynamodbav:"userId"      json:"userId"`
	AccountID   string    `dynamodbav:"accountId"   json:"accountId"`
	AccessToken string    `dynamodbav:"accessToken" json:"-"` // never sent to frontend
	ItemID      string    `dynamodbav:"itemId"      json:"itemId"`
	Institution string    `dynamodbav:"institution" json:"institution"`
	Name        string    `dynamodbav:"name"        json:"name"`
	Type        string    `dynamodbav:"type"        json:"type"`
	Subtype     string    `dynamodbav:"subtype"     json:"subtype"`
	SyncCursor  string    `dynamodbav:"syncCursor"  json:"syncCursor"`
	LastSynced  time.Time `dynamodbav:"lastSynced"  json:"lastSynced"`
}

// Category is a user-defined spending category (no longer carries a budget).
type Category struct {
	PK string `dynamodbav:"pk" json:"-"`
	SK string `dynamodbav:"sk" json:"-"`

	UserID     string `dynamodbav:"userId"     json:"userId"`
	CategoryID string `dynamodbav:"categoryId" json:"categoryId"`
	Name       string `dynamodbav:"name"       json:"name"`
	Color      string `dynamodbav:"color"      json:"color"`
}

// Transaction is a single financial transaction.
type Transaction struct {
	PK string `dynamodbav:"pk" json:"-"`
	SK string `dynamodbav:"sk" json:"-"`

	AccountID         string  `dynamodbav:"accountId"         json:"accountId"`
	DateTransactionID string  `dynamodbav:"dateTransactionId" json:"dateTransactionId"`
	TransactionID     string  `dynamodbav:"transactionId"     json:"transactionId"`
	Date              string  `dynamodbav:"date"              json:"date"`
	Name              string  `dynamodbav:"name"              json:"name"`
	Amount            float64 `dynamodbav:"amount"            json:"amount"`
	Category          string  `dynamodbav:"category"          json:"category"`
	CustomCategory    string  `dynamodbav:"customCategory"    json:"customCategory"`
	Pending           bool    `dynamodbav:"pending"           json:"pending"`
	MerchantName      string  `dynamodbav:"merchantName"      json:"merchantName"`
	ManualCategory    bool    `dynamodbav:"manualCategory"    json:"manualCategory"`
	// BudgetID overrides the category→budget auto-assignment for this transaction.
	BudgetID     string `dynamodbav:"budgetId"     json:"budgetId"`
	ManualBudget bool   `dynamodbav:"manualBudget" json:"manualBudget"`
	// Manual reference link (e.g. Amazon order URL)
	ReferenceURL  string `dynamodbav:"referenceUrl"  json:"referenceUrl"`
	ReferenceNote string `dynamodbav:"referenceNote" json:"referenceNote"`
	// Splits — populated on read, not stored on the transaction item itself.
	Splits []TransactionSplit `dynamodbav:"-" json:"splits,omitempty"`
}

// TransactionSplit represents a portion of a transaction allocated to a specific
// category and/or budget. When splits exist they replace the parent transaction's
// category/budget for spending calculations; amounts must sum ≤ parent amount.
type TransactionSplit struct {
	PK string `dynamodbav:"pk" json:"-"`
	SK string `dynamodbav:"sk" json:"-"`

	AccountID         string  `dynamodbav:"accountId"         json:"accountId"`
	DateTransactionID string  `dynamodbav:"dateTransactionId" json:"dateTransactionId"`
	SplitID           string  `dynamodbav:"splitId"           json:"splitId"`
	Amount            float64 `dynamodbav:"amount"            json:"amount"`
	CustomCategory    string  `dynamodbav:"customCategory"    json:"customCategory"`
	BudgetID          string  `dynamodbav:"budgetId"          json:"budgetId"`
	Note              string  `dynamodbav:"note"              json:"note"`
}

// Budget defines a named budget with a period and optional goal.
//
// Type "goal"      — tracks debits against a goal amount.
// Type "checkbook" — tracks debits and credits, reports running balance.
type Budget struct {
	PK string `dynamodbav:"pk" json:"-"`
	SK string `dynamodbav:"sk" json:"-"`

	UserID     string `dynamodbav:"userId"    json:"userId"`
	BudgetID   string `dynamodbav:"budgetId"  json:"budgetId"`
	Name       string `dynamodbav:"name"      json:"name"`
	BudgetType string `dynamodbav:"budgetType" json:"budgetType"` // "goal" | "checkbook"

	// Period config
	Period       string `dynamodbav:"period"       json:"period"`       // daily|weekly|biweekly|monthly|quarterly|annually
	PeriodFormat string `dynamodbav:"periodFormat" json:"periodFormat"` // user-configured label template

	// Category linkage — transactions whose customCategory is in this list
	// contribute to the budget. The frontend also allows per-transaction override.
	CategoryIDs []string `dynamodbav:"categoryIds" json:"categoryIds"`

	// Goal-type fields
	GoalAmount    float64 `dynamodbav:"goalAmount"    json:"goalAmount"`
	GoalDirection string  `dynamodbav:"goalDirection" json:"goalDirection"` // "limit" | "target"

	// Surplus/shortfall handling
	SurplusHandling  string  `dynamodbav:"surplusHandling"  json:"surplusHandling"`  // "ignore"|"rollover"|"transfer"
	TransferBudgetID string  `dynamodbav:"transferBudgetId" json:"transferBudgetId"` // dest budget (checkbook only)
	TransferAmount   float64 `dynamodbav:"transferAmount"   json:"transferAmount"`   // 0 = full delta

	// Checkbook-type fields
	OpeningBalance float64 `dynamodbav:"openingBalance" json:"openingBalance"`
}

// BudgetPeriod is one period instance of a Budget.
// Spending totals are computed on-the-fly; only metadata is stored here.
type BudgetPeriod struct {
	PK string `dynamodbav:"pk" json:"-"`
	SK string `dynamodbav:"sk" json:"-"`

	PeriodID  string `dynamodbav:"periodId"  json:"periodId"`
	BudgetID  string `dynamodbav:"budgetId"  json:"budgetId"`
	StartDate string `dynamodbav:"startDate" json:"startDate"` // YYYY-MM-DD
	EndDate   string `dynamodbav:"endDate"   json:"endDate"`   // YYYY-MM-DD
	Label     string `dynamodbav:"label"     json:"label"`     // auto-generated display name

	RolledOverAmount float64 `dynamodbav:"rolledOverAmount" json:"rolledOverAmount"`
	TransferredOut   float64 `dynamodbav:"transferredOut"   json:"transferredOut"`
	Closed           bool    `dynamodbav:"closed"           json:"closed"`
}

// ── Client ────────────────────────────────────────────────────────────────────

type Client struct {
	ddb   *dynamodb.Client
	table string
}

func New(ctx context.Context) (*Client, error) {
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, err
	}
	return &Client{
		ddb:   dynamodb.NewFromConfig(cfg),
		table: os.Getenv("DYNAMODB_TABLE"),
	}, nil
}

// ── Accounts ──────────────────────────────────────────────────────────────────

func (c *Client) PutAccount(ctx context.Context, a Account) error {
	a.PK = userPK(a.UserID)
	a.SK = accountSK(a.AccountID)
	item, err := attributevalue.MarshalMap(a)
	if err != nil {
		return err
	}
	_, err = c.ddb.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: &c.table,
		Item:      item,
	})
	return err
}

func (c *Client) GetAccounts(ctx context.Context, userID string) ([]Account, error) {
	out, err := c.ddb.Query(ctx, &dynamodb.QueryInput{
		TableName:              &c.table,
		KeyConditionExpression: aws.String("pk = :pk AND begins_with(sk, :prefix)"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk":     &types.AttributeValueMemberS{Value: userPK(userID)},
			":prefix": &types.AttributeValueMemberS{Value: "ACCOUNT#"},
		},
	})
	if err != nil {
		return nil, err
	}
	var accounts []Account
	return accounts, attributevalue.UnmarshalListOfMaps(out.Items, &accounts)
}

func (c *Client) UpdateSyncCursor(ctx context.Context, userID, accountID, cursor string) error {
	_, err := c.ddb.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: &c.table,
		Key: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: userPK(userID)},
			"sk": &types.AttributeValueMemberS{Value: accountSK(accountID)},
		},
		UpdateExpression: aws.String("SET syncCursor = :cursor, lastSynced = :ts"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":cursor": &types.AttributeValueMemberS{Value: cursor},
			":ts":     &types.AttributeValueMemberS{Value: time.Now().UTC().Format(time.RFC3339)},
		},
	})
	return err
}

// ── Transactions ──────────────────────────────────────────────────────────────

func (c *Client) PutTransactions(ctx context.Context, txns []Transaction) error {
	const batchSize = 25
	for i := 0; i < len(txns); i += batchSize {
		end := i + batchSize
		if end > len(txns) {
			end = len(txns)
		}
		var reqs []types.WriteRequest
		for _, txn := range txns[i:end] {
			txn.PK = accountPK(txn.AccountID)
			txn.SK = txnSK(txn.Date, txn.TransactionID)
			item, err := attributevalue.MarshalMap(txn)
			if err != nil {
				return err
			}
			reqs = append(reqs, types.WriteRequest{PutRequest: &types.PutRequest{Item: item}})
		}
		if _, err := c.ddb.BatchWriteItem(ctx, &dynamodb.BatchWriteItemInput{
			RequestItems: map[string][]types.WriteRequest{c.table: reqs},
		}); err != nil {
			return err
		}
	}
	return nil
}

func (c *Client) DeleteTransactions(ctx context.Context, accountID string, txnKeys []struct{ Date, TxnID string }) error {
	const batchSize = 25
	for i := 0; i < len(txnKeys); i += batchSize {
		end := i + batchSize
		if end > len(txnKeys) {
			end = len(txnKeys)
		}
		var reqs []types.WriteRequest
		for _, k := range txnKeys[i:end] {
			reqs = append(reqs, types.WriteRequest{
				DeleteRequest: &types.DeleteRequest{
					Key: map[string]types.AttributeValue{
						"pk": &types.AttributeValueMemberS{Value: accountPK(accountID)},
						"sk": &types.AttributeValueMemberS{Value: txnSK(k.Date, k.TxnID)},
					},
				},
			})
		}
		if _, err := c.ddb.BatchWriteItem(ctx, &dynamodb.BatchWriteItemInput{
			RequestItems: map[string][]types.WriteRequest{c.table: reqs},
		}); err != nil {
			return err
		}
	}
	return nil
}

// GetTransactions returns transactions for an account between startDate and endDate (YYYY-MM-DD).
func (c *Client) GetTransactions(ctx context.Context, accountID, startDate, endDate string) ([]Transaction, error) {
	out, err := c.ddb.Query(ctx, &dynamodb.QueryInput{
		TableName:              &c.table,
		KeyConditionExpression: aws.String("pk = :pk AND sk BETWEEN :start AND :end"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk":    &types.AttributeValueMemberS{Value: accountPK(accountID)},
			":start": &types.AttributeValueMemberS{Value: txnSK(startDate, "")},
			":end":   &types.AttributeValueMemberS{Value: txnSK(endDate, "~")}, // ~ sorts after all printable chars
		},
		ScanIndexForward: aws.Bool(false), // newest first
	})
	if err != nil {
		return nil, err
	}
	var txns []Transaction
	return txns, attributevalue.UnmarshalListOfMaps(out.Items, &txns)
}

func (c *Client) UpdateTransactionCategory(ctx context.Context, accountID, date, txnID, customCategory string) error {
	_, err := c.ddb.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: &c.table,
		Key: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: accountPK(accountID)},
			"sk": &types.AttributeValueMemberS{Value: txnSK(date, txnID)},
		},
		UpdateExpression: aws.String("SET customCategory = :cat, manualCategory = :manual"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":cat":    &types.AttributeValueMemberS{Value: customCategory},
			":manual": &types.AttributeValueMemberBOOL{Value: true},
		},
	})
	return err
}

func (c *Client) UpdateTransactionBudget(ctx context.Context, accountID, date, txnID, budgetID string) error {
	_, err := c.ddb.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: &c.table,
		Key: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: accountPK(accountID)},
			"sk": &types.AttributeValueMemberS{Value: txnSK(date, txnID)},
		},
		UpdateExpression: aws.String("SET budgetId = :b, manualBudget = :manual"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":b":      &types.AttributeValueMemberS{Value: budgetID},
			":manual": &types.AttributeValueMemberBOOL{Value: true},
		},
	})
	return err
}

func (c *Client) UpdateTransactionReference(ctx context.Context, accountID, date, txnID, referenceURL, referenceNote string) error {
	_, err := c.ddb.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: &c.table,
		Key: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: accountPK(accountID)},
			"sk": &types.AttributeValueMemberS{Value: txnSK(date, txnID)},
		},
		UpdateExpression: aws.String("SET referenceUrl = :url, referenceNote = :note"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":url":  &types.AttributeValueMemberS{Value: referenceURL},
			":note": &types.AttributeValueMemberS{Value: referenceNote},
		},
	})
	return err
}

// ── Transaction Splits ────────────────────────────────────────────────────────

// PutSplits replaces all splits for a transaction atomically using a batch write.
// Pass an empty slice to remove all splits (un-split the transaction).
func (c *Client) PutSplits(ctx context.Context, accountID, dateTransactionID string, splits []TransactionSplit) error {
	// Parse date and txnId from dateTransactionID (format: <date>#<txnId>)
	parts := strings.SplitN(dateTransactionID, "#", 2)
	if len(parts) != 2 {
		return fmt.Errorf("invalid dateTransactionId: %q", dateTransactionID)
	}
	date, txnID := parts[0], parts[1]

	// First delete existing splits for this transaction
	if err := c.DeleteSplits(ctx, accountID, dateTransactionID); err != nil {
		return err
	}

	if len(splits) == 0 {
		return nil
	}

	// Write new splits
	const batchSize = 25
	for i := 0; i < len(splits); i += batchSize {
		end := i + batchSize
		if end > len(splits) {
			end = len(splits)
		}
		var reqs []types.WriteRequest
		for _, sp := range splits[i:end] {
			sp.PK = accountPK(accountID)
			sp.SK = splitSK(date, txnID, sp.SplitID)
			item, err := attributevalue.MarshalMap(sp)
			if err != nil {
				return err
			}
			reqs = append(reqs, types.WriteRequest{PutRequest: &types.PutRequest{Item: item}})
		}
		if _, err := c.ddb.BatchWriteItem(ctx, &dynamodb.BatchWriteItemInput{
			RequestItems: map[string][]types.WriteRequest{c.table: reqs},
		}); err != nil {
			return err
		}
	}
	return nil
}

// GetSplits returns all splits for a given transaction.
func (c *Client) GetSplits(ctx context.Context, accountID, dateTransactionID string) ([]TransactionSplit, error) {
	parts := strings.SplitN(dateTransactionID, "#", 2)
	if len(parts) != 2 {
		return nil, fmt.Errorf("invalid dateTransactionId: %q", dateTransactionID)
	}
	date, txnID := parts[0], parts[1]
	prefix := splitPrefix(date, txnID)

	out, err := c.ddb.Query(ctx, &dynamodb.QueryInput{
		TableName:              &c.table,
		KeyConditionExpression: aws.String("pk = :pk AND begins_with(sk, :prefix)"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk":     &types.AttributeValueMemberS{Value: accountPK(accountID)},
			":prefix": &types.AttributeValueMemberS{Value: prefix},
		},
	})
	if err != nil {
		return nil, err
	}
	var result []TransactionSplit
	return result, attributevalue.UnmarshalListOfMaps(out.Items, &result)
}

// GetSplitsForRange returns all splits for all transactions in an account within
// a date range. Results are keyed by dateTransactionId for efficient lookup.
func (c *Client) GetSplitsForRange(ctx context.Context, accountID, startDate, endDate string) (map[string][]TransactionSplit, error) {
	out, err := c.ddb.Query(ctx, &dynamodb.QueryInput{
		TableName:              &c.table,
		KeyConditionExpression: aws.String("pk = :pk AND sk BETWEEN :start AND :end"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk":    &types.AttributeValueMemberS{Value: accountPK(accountID)},
			":start": &types.AttributeValueMemberS{Value: fmt.Sprintf("SPLIT#%s#", startDate)},
			":end":   &types.AttributeValueMemberS{Value: fmt.Sprintf("SPLIT#%s~", endDate)},
		},
	})
	if err != nil {
		return nil, err
	}
	var splits []TransactionSplit
	if err := attributevalue.UnmarshalListOfMaps(out.Items, &splits); err != nil {
		return nil, err
	}
	result := make(map[string][]TransactionSplit)
	for _, sp := range splits {
		result[sp.DateTransactionID] = append(result[sp.DateTransactionID], sp)
	}
	return result, nil
}

// DeleteSplits removes all split items for a transaction.
func (c *Client) DeleteSplits(ctx context.Context, accountID, dateTransactionID string) error {
	existing, err := c.GetSplits(ctx, accountID, dateTransactionID)
	if err != nil {
		return err
	}
	if len(existing) == 0 {
		return nil
	}
	parts := strings.SplitN(dateTransactionID, "#", 2)
	if len(parts) != 2 {
		return fmt.Errorf("invalid dateTransactionId: %q", dateTransactionID)
	}
	date, txnID := parts[0], parts[1]

	const batchSize = 25
	for i := 0; i < len(existing); i += batchSize {
		end := i + batchSize
		if end > len(existing) {
			end = len(existing)
		}
		var reqs []types.WriteRequest
		for _, sp := range existing[i:end] {
			reqs = append(reqs, types.WriteRequest{
				DeleteRequest: &types.DeleteRequest{
					Key: map[string]types.AttributeValue{
						"pk": &types.AttributeValueMemberS{Value: accountPK(accountID)},
						"sk": &types.AttributeValueMemberS{Value: splitSK(date, txnID, sp.SplitID)},
					},
				},
			})
		}
		if _, err := c.ddb.BatchWriteItem(ctx, &dynamodb.BatchWriteItemInput{
			RequestItems: map[string][]types.WriteRequest{c.table: reqs},
		}); err != nil {
			return err
		}
	}
	return nil
}

// ── Categories ────────────────────────────────────────────────────────────────

func (c *Client) PutCategory(ctx context.Context, cat Category) error {
	cat.PK = userPK(cat.UserID)
	cat.SK = categorySK(cat.CategoryID)
	item, err := attributevalue.MarshalMap(cat)
	if err != nil {
		return err
	}
	_, err = c.ddb.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: &c.table,
		Item:      item,
	})
	return err
}

func (c *Client) GetCategories(ctx context.Context, userID string) ([]Category, error) {
	out, err := c.ddb.Query(ctx, &dynamodb.QueryInput{
		TableName:              &c.table,
		KeyConditionExpression: aws.String("pk = :pk AND begins_with(sk, :prefix)"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk":     &types.AttributeValueMemberS{Value: userPK(userID)},
			":prefix": &types.AttributeValueMemberS{Value: "CATEGORY#"},
		},
	})
	if err != nil {
		return nil, err
	}
	var cats []Category
	return cats, attributevalue.UnmarshalListOfMaps(out.Items, &cats)
}

func (c *Client) DeleteCategory(ctx context.Context, userID, categoryID string) error {
	_, err := c.ddb.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: &c.table,
		Key: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: userPK(userID)},
			"sk": &types.AttributeValueMemberS{Value: categorySK(categoryID)},
		},
	})
	return err
}

// ── Rules ─────────────────────────────────────────────────────────────────────

// Rule auto-assigns a category to transactions whose merchant name contains
// a given substring (case-insensitive). Lower Priority values are applied first.
type Rule struct {
	PK string `dynamodbav:"pk" json:"-"`
	SK string `dynamodbav:"sk" json:"-"`

	UserID     string `dynamodbav:"userId"     json:"userId"`
	RuleID     string `dynamodbav:"ruleId"     json:"ruleId"`
	Pattern    string `dynamodbav:"pattern"    json:"pattern"`
	CategoryID string `dynamodbav:"categoryId" json:"categoryId"`
	Priority   int    `dynamodbav:"priority"   json:"priority"`
}

func (c *Client) PutRule(ctx context.Context, rule Rule) error {
	rule.PK = userPK(rule.UserID)
	rule.SK = ruleSK(rule.RuleID)
	item, err := attributevalue.MarshalMap(rule)
	if err != nil {
		return err
	}
	_, err = c.ddb.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: &c.table,
		Item:      item,
	})
	return err
}

func (c *Client) GetRules(ctx context.Context, userID string) ([]Rule, error) {
	out, err := c.ddb.Query(ctx, &dynamodb.QueryInput{
		TableName:              &c.table,
		KeyConditionExpression: aws.String("pk = :pk AND begins_with(sk, :prefix)"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk":     &types.AttributeValueMemberS{Value: userPK(userID)},
			":prefix": &types.AttributeValueMemberS{Value: "RULE#"},
		},
	})
	if err != nil {
		return nil, err
	}
	var rules []Rule
	return rules, attributevalue.UnmarshalListOfMaps(out.Items, &rules)
}

func (c *Client) DeleteRule(ctx context.Context, userID, ruleID string) error {
	_, err := c.ddb.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: &c.table,
		Key: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: userPK(userID)},
			"sk": &types.AttributeValueMemberS{Value: ruleSK(ruleID)},
		},
	})
	return err
}

// ApplyRulesToTransactions applies rules (sorted by priority asc) to transactions
// that have not been manually categorized and have no splits.
// Returns the updated slice.
func ApplyRulesToTransactions(rules []Rule, txns []Transaction) []Transaction {
	sorted := make([]Rule, len(rules))
	copy(sorted, rules)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Priority < sorted[j].Priority })

	result := make([]Transaction, len(txns))
	copy(result, txns)

	for i, txn := range result {
		if txn.ManualCategory {
			continue
		}
		// Transactions with splits manage their own categories per-split
		if len(txn.Splits) > 0 {
			continue
		}
		merchant := strings.ToLower(txn.MerchantName)
		if merchant == "" {
			merchant = strings.ToLower(txn.Name)
		}
		for _, rule := range sorted {
			if strings.Contains(merchant, strings.ToLower(rule.Pattern)) {
				result[i].CustomCategory = rule.CategoryID
				break
			}
		}
	}
	return result
}

// ── Budgets ───────────────────────────────────────────────────────────────────

func (c *Client) PutBudget(ctx context.Context, b Budget) error {
	b.PK = userPK(b.UserID)
	b.SK = budgetSK(b.BudgetID)
	item, err := attributevalue.MarshalMap(b)
	if err != nil {
		return err
	}
	_, err = c.ddb.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: &c.table,
		Item:      item,
	})
	return err
}

func (c *Client) GetBudgets(ctx context.Context, userID string) ([]Budget, error) {
	out, err := c.ddb.Query(ctx, &dynamodb.QueryInput{
		TableName:              &c.table,
		KeyConditionExpression: aws.String("pk = :pk AND begins_with(sk, :prefix)"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk":     &types.AttributeValueMemberS{Value: userPK(userID)},
			":prefix": &types.AttributeValueMemberS{Value: "BUDGET#"},
		},
	})
	if err != nil {
		return nil, err
	}
	var budgets []Budget
	return budgets, attributevalue.UnmarshalListOfMaps(out.Items, &budgets)
}

func (c *Client) GetBudget(ctx context.Context, userID, budgetID string) (*Budget, error) {
	out, err := c.ddb.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: &c.table,
		Key: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: userPK(userID)},
			"sk": &types.AttributeValueMemberS{Value: budgetSK(budgetID)},
		},
	})
	if err != nil {
		return nil, err
	}
	if out.Item == nil {
		return nil, nil
	}
	var b Budget
	return &b, attributevalue.UnmarshalMap(out.Item, &b)
}

func (c *Client) DeleteBudget(ctx context.Context, userID, budgetID string) error {
	_, err := c.ddb.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: &c.table,
		Key: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: userPK(userID)},
			"sk": &types.AttributeValueMemberS{Value: budgetSK(budgetID)},
		},
	})
	return err
}

// ── Budget Periods ────────────────────────────────────────────────────────────

func (c *Client) PutBudgetPeriod(ctx context.Context, p BudgetPeriod) error {
	p.PK = budgetPK(p.BudgetID)
	p.SK = periodSK(p.StartDate)
	item, err := attributevalue.MarshalMap(p)
	if err != nil {
		return err
	}
	_, err = c.ddb.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: &c.table,
		Item:      item,
	})
	return err
}

// GetBudgetPeriods returns all periods for a budget, newest first.
func (c *Client) GetBudgetPeriods(ctx context.Context, budgetID string) ([]BudgetPeriod, error) {
	out, err := c.ddb.Query(ctx, &dynamodb.QueryInput{
		TableName:              &c.table,
		KeyConditionExpression: aws.String("pk = :pk AND begins_with(sk, :prefix)"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk":     &types.AttributeValueMemberS{Value: budgetPK(budgetID)},
			":prefix": &types.AttributeValueMemberS{Value: "PERIOD#"},
		},
		ScanIndexForward: aws.Bool(false), // newest first
	})
	if err != nil {
		return nil, err
	}
	var periods []BudgetPeriod
	return periods, attributevalue.UnmarshalListOfMaps(out.Items, &periods)
}

// GetBudgetPeriod returns a single period by budgetID + startDate.
func (c *Client) GetBudgetPeriod(ctx context.Context, budgetID, startDate string) (*BudgetPeriod, error) {
	out, err := c.ddb.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: &c.table,
		Key: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: budgetPK(budgetID)},
			"sk": &types.AttributeValueMemberS{Value: periodSK(startDate)},
		},
	})
	if err != nil {
		return nil, err
	}
	if out.Item == nil {
		return nil, nil
	}
	var p BudgetPeriod
	return &p, attributevalue.UnmarshalMap(out.Item, &p)
}

// ── Period label generation ───────────────────────────────────────────────────

// FormatPeriodLabel renders a period label from the budget's PeriodFormat template.
// Supported tokens: {name}, {yyyy}, {yy}, {mon}, {month}, {dd}, {wk}, {q}
// Examples:
//
//	"{name} - {mon} {yyyy}"          → "Monthly Spending - Jan 2026"
//	"{name} - W{wk} {mon} {yyyy}"    → "Weekly Groceries - W3 Jan 2026"
//	"{name} - {mon} {dd} {yyyy}"     → "Daily Coffee - Jan 05 2026"
func FormatPeriodLabel(budgetName, format, startDate string) string {
	t, err := time.Parse("2006-01-02", startDate)
	if err != nil {
		return budgetName + " - " + startDate
	}
	_, week := t.ISOWeek()
	quarter := (int(t.Month())-1)/3 + 1

	r := format
	r = strings.ReplaceAll(r, "{name}", budgetName)
	r = strings.ReplaceAll(r, "{yyyy}", t.Format("2006"))
	r = strings.ReplaceAll(r, "{yy}", t.Format("06"))
	r = strings.ReplaceAll(r, "{mon}", t.Format("Jan"))
	r = strings.ReplaceAll(r, "{month}", t.Format("January"))
	r = strings.ReplaceAll(r, "{dd}", t.Format("02"))
	r = strings.ReplaceAll(r, "{wk}", fmt.Sprintf("%d", week))
	r = strings.ReplaceAll(r, "{q}", fmt.Sprintf("Q%d", quarter))
	return r
}

// PeriodDates returns the start and end dates (YYYY-MM-DD) for the period that
// contains the given reference time, based on the budget's Period setting.
func PeriodDates(period string, ref time.Time) (start, end string) {
	ref = ref.UTC()
	switch period {
	case "daily":
		s := time.Date(ref.Year(), ref.Month(), ref.Day(), 0, 0, 0, 0, time.UTC)
		return s.Format("2006-01-02"), s.Format("2006-01-02")
	case "weekly":
		// Week starts Monday
		weekday := int(ref.Weekday())
		if weekday == 0 {
			weekday = 7
		}
		s := ref.AddDate(0, 0, -(weekday - 1))
		s = time.Date(s.Year(), s.Month(), s.Day(), 0, 0, 0, 0, time.UTC)
		e := s.AddDate(0, 0, 6)
		return s.Format("2006-01-02"), e.Format("2006-01-02")
	case "biweekly":
		weekday := int(ref.Weekday())
		if weekday == 0 {
			weekday = 7
		}
		s := ref.AddDate(0, 0, -(weekday - 1))
		s = time.Date(s.Year(), s.Month(), s.Day(), 0, 0, 0, 0, time.UTC)
		e := s.AddDate(0, 0, 13)
		return s.Format("2006-01-02"), e.Format("2006-01-02")
	case "monthly":
		s := time.Date(ref.Year(), ref.Month(), 1, 0, 0, 0, 0, time.UTC)
		e := time.Date(ref.Year(), ref.Month()+1, 0, 0, 0, 0, 0, time.UTC)
		return s.Format("2006-01-02"), e.Format("2006-01-02")
	case "quarterly":
		q := (int(ref.Month()) - 1) / 3
		startMonth := time.Month(q*3 + 1)
		s := time.Date(ref.Year(), startMonth, 1, 0, 0, 0, 0, time.UTC)
		e := time.Date(ref.Year(), startMonth+3, 0, 0, 0, 0, 0, time.UTC)
		return s.Format("2006-01-02"), e.Format("2006-01-02")
	case "annually":
		s := time.Date(ref.Year(), 1, 1, 0, 0, 0, 0, time.UTC)
		e := time.Date(ref.Year(), 12, 31, 0, 0, 0, 0, time.UTC)
		return s.Format("2006-01-02"), e.Format("2006-01-02")
	default:
		// fallback: monthly
		s := time.Date(ref.Year(), ref.Month(), 1, 0, 0, 0, 0, time.UTC)
		e := time.Date(ref.Year(), ref.Month()+1, 0, 0, 0, 0, 0, time.UTC)
		return s.Format("2006-01-02"), e.Format("2006-01-02")
	}
}

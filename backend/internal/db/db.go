// Package db provides DynamoDB helpers and shared data models.
//
// Single-table design key schema:
//
//	PK                    SK                              Entity
//	USER#<userId>         ACCOUNT#<accountId>             Account
//	USER#<userId>         ITEM#<itemId>                   PlaidItem
//	USER#<userId>         CATEGORY#<categoryId>           Category
//	USER#<userId>         RULE#<ruleId>                   Rule
//	USER#<userId>         INCOME#<incomeSourceId>         IncomeSource
//	USER#<userId>         BUDGET#<budgetId>               Budget
//	USER#<userId>         MASTERBUDGET                    MasterBudget
//	BUDGET#<budgetId>     PERIOD#<startDate>              BudgetPeriod
//	ACCOUNT#<accountId>   TXN#<date>#<txnId>              Transaction
//	ACCOUNT#<accountId>   SPLIT#<date>#<txnId>#<splitId>  TransactionSplit
package db

import (
	"context"
	"fmt"
	"math"
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
func itemSK(itemID string) string         { return "ITEM#" + itemID }
func categorySK(categoryID string) string { return "CATEGORY#" + categoryID }
func ruleSK(ruleID string) string         { return "RULE#" + ruleID }
func budgetSK(budgetID string) string        { return "BUDGET#" + budgetID }
func budgetPK(budgetID string) string        { return "BUDGET#" + budgetID }
func periodSK(startDate string) string       { return "PERIOD#" + startDate }
func accountPK(accountID string) string      { return "ACCOUNT#" + accountID }
func incomeSourceSK(sourceID string) string  { return "INCOME#" + sourceID }

// masterBudgetLegacySK is the SK for the pre-versioning singleton master budget record.
// New versioned records use masterBudgetVersionSK(effectiveDate) instead.
const masterBudgetLegacySK = "MASTERBUDGET"

// masterBudgetVersionSK returns the SK for a versioned master budget record.
// effectiveDate must be a YYYY-MM-DD string.
func masterBudgetVersionSK(effectiveDate string) string { return "MASTERBUDGET#" + effectiveDate }

// masterBudgetSKPrefix is used for begins_with queries that catch both legacy
// and versioned master budget items in a single Query call.
const masterBudgetSKPrefix = "MASTERBUDGET"

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
	ItemID      string    `dynamodbav:"itemId"      json:"itemId"`
	Institution string    `dynamodbav:"institution" json:"institution"`
	Name        string    `dynamodbav:"name"        json:"name"`
	Type        string    `dynamodbav:"type"        json:"type"`
	Subtype     string    `dynamodbav:"subtype"     json:"subtype"`
	SyncCursor  string    `dynamodbav:"syncCursor"  json:"syncCursor"`
	LastSynced  time.Time `dynamodbav:"lastSynced"  json:"lastSynced"`
	// Enabled: false means skip this account during transaction sync and filter its txns from results.
	// Defaults to true for new accounts; omitempty means absence == true in legacy records.
	Enabled     *bool     `dynamodbav:"enabled,omitempty" json:"enabled"`
}

// PlaidItem holds the Plaid access token for a linked institution.
// Stored separately from Account so that deleting an account never loses the token.
// One item can have multiple accounts (e.g. checking + mortgage at the same bank).
type PlaidItem struct {
	PK string `dynamodbav:"pk" json:"-"`
	SK string `dynamodbav:"sk" json:"-"`

	UserID      string `dynamodbav:"userId"      json:"userId"`
	ItemID      string `dynamodbav:"itemId"      json:"itemId"`
	AccessToken string `dynamodbav:"accessToken" json:"-"` // never sent to frontend
	Institution string `dynamodbav:"institution" json:"institution"`
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
	// Extra fields sourced from Plaid at sync time
	OriginalDescription      string `dynamodbav:"originalDescription"      json:"originalDescription,omitempty"`
	AuthorizedDate           string `dynamodbav:"authorizedDate"           json:"authorizedDate,omitempty"`
	PaymentChannel           string `dynamodbav:"paymentChannel"           json:"paymentChannel,omitempty"`
	PersonalFinancePrimary   string `dynamodbav:"personalFinancePrimary"   json:"personalFinancePrimary,omitempty"`
	PersonalFinanceDetailed  string `dynamodbav:"personalFinanceDetailed"  json:"personalFinanceDetailed,omitempty"`
	LogoURL                  string `dynamodbav:"logoUrl"                  json:"logoUrl,omitempty"`
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

	// Goal-type fields
	GoalAmount          float64 `dynamodbav:"goalAmount"          json:"goalAmount"`
	GoalDirection       string  `dynamodbav:"goalDirection"       json:"goalDirection"`       // "limit" | "target"
	// MasterBudgetAmount: the portion of GoalAmount set by the master budget link.
	// GoalAmount = MasterBudgetAmount + any user-specified additional amount.
	// Zero/absent means this budget is not linked to a master budget bucket.
	MasterBudgetAmount  float64 `dynamodbav:"masterBudgetAmount,omitempty" json:"masterBudgetAmount,omitempty"`

	// Surplus/shortfall handling
	SurplusHandling  string  `dynamodbav:"surplusHandling"  json:"surplusHandling"`  // "ignore"|"rollover"|"transfer"
	TransferBudgetID string  `dynamodbav:"transferBudgetId" json:"transferBudgetId"` // dest budget (checkbook only)
	TransferAmount   float64 `dynamodbav:"transferAmount"   json:"transferAmount"`   // 0 = full delta

	// Checkbook-type fields
	OpeningBalance float64 `dynamodbav:"openingBalance" json:"openingBalance"`
}

// ── Master Budget ──────────────────────────────────────────────────────────────

// MBIncomeSource is a reference to an IncomeSource used as income input.
// The user can override the effective monthly amount or disable the source.
type MBIncomeSource struct {
	IncomeSourceID  string  `dynamodbav:"incomeSourceId"             json:"incomeSourceId"`
	MonthlyOverride float64 `dynamodbav:"monthlyOverride"            json:"monthlyOverride"`
	Enabled         bool    `dynamodbav:"enabled"                   json:"enabled"`
	LinkedBudgetID  string  `dynamodbav:"linkedBudgetId,omitempty"  json:"linkedBudgetId,omitempty"`
	// IncomeRuleID: points to a Rule record used to match paycheck deposit transactions.
	IncomeRuleID   string  `dynamodbav:"incomeRuleId,omitempty"    json:"incomeRuleId,omitempty"`
}

// MBFixedCost is a recurring expense deducted before discretionary allocation.
type MBFixedCost struct {
	ID        string  `dynamodbav:"id"        json:"id"`
	Name      string  `dynamodbav:"name"      json:"name"`
	Amount    float64 `dynamodbav:"amount"    json:"amount"`
	// Frequency mirrors IncomeSource.Frequency
	Frequency string  `dynamodbav:"frequency" json:"frequency"`
	// RuleID: if non-empty, this cost was created from a suggested rule
	RuleID    string  `dynamodbav:"ruleId,omitempty" json:"ruleId,omitempty"`
	// FromTxn: if true, this cost was manually assigned via budgetId=MASTER_BUDGET_ID on a transaction
	FromTxn   bool    `dynamodbav:"fromTxn,omitempty" json:"fromTxn,omitempty"`
	// LinkedBudgetID: optional checkbook budget that tracks actual spend vs. this expected amount
	LinkedBudgetID string `dynamodbav:"linkedBudgetId,omitempty" json:"linkedBudgetId,omitempty"`
}

// MBBucket is a discretionary spending allocation linked optionally to a Budget.
// Exactly one of AmountMonthly or Percent should be non-zero (except when AmountType is "remaining").
type MBBucket struct {
	ID            string  `dynamodbav:"id"            json:"id"`
	Name          string  `dynamodbav:"name"          json:"name"`
	// AmountMonthly: fixed monthly dollar amount (0 = use Percent instead)
	AmountMonthly float64 `dynamodbav:"amountMonthly" json:"amountMonthly"`
	// Percent: fraction of discretionary remainder (0.0–1.0, 0 = use AmountMonthly)
	Percent       float64 `dynamodbav:"percent"       json:"percent"`
	// AmountType: explicit allocation mode — "fixed", "percent", or "remaining".
	// "remaining" means this bucket receives whatever discretionary income is left after all other buckets.
	// If empty, infer from Percent (> 0 → "percent", else → "fixed") for backwards compatibility.
	AmountType    string  `dynamodbav:"amountType,omitempty"    json:"amountType,omitempty"`
	// LinkedBudgetID: optional budget to push this allocation to
	LinkedBudgetID string `dynamodbav:"linkedBudgetId,omitempty" json:"linkedBudgetId,omitempty"`
	// LinkType: "goal" (set goalAmount) or "credit" (set openingBalance / transfer credit)
	LinkType      string  `dynamodbav:"linkType,omitempty"      json:"linkType,omitempty"`
}

// MasterBudget is a singleton per user that models total monthly cash flow.
type MasterBudget struct {
	PK string `dynamodbav:"pk" json:"-"`
	SK string `dynamodbav:"sk" json:"-"`

	UserID        string           `dynamodbav:"userId"        json:"userId"`
	// EffectiveDate is the first day this version of the master budget applies (YYYY-MM-DD).
	// Empty means this is the legacy pre-versioning singleton (treated as the oldest version).
	EffectiveDate string           `dynamodbav:"effectiveDate,omitempty" json:"effectiveDate,omitempty"`
	// Label is an optional user-supplied name for the version, e.g. "2026 salary increase".
	Label         string           `dynamodbav:"label,omitempty"         json:"label,omitempty"`
	IncomeSources []MBIncomeSource `dynamodbav:"incomeSources"           json:"incomeSources"`
	FixedCosts    []MBFixedCost    `dynamodbav:"fixedCosts"              json:"fixedCosts"`
	Buckets       []MBBucket       `dynamodbav:"buckets"                 json:"buckets"`
}

// ── Master Budget CRUD ─────────────────────────────────────────────────────────

// GetMasterBudgets returns all master budget versions for a user, sorted by
// EffectiveDate ascending (the legacy pre-versioning item, if present, sorts
// first because its EffectiveDate is empty and "" < any date string).
func (c *Client) GetMasterBudgets(ctx context.Context, userID string) ([]MasterBudget, error) {
	out, err := c.ddb.Query(ctx, &dynamodb.QueryInput{
		TableName:              aws.String(c.table),
		KeyConditionExpression: aws.String("pk = :pk AND begins_with(sk, :prefix)"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk":     &types.AttributeValueMemberS{Value: userPK(userID)},
			":prefix": &types.AttributeValueMemberS{Value: masterBudgetSKPrefix},
		},
		ScanIndexForward: aws.Bool(true), // SK ascending = effectiveDate ascending
	})
	if err != nil {
		return nil, err
	}
	var versions []MasterBudget
	if err := attributevalue.UnmarshalListOfMaps(out.Items, &versions); err != nil {
		return nil, err
	}
	// Normalise nil slices to empty so callers can range without nil checks.
	for i := range versions {
		if versions[i].IncomeSources == nil { versions[i].IncomeSources = []MBIncomeSource{} }
		if versions[i].FixedCosts    == nil { versions[i].FixedCosts    = []MBFixedCost{} }
		if versions[i].Buckets       == nil { versions[i].Buckets       = []MBBucket{} }
	}
	return versions, nil
}

// GetEffectiveMasterBudget returns the master budget version whose EffectiveDate
// is the latest one that is <= the given date string (YYYY-MM-DD).
// The legacy pre-versioning item (EffectiveDate == "") always qualifies as "before
// any real date", so it is used as a fallback when no dated version exists.
// Returns nil, nil when there are no master budget records at all.
func (c *Client) GetEffectiveMasterBudget(ctx context.Context, userID, date string) (*MasterBudget, error) {
	versions, err := c.GetMasterBudgets(ctx, userID)
	if err != nil {
		return nil, err
	}
	if len(versions) == 0 {
		return nil, nil
	}
	// Versions are already sorted ascending.  Walk forward, keeping the last
	// one whose EffectiveDate <= date.  Empty EffectiveDate ("") sorts before
	// any real date string lexicographically, so it is always a candidate.
	var best *MasterBudget
	for i := range versions {
		ed := versions[i].EffectiveDate
		if ed == "" || ed <= date {
			best = &versions[i]
		}
	}
	if best == nil {
		// All versions have EffectiveDate > date; return the earliest as fallback.
		best = &versions[0]
	}
	return best, nil
}

// PutMasterBudget writes a master budget version.
// If mb.EffectiveDate is non-empty the record is stored under the versioned SK
// "MASTERBUDGET#<effectiveDate>"; otherwise the legacy SK "MASTERBUDGET" is used.
func (c *Client) PutMasterBudget(ctx context.Context, mb MasterBudget) error {
	mb.PK = userPK(mb.UserID)
	if mb.EffectiveDate != "" {
		mb.SK = masterBudgetVersionSK(mb.EffectiveDate)
	} else {
		mb.SK = masterBudgetLegacySK
	}
	item, err := attributevalue.MarshalMap(mb)
	if err != nil {
		return err
	}
	_, err = c.ddb.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: &c.table,
		Item:      item,
	})
	return err
}

// DeleteLegacyMasterBudget removes the pre-versioning singleton master budget
// item (SK = "MASTERBUDGET") if it exists.  Called after successfully writing a
// versioned item so the legacy entry no longer appears alongside dated versions.
func (c *Client) DeleteLegacyMasterBudget(ctx context.Context, userID string) error {
	_, err := c.ddb.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(c.table),
		Key: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: userPK(userID)},
			"sk": &types.AttributeValueMemberS{Value: masterBudgetLegacySK},
		},
	})
	return err
}

// DeleteMasterBudgetVersion removes a specific versioned master budget item.
// Used when the user renames a version's effective date.
func (c *Client) DeleteMasterBudgetVersion(ctx context.Context, userID, effectiveDate string) error {
	_, err := c.ddb.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(c.table),
		Key: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: userPK(userID)},
			"sk": &types.AttributeValueMemberS{Value: masterBudgetVersionSK(effectiveDate)},
		},
	})
	return err
}
type DeductionItem struct {
	Name   string  `dynamodbav:"name"   json:"name"`
	Amount float64 `dynamodbav:"amount" json:"amount"`
}

// IncomeSource represents a recurring paycheck or income stream.
//
// FilingStatus: single | married_jointly | married_separately | head_of_household
// Frequency:    weekly | biweekly | semimonthly | monthly
type IncomeSource struct {
	PK string `dynamodbav:"pk" json:"-"`
	SK string `dynamodbav:"sk" json:"-"`

	UserID         string  `dynamodbav:"userId"         json:"userId"`
	IncomeSourceID string  `dynamodbav:"incomeSourceId" json:"incomeSourceId"`
	Name           string  `dynamodbav:"name"           json:"name"`
	Frequency      string  `dynamodbav:"frequency"      json:"frequency"`
	GrossAmount    float64 `dynamodbav:"grossAmount"    json:"grossAmount"`
	FilingStatus   string  `dynamodbav:"filingStatus"   json:"filingStatus"`
	WorkState      string  `dynamodbav:"workState"      json:"workState"`
	// Pre-tax deductions per period — split by tax treatment:
	// Section125Deductions (cafeteria plan): health/dental/vision, HSA, FSA —
	//   reduce both FICA (SS + Medicare) and income tax.
	// RetirementDeductions (401k/403b/457 traditional): reduce income tax only,
	//   not FICA.
	// PreTaxDeductions is kept for backward compatibility; when both new fields
	// are zero and PreTaxDeductions is non-zero, it is treated as Section 125.
	Section125Deductions  float64         `dynamodbav:"section125Deductions"  json:"section125Deductions"`
	Section125Items       []DeductionItem `dynamodbav:"section125Items,omitempty" json:"section125Items,omitempty"`
	RetirementDeductions  float64         `dynamodbav:"retirementDeductions"  json:"retirementDeductions"`
	RetirementItems       []DeductionItem `dynamodbav:"retirementItems,omitempty" json:"retirementItems,omitempty"`
	PreTaxDeductions      float64 `dynamodbav:"preTaxDeductions"      json:"preTaxDeductions"` // legacy
	// Flat additional federal withholding per period (W-4 line 4c)
	AdditionalWithholding float64 `dynamodbav:"additionalWithholding" json:"additionalWithholding"`
	// DeductionType: "standard" | "itemized"
	DeductionType      string          `dynamodbav:"deductionType"      json:"deductionType"`
	// ItemizedDeductions is the annual total when DeductionType is "itemized"
	ItemizedDeductions      float64         `dynamodbav:"itemizedDeductions"      json:"itemizedDeductions"`
	ItemizedDeductionItems  []DeductionItem `dynamodbav:"itemizedDeductionItems,omitempty" json:"itemizedDeductionItems,omitempty"`
	// W-4 Step 3: total dependent/child tax credits (annual dollar amount)
	Step3Credits       float64 `dynamodbav:"step3Credits"       json:"step3Credits"`
	// W-4 Step 4a: other annual income not from jobs (interest, dividends, etc.)
	Step4aOtherIncome  float64         `dynamodbav:"step4aOtherIncome"  json:"step4aOtherIncome"`
	Step4aItems        []DeductionItem `dynamodbav:"step4aItems,omitempty" json:"step4aItems,omitempty"`
	// W-4 Step 4b: additional annual deductions (student loan, IRA, etc.)
	Step4bDeductions   float64         `dynamodbav:"step4bDeductions"   json:"step4bDeductions"`
	Step4bItems        []DeductionItem `dynamodbav:"step4bItems,omitempty" json:"step4bItems,omitempty"`
	IsActive             bool    `dynamodbav:"isActive"             json:"isActive"`
	// LastNetPay is the most recently computed net pay breakdown. Stored so it
	// survives page reloads without requiring another payrolltax API call.
	LastNetPay *NetPayResult `dynamodbav:"lastNetPay,omitempty" json:"lastNetPay,omitempty"`
}

// NetPayResult mirrors payrolltax.NetPayResult for storage on IncomeSource.
type NetPayResult struct {
	GrossAmount           float64            `dynamodbav:"grossAmount"           json:"grossAmount"`
	Section125Deductions  float64            `dynamodbav:"section125Deductions"  json:"section125Deductions"`
	RetirementDeductions  float64            `dynamodbav:"retirementDeductions"  json:"retirementDeductions"`
	FicaTaxableWages      float64            `dynamodbav:"ficaTaxableWages"      json:"ficaTaxableWages"`
	IncomeTaxableWages    float64            `dynamodbav:"incomeTaxableWages"    json:"incomeTaxableWages"`
	DeductionUsed         float64            `dynamodbav:"deductionUsed"         json:"deductionUsed"`
	DeductionWarning      string             `dynamodbav:"deductionWarning,omitempty" json:"deductionWarning,omitempty"`
	Step4aOtherIncome     float64            `dynamodbav:"step4aOtherIncome,omitempty" json:"step4aOtherIncome,omitempty"`
	Step4bDeductions      float64            `dynamodbav:"step4bDeductions,omitempty" json:"step4bDeductions,omitempty"`
	Step3Credits          float64            `dynamodbav:"step3Credits,omitempty" json:"step3Credits,omitempty"`
	Withholdings          map[string]float64 `dynamodbav:"withholdings"          json:"withholdings"`
	TotalWithheld         float64            `dynamodbav:"totalWithheld"         json:"totalWithheld"`
	AdditionalWithholding float64            `dynamodbav:"additionalWithholding" json:"additionalWithholding"`
	NetPay                float64            `dynamodbav:"netPay"                json:"netPay"`
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
	// StaleWarning is set when a late-arriving transaction was written into this
	// closed period but it is not the most-recent closed period (which is
	// auto-re-closed on sync). The user should manually re-close it.
	StaleWarning bool `dynamodbav:"staleWarning,omitempty" json:"staleWarning,omitempty"`
	// MasterBudgetGoal, when non-zero, overrides Budget.GoalAmount as the goal
	// for this specific period.  Set by master budget version propagation so that
	// each period reflects the master budget that was in effect on its start date.
	MasterBudgetGoal float64 `dynamodbav:"masterBudgetGoal,omitempty" json:"masterBudgetGoal,omitempty"`
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

	var opts []func(*dynamodb.Options)
	if endpoint := os.Getenv("DYNAMODB_ENDPOINT"); endpoint != "" {
		opts = append(opts, func(o *dynamodb.Options) {
			o.BaseEndpoint = aws.String(endpoint)
		})
	}

	return &Client{
		ddb:   dynamodb.NewFromConfig(cfg, opts...),
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

func (c *Client) DeleteAccount(ctx context.Context, userID, accountID string) error {
	_, err := c.ddb.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: &c.table,
		Key: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: userPK(userID)},
			"sk": &types.AttributeValueMemberS{Value: accountSK(accountID)},
		},
	})
	return err
}

// AccountEnabled returns true if the account is enabled (nil means enabled by default).
func AccountEnabled(a Account) bool {
	return a.Enabled == nil || *a.Enabled
}

// UpdateAccountEnabled sets the enabled flag on an account record.
func (c *Client) UpdateAccountEnabled(ctx context.Context, userID, accountID string, enabled bool) error {
	_, err := c.ddb.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: &c.table,
		Key: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: userPK(userID)},
			"sk": &types.AttributeValueMemberS{Value: accountSK(accountID)},
		},
		UpdateExpression: aws.String("SET enabled = :enabled"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":enabled": &types.AttributeValueMemberBOOL{Value: enabled},
		},
	})
	return err
}

// PutPlaidItem upserts a PlaidItem (access token + institution) keyed by itemId.
func (c *Client) PutPlaidItem(ctx context.Context, item PlaidItem) error {
	item.PK = userPK(item.UserID)
	item.SK = itemSK(item.ItemID)
	av, err := attributevalue.MarshalMap(item)
	if err != nil {
		return err
	}
	_, err = c.ddb.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: &c.table,
		Item:      av,
	})
	return err
}

// GetPlaidItem fetches a single PlaidItem by itemId.
func (c *Client) GetPlaidItem(ctx context.Context, userID, itemID string) (*PlaidItem, error) {
	out, err := c.ddb.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: &c.table,
		Key: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: userPK(userID)},
			"sk": &types.AttributeValueMemberS{Value: itemSK(itemID)},
		},
	})
	if err != nil {
		return nil, err
	}
	if out.Item == nil {
		return nil, fmt.Errorf("plaid item %s not found", itemID)
	}
	var pi PlaidItem
	if err := attributevalue.UnmarshalMap(out.Item, &pi); err != nil {
		return nil, err
	}
	return &pi, nil
}

// GetPlaidItems returns all PlaidItem records for a user.
func (c *Client) GetPlaidItems(ctx context.Context, userID string) ([]PlaidItem, error) {
	out, err := c.ddb.Query(ctx, &dynamodb.QueryInput{
		TableName:              &c.table,
		KeyConditionExpression: aws.String("pk = :pk AND begins_with(sk, :prefix)"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk":     &types.AttributeValueMemberS{Value: userPK(userID)},
			":prefix": &types.AttributeValueMemberS{Value: "ITEM#"},
		},
	})
	if err != nil {
		return nil, err
	}
	var items []PlaidItem
	if err := attributevalue.UnmarshalListOfMaps(out.Items, &items); err != nil {
		return nil, err
	}
	return items, nil
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

// DeleteTransaction removes a single transaction by accountId, date, and txnId.
func (c *Client) DeleteTransaction(ctx context.Context, accountID, date, txnID string) error {
	return c.DeleteTransactions(ctx, accountID, []struct{ Date, TxnID string }{{date, txnID}})
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

// ── Suggest Fixed Costs ────────────────────────────────────────────────────────

const MasterBudgetID = "__master_budget__"

// IncomeBudgetPrefix is prepended to an incomeSourceId to form the budgetId
// stored on transactions matched by an income rule.
// Full value: "__income__<incomeSourceId>"
const IncomeBudgetPrefix = "__income__"

// BuiltinIncomeCategoryID is the fixed category ID for paycheck/income deposits.
// It is never stored in DynamoDB — it is injected by get-categories at query time.
const BuiltinIncomeCategoryID = "__builtin_income__"

// SuggestFixedCost is a candidate recurring cost derived from transaction history.
type SuggestFixedCost struct {
	Merchant    string   `json:"merchant"`
	MeanDay     int      `json:"meanDay"`     // mean day-of-month
	MeanAmount  float64  `json:"meanAmount"`  // mean absolute amount
	Frequency   string   `json:"frequency"`   // weekly/biweekly/semimonthly/monthly/quarterly/annually
	Confidence  string   `json:"confidence"`  // "high" | "low"
	Occurrences int      `json:"occurrences"` // how many times seen in window
	SampleDates []string `json:"sampleDates"` // up to 6 sample dates (YYYY-MM-DD)
}

// SuggestFixedCostsResult bundles suggestions with metadata about the data window.
type SuggestFixedCostsResult struct {
	Suggestions    []SuggestFixedCost `json:"suggestions"`
	OldestDate     string             `json:"oldestDate"`     // YYYY-MM-DD of oldest transaction found
	MonthsCovered  float64            `json:"monthsCovered"`  // actual span in months
	FullWindow     bool               `json:"fullWindow"`     // true if >= 5.5 months available
}

// SuggestFixedCosts scans the past 6 months of transactions across all accounts,
// clusters by merchant name + approximate day-of-month (±1) and amount (±$5),
// and returns candidates that appear at least twice. Transactions that already
// have a category, budget, or budgetId==MASTER_BUDGET_ID are excluded.
func (c *Client) SuggestFixedCosts(ctx context.Context, userID string) (*SuggestFixedCostsResult, error) {
	accounts, err := c.GetAccounts(ctx, userID)
	if err != nil {
		return nil, err
	}

	end := time.Now()
	start := end.AddDate(0, -6, 0)
	startStr := start.Format("2006-01-02")
	endStr := end.Format("2006-01-02")

	var allTxns []Transaction
	for _, acct := range accounts {
		txns, err := c.GetTransactions(ctx, acct.AccountID, startStr, endStr)
		if err != nil {
			return nil, err
		}
		allTxns = append(allTxns, txns...)
	}

	// Determine actual data window from oldest transaction date found
	oldestDate := endStr
	for _, t := range allTxns {
		if t.Date < oldestDate {
			oldestDate = t.Date
		}
	}
	oldest, _ := time.Parse("2006-01-02", oldestDate)
	monthsCovered := end.Sub(oldest).Hours() / 24 / 30.44
	if monthsCovered > 6 {
		monthsCovered = 6
	}
	fullWindow := monthsCovered >= 5.5

	// Filter: skip already-categorized, already-budgeted, or master-budget-assigned
	var candidates []Transaction
	for _, t := range allTxns {
		if t.CustomCategory != "" || t.BudgetID != "" {
			continue
		}
		if t.Amount <= 0 { // credits/refunds
			continue
		}
		candidates = append(candidates, t)
	}

	// Cluster: group transactions that share merchant and are within ±1 day / ±$5 of each other.
	type cluster struct {
		merchant string
		txns     []Transaction
	}
	assigned := make([]bool, len(candidates))
	var clusters []cluster

	for i, t := range candidates {
		if assigned[i] {
			continue
		}
		merchant := t.MerchantName
		if merchant == "" {
			merchant = t.Name
		}
		if merchant == "" {
			continue
		}
		date, _ := time.Parse("2006-01-02", t.Date)
		dayI := date.Day()

		cl := cluster{merchant: merchant, txns: []Transaction{t}}
		assigned[i] = true

		for j := i + 1; j < len(candidates); j++ {
			if assigned[j] {
				continue
			}
			u := candidates[j]
			uMerchant := u.MerchantName
			if uMerchant == "" {
				uMerchant = u.Name
			}
			if !strings.EqualFold(merchant, uMerchant) {
				continue
			}
			uDate, _ := time.Parse("2006-01-02", u.Date)
			dayJ := uDate.Day()
			dayDiff := dayI - dayJ
			if dayDiff < 0 {
				dayDiff = -dayDiff
			}
			if dayDiff > 15 {
				dayDiff = 30 - dayDiff
			}
			if dayDiff > 1 {
				continue
			}
			amtDiff := math.Abs(t.Amount) - math.Abs(u.Amount)
			if amtDiff < 0 {
				amtDiff = -amtDiff
			}
			if amtDiff > 5.0 {
				continue
			}
			cl.txns = append(cl.txns, u)
			assigned[j] = true
		}

		if len(cl.txns) >= 2 {
			clusters = append(clusters, cl)
		}
	}

	// Convert clusters to SuggestFixedCost
	var results []SuggestFixedCost
	for _, cl := range clusters {
		var daySum, amtSum float64
		var dates []string
		for _, t := range cl.txns {
			d, _ := time.Parse("2006-01-02", t.Date)
			daySum += float64(d.Day())
			amtSum += math.Abs(t.Amount)
			dates = append(dates, t.Date)
		}
		n := float64(len(cl.txns))
		meanDay := int(math.Round(daySum / n))
		meanAmt := math.Round(amtSum/n*100) / 100

		sort.Strings(dates)
		if len(dates) > 6 {
			dates = dates[len(dates)-6:]
		}

		freq, confidence := inferFrequencyWindowed(len(cl.txns), monthsCovered)

		results = append(results, SuggestFixedCost{
			Merchant:    cl.merchant,
			MeanDay:     meanDay,
			MeanAmount:  meanAmt,
			Frequency:   freq,
			Confidence:  confidence,
			Occurrences: len(cl.txns),
			SampleDates: dates,
		})
	}

	// Sort by mean amount descending
	sort.Slice(results, func(i, j int) bool {
		return results[i].MeanAmount > results[j].MeanAmount
	})

	return &SuggestFixedCostsResult{
		Suggestions:   results,
		OldestDate:    oldestDate,
		MonthsCovered: math.Round(monthsCovered*10) / 10,
		FullWindow:    fullWindow,
	}, nil
}

// inferFrequencyWindowed guesses billing frequency from occurrence count relative
// to the actual data window (in months), returning a frequency and a confidence
// level ("high" or "low").
//
// The expected occurrence count for each frequency over a given window:
//   monthly     → ~1× per month
//   quarterly   → ~1× per 3 months
//   biweekly    → ~2× per month
//   weekly      → ~4× per month
//   semimonthly → ~2× per month
//   annually    → ~1× per 12 months
//
// Confidence is "high" when the count is consistent with the inferred frequency
// over the available window, and "low" when the window is too short to be sure.
func inferFrequencyWindowed(occurrences int, monthsCovered float64) (string, string) {
	if monthsCovered < 0.5 {
		monthsCovered = 0.5
	}

	// Expected counts for each frequency over the actual window
	expected := map[string]float64{
		"weekly":      monthsCovered * 4.33,
		"biweekly":    monthsCovered * 2.17,
		"semimonthly": monthsCovered * 2.0,
		"monthly":     monthsCovered * 1.0,
		"quarterly":   monthsCovered / 3.0,
		"annually":    monthsCovered / 12.0,
	}

	// Find the frequency whose expected count is closest to observed count
	best := "monthly"
	bestDiff := math.MaxFloat64
	order := []string{"weekly", "biweekly", "semimonthly", "monthly", "quarterly", "annually"}
	for _, freq := range order {
		diff := math.Abs(float64(occurrences) - expected[freq])
		if diff < bestDiff {
			bestDiff = diff
			best = freq
		}
	}

	// Confidence: high if observed count is within 1 of expected for that frequency,
	// AND we have enough months to expect at least 2 occurrences at that frequency.
	expectedForBest := expected[best]
	withinOne := math.Abs(float64(occurrences)-expectedForBest) <= 1.0
	enoughData := expectedForBest >= 1.5

	confidence := "high"
	if !withinOne || !enoughData {
		confidence = "low"
	}

	return best, confidence
}

func (c *Client) UpdateTransactionCategory(ctx context.Context, accountID, date, txnID, customCategory string) error {
	// If the user clears the category, also clear the manual flag so rules can
	// re-apply to this transaction.
	manual := customCategory != ""
	_, err := c.ddb.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: &c.table,
		Key: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: accountPK(accountID)},
			"sk": &types.AttributeValueMemberS{Value: txnSK(date, txnID)},
		},
		UpdateExpression: aws.String("SET customCategory = :cat, manualCategory = :manual"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":cat":    &types.AttributeValueMemberS{Value: customCategory},
			":manual": &types.AttributeValueMemberBOOL{Value: manual},
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

// Rule auto-assigns a category and/or budget to transactions whose merchant name
// contains a given substring (case-insensitive). Lower Priority values are applied first.
// AmountMatch/AmountTolerance and DayOfMonth/DayTolerance are optional AND conditions.
type Rule struct {
	PK string `dynamodbav:"pk" json:"-"`
	SK string `dynamodbav:"sk" json:"-"`

	UserID     string `dynamodbav:"userId"     json:"userId"`
	RuleID     string `dynamodbav:"ruleId"     json:"ruleId"`
	Pattern    string `dynamodbav:"pattern"    json:"pattern"`
	CategoryID string `dynamodbav:"categoryId" json:"categoryId"`
	BudgetID   string `dynamodbav:"budgetId"   json:"budgetId"`
	Priority   int    `dynamodbav:"priority"   json:"priority"`

	// Optional amount filter: match transactions where abs(amount) is within
	// AmountTolerance of AmountMatch. Only applied when AmountMatch > 0.
	AmountMatch     float64 `dynamodbav:"amountMatch,omitempty"     json:"amountMatch,omitempty"`
	AmountTolerance float64 `dynamodbav:"amountTolerance,omitempty" json:"amountTolerance,omitempty"`

	// Optional day-of-month filter: match transactions whose date's day is within
	// DayTolerance days of DayOfMonth (wraps around month boundaries).
	// Only applied when DayOfMonth > 0.
	DayOfMonth   int `dynamodbav:"dayOfMonth,omitempty"   json:"dayOfMonth,omitempty"`
	DayTolerance int `dynamodbav:"dayTolerance,omitempty" json:"dayTolerance,omitempty"`

	// IncomeSourceID: if set, this rule was created to match a paycheck deposit
	// for the named income source. The matched transaction's budgetId will be set
	// to IncomeBudgetPrefix + IncomeSourceID.
	IncomeSourceID string `dynamodbav:"incomeSourceId,omitempty" json:"incomeSourceId,omitempty"`
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
			if !strings.Contains(merchant, strings.ToLower(rule.Pattern)) {
				continue
			}
			// Optional amount filter
			if rule.AmountMatch > 0 {
				diff := math.Abs(math.Abs(txn.Amount) - rule.AmountMatch)
				if diff > rule.AmountTolerance {
					continue
				}
			}
			// Optional day-of-month filter
			if rule.DayOfMonth > 0 {
				t, err := time.Parse("2006-01-02", txn.Date)
				if err == nil {
					day := t.Day()
					// Compute circular distance within the month (1–daysInMonth)
					daysInMonth := time.Date(t.Year(), t.Month()+1, 0, 0, 0, 0, 0, time.UTC).Day()
					diff := day - rule.DayOfMonth
					if diff < 0 {
						diff = -diff
					}
					if diff > daysInMonth/2 {
						diff = daysInMonth - diff
					}
					if diff > rule.DayTolerance {
						continue
					}
				}
			}
			if rule.CategoryID != "" {
				result[i].CustomCategory = rule.CategoryID
			}
			if rule.BudgetID != "" && !txn.ManualBudget {
				result[i].BudgetID = rule.BudgetID
				result[i].ManualBudget = true
			}
			break
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

// GetBudgetPeriodsByDateRange returns all periods for a budget whose startDate
// is >= fromDate and < toDate (both YYYY-MM-DD).  Use toDate = "2999-12-31" for
// an open-ended range.  Results are ordered by startDate ascending.
func (c *Client) GetBudgetPeriodsByDateRange(ctx context.Context, budgetID, fromDate, toDate string) ([]BudgetPeriod, error) {
	out, err := c.ddb.Query(ctx, &dynamodb.QueryInput{
		TableName:              &c.table,
		KeyConditionExpression: aws.String("pk = :pk AND sk BETWEEN :from AND :to"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk":   &types.AttributeValueMemberS{Value: budgetPK(budgetID)},
			":from": &types.AttributeValueMemberS{Value: periodSK(fromDate)},
			// Use the day before toDate so the range is exclusive at the upper bound.
			// We filter precisely in Go below, but the key condition prunes most items.
			":to":   &types.AttributeValueMemberS{Value: periodSK(toDate)},
		},
		ScanIndexForward: aws.Bool(true), // oldest first
	})
	if err != nil {
		return nil, err
	}
	var all []BudgetPeriod
	if err := attributevalue.UnmarshalListOfMaps(out.Items, &all); err != nil {
		return nil, err
	}
	// Filter precisely: startDate >= fromDate AND startDate < toDate.
	var result []BudgetPeriod
	for _, p := range all {
		if p.StartDate >= fromDate && p.StartDate < toDate {
			result = append(result, p)
		}
	}
	return result, nil
}

// UpdateBudgetPeriodMasterGoal sets the MasterBudgetGoal field on a single
// budget period without overwriting any other fields.
// goal == 0 clears the override (period will fall back to Budget.GoalAmount).
func (c *Client) UpdateBudgetPeriodMasterGoal(ctx context.Context, budgetID, startDate string, goal float64) error {
	_, err := c.ddb.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(c.table),
		Key: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: budgetPK(budgetID)},
			"sk": &types.AttributeValueMemberS{Value: periodSK(startDate)},
		},
		UpdateExpression: aws.String("SET masterBudgetGoal = :goal"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":goal": &types.AttributeValueMemberN{Value: fmt.Sprintf("%g", goal)},
		},
	})
	return err
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

// ── Period totals (shared by sync and close-budget-period) ───────────────────

// ComputePeriodTotals returns the debit and credit sums for transactions in
// [startDate, endDate] that are assigned to the given budget.
// When a transaction has splits, each split is evaluated independently.
func (c *Client) ComputePeriodTotals(
	ctx context.Context,
	accounts []Account,
	budget *Budget,
	startDate, endDate string,
) (debits, credits float64) {
	for _, acct := range accounts {
		txns, err := c.GetTransactions(ctx, acct.AccountID, startDate, endDate)
		if err != nil {
			continue
		}
		splitMap, err := c.GetSplitsForRange(ctx, acct.AccountID, startDate, endDate)
		if err != nil {
			splitMap = map[string][]TransactionSplit{}
		}
		for _, t := range txns {
			if t.Pending {
				continue
			}
			splits := splitMap[t.DateTransactionID]
			if len(splits) > 0 {
				for _, sp := range splits {
					if sp.BudgetID != budget.BudgetID {
						continue
					}
					if sp.Amount > 0 {
						debits += sp.Amount
					} else {
						credits += -sp.Amount
					}
				}
			} else {
				if t.BudgetID != budget.BudgetID {
					continue
				}
				if t.Amount > 0 {
					debits += t.Amount
				} else {
					credits += -t.Amount
				}
			}
		}
	}
	return
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

// --- IncomeSource CRUD -------------------------------------------------

func (c *Client) PutIncomeSource(ctx context.Context, s IncomeSource) error {
	s.PK = userPK(s.UserID)
	s.SK = incomeSourceSK(s.IncomeSourceID)
	item, err := attributevalue.MarshalMap(s)
	if err != nil {
		return err
	}
	_, err = c.ddb.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: &c.table,
		Item:      item,
	})
	return err
}

func (c *Client) GetIncomeSources(ctx context.Context, userID string) ([]IncomeSource, error) {
	out, err := c.ddb.Query(ctx, &dynamodb.QueryInput{
		TableName:              &c.table,
		KeyConditionExpression: aws.String("pk = :pk AND begins_with(sk, :prefix)"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk":     &types.AttributeValueMemberS{Value: userPK(userID)},
			":prefix": &types.AttributeValueMemberS{Value: "INCOME#"},
		},
	})
	if err != nil {
		return nil, err
	}
	var sources []IncomeSource
	return sources, attributevalue.UnmarshalListOfMaps(out.Items, &sources)
}

func (c *Client) GetIncomeSource(ctx context.Context, userID, sourceID string) (*IncomeSource, error) {
	out, err := c.ddb.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(c.table),
		Key: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: userPK(userID)},
			"sk": &types.AttributeValueMemberS{Value: incomeSourceSK(sourceID)},
		},
	})
	if err != nil {
		return nil, err
	}
	if out.Item == nil {
		return nil, nil
	}
	var s IncomeSource
	return &s, attributevalue.UnmarshalMap(out.Item, &s)
}

func (c *Client) DeleteIncomeSource(ctx context.Context, userID, sourceID string) error {
	_, err := c.ddb.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(c.table),
		Key: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: userPK(userID)},
			"sk": &types.AttributeValueMemberS{Value: incomeSourceSK(sourceID)},
		},
	})
	return err
}

// SaveIncomeSourceNetPay stores the computed net pay result onto the income
// source record so it is available without re-calling the payroll tax API.
func (c *Client) SaveIncomeSourceNetPay(ctx context.Context, userID, sourceID string, result NetPayResult) error {
	item, err := attributevalue.MarshalMap(result)
	if err != nil {
		return err
	}
	av := &types.AttributeValueMemberM{Value: item}
	_, err = c.ddb.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(c.table),
		Key: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: userPK(userID)},
			"sk": &types.AttributeValueMemberS{Value: incomeSourceSK(sourceID)},
		},
		UpdateExpression: aws.String("SET lastNetPay = :r"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":r": av,
		},
	})
	return err
}

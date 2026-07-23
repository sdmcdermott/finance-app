package main

// get-variance-detail returns the breakdown for a synthetic variance transaction:
// expected amount, matched real transactions, and the resulting variance.
// Supports two variance types:
//   - Fixed cost:  txnId = "variance-{fcID}-{YYYY-MM}"
//   - Income:      txnId = "variance-income-{originalTxnID}"

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	auth "github.com/smcdermott/finance-app/internal/auth"
	dbpkg "github.com/smcdermott/finance-app/internal/db"
	plaidclient "github.com/smcdermott/finance-app/internal/plaid"
)

type response = events.APIGatewayV2HTTPResponse

type matchedTxn struct {
	Date   string  `json:"date"`
	Name   string  `json:"name"`
	Amount float64 `json:"amount"` // always positive (absolute value)
}

type varianceDetailResponse struct {
	Label          string       `json:"label"`
	Expected       float64      `json:"expected"`
	Matched        []matchedTxn `json:"matched"`
	VarianceAmount float64      `json:"varianceAmount"` // absolute value
	IsCredit       bool         `json:"isCredit"`       // true = under budget (good/green)
}

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil {
		return *deny, nil
	}

	budgetID := req.PathParameters["budgetId"]
	txnID := req.PathParameters["txnId"]
	if budgetID == "" || txnID == "" {
		return errorResponse(http.StatusBadRequest, "budgetId and txnId path parameters are required"), nil
	}

	userID := plaidclient.UserID()
	dbClient, err := dbpkg.New(ctx)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	if strings.HasPrefix(txnID, "variance-income-") {
		return handleIncomeVariance(ctx, dbClient, userID, budgetID, txnID)
	}
	if strings.HasPrefix(txnID, "variance-") {
		return handleFixedCostVariance(ctx, dbClient, userID, budgetID, txnID)
	}

	return errorResponse(http.StatusBadRequest, "txnId is not a recognised variance transaction"), nil
}

// ── Fixed cost variance ───────────────────────────────────────────────────────

func handleFixedCostVariance(ctx context.Context, dbClient *dbpkg.Client, userID, budgetID, txnID string) (response, error) {
	// txnID format: "variance-{fcID}-{YYYY-MM}"
	// YYYY-MM is always exactly 7 chars at the end, preceded by a hyphen.
	withoutPrefix := strings.TrimPrefix(txnID, "variance-")
	if len(withoutPrefix) < 9 { // minimum: "x-YYYY-MM"
		return errorResponse(http.StatusBadRequest, fmt.Sprintf("cannot parse fixed cost txnId: %s", txnID)), nil
	}
	ym := withoutPrefix[len(withoutPrefix)-7:]
	fcID := withoutPrefix[:len(withoutPrefix)-8] // strip trailing "-YYYY-MM"
	if len(ym) != 7 || ym[4] != '-' {
		return errorResponse(http.StatusBadRequest, fmt.Sprintf("cannot parse YYYY-MM from txnId: %s", txnID)), nil
	}
	monthStart := ym + "-01"
	// Last day: advance to first of next month then subtract one day.
	t, err := time.Parse("2006-01-02", monthStart)
	if err != nil {
		return errorResponse(http.StatusBadRequest, "invalid month in txnId"), nil
	}
	monthEnd := t.AddDate(0, 1, -1).Format("2006-01-02")

	// Load master budget to find the fixed cost config.
	mbs, err := dbClient.GetMasterBudgets(ctx, userID)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}
	var fc *dbpkg.MBFixedCost
	for i := len(mbs) - 1; i >= 0; i-- {
		if mbs[i].EffectiveDate <= monthStart {
			for j := range mbs[i].FixedCosts {
				if mbs[i].FixedCosts[j].ID == fcID {
					fc = &mbs[i].FixedCosts[j]
					break
				}
			}
			if fc != nil {
				break
			}
		}
	}
	// Fallback: search all versions.
	if fc == nil {
		for i := range mbs {
			for j := range mbs[i].FixedCosts {
				if mbs[i].FixedCosts[j].ID == fcID {
					fc = &mbs[i].FixedCosts[j]
					break
				}
			}
			if fc != nil {
				break
			}
		}
	}
	if fc == nil {
		return errorResponse(http.StatusNotFound, fmt.Sprintf("fixed cost %s not found in any master budget version", fcID)), nil
	}

	// Load rules for matchesFixedCost.
	rules, err := dbClient.GetRules(ctx, userID)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}
	ruleByID := make(map[string]dbpkg.Rule, len(rules))
	for _, r := range rules {
		ruleByID[r.RuleID] = r
	}

	// Load master budget transactions for the month and find matches.
	accounts, err := dbClient.GetAccounts(ctx, userID)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	var matched []matchedTxn
	var actualSum float64
	for _, acct := range accounts {
		txns, err := dbClient.GetTransactions(ctx, acct.AccountID, monthStart, monthEnd)
		if err != nil {
			continue
		}
		for _, txn := range txns {
			if txn.Pending || txn.Synthetic {
				continue
			}
			if txn.BudgetID != dbpkg.MasterBudgetID {
				continue
			}
			if matchesFixedCost(txn, *fc, ruleByID) {
				amt := math.Abs(txn.Amount)
				actualSum += amt
				matched = append(matched, matchedTxn{
					Date:   txn.Date,
					Name:   txn.Name,
					Amount: amt,
				})
			}
		}
	}

	expected := monthlyAmount(fc.Amount, fc.Frequency)
	variance := expected - actualSum // positive = under budget (credit)
	detail := varianceDetailResponse{
		Label:          fc.Name + " Variance",
		Expected:       expected,
		Matched:        matched,
		VarianceAmount: math.Abs(variance),
		IsCredit:       variance >= 0,
	}
	if detail.Matched == nil {
		detail.Matched = []matchedTxn{}
	}

	body, _ := json.Marshal(detail)
	return response{StatusCode: http.StatusOK, Body: string(body), Headers: jsonHeaders()}, nil
}

// ── Income variance ───────────────────────────────────────────────────────────

func handleIncomeVariance(ctx context.Context, dbClient *dbpkg.Client, userID, budgetID, txnID string) (response, error) {
	// txnID format: "variance-income-{originalTxnID}"
	originalTxnID := strings.TrimPrefix(txnID, "variance-income-")
	if originalTxnID == "" {
		return errorResponse(http.StatusBadRequest, "cannot parse income variance txnId"), nil
	}

	// Load accounts and find the original paycheck transaction.
	accounts, err := dbClient.GetAccounts(ctx, userID)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	var origTxn *dbpkg.Transaction
	for _, acct := range accounts {
		// We don't know the date, so fetch a broad range (last 2 years).
		start := time.Now().AddDate(-2, 0, 0).Format("2006-01-02")
		end := time.Now().Format("2006-01-02")
		txns, err := dbClient.GetTransactions(ctx, acct.AccountID, start, end)
		if err != nil {
			continue
		}
		for i := range txns {
			if txns[i].TransactionID == originalTxnID {
				origTxn = &txns[i]
				break
			}
		}
		if origTxn != nil {
			break
		}
	}
	if origTxn == nil {
		return errorResponse(http.StatusNotFound, "original paycheck transaction not found"), nil
	}

	// Determine which income source this belongs to.
	incomeSourceID := strings.TrimPrefix(origTxn.BudgetID, dbpkg.IncomeBudgetPrefix)

	mbs, err := dbClient.GetMasterBudgets(ctx, userID)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}
	incomeSources, err := dbClient.GetIncomeSources(ctx, userID)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}
	srcByID := make(map[string]dbpkg.IncomeSource, len(incomeSources))
	for _, s := range incomeSources {
		srcByID[s.IncomeSourceID] = s
	}

	// Find the MBIncomeSource config from the latest master budget version.
	var mbi *dbpkg.MBIncomeSource
	if len(mbs) > 0 {
		latest := &mbs[len(mbs)-1]
		for i := range latest.IncomeSources {
			if latest.IncomeSources[i].IncomeSourceID == incomeSourceID {
				mbi = &latest.IncomeSources[i]
				break
			}
		}
	}
	if mbi == nil {
		return errorResponse(http.StatusNotFound, fmt.Sprintf("income source %s not found in master budget", incomeSourceID)), nil
	}

	src, ok := srcByID[mbi.IncomeSourceID]
	if !ok {
		return errorResponse(http.StatusNotFound, fmt.Sprintf("income source %s not found", mbi.IncomeSourceID)), nil
	}

	// Compute expected per paycheck.
	var expected float64
	if mbi.MonthlyOverride > 0 {
		expected = periodicAmount(mbi.MonthlyOverride, src.Frequency)
	} else if src.LastNetPay != nil {
		expected = src.LastNetPay.NetPay
	} else {
		expected = src.GrossAmount
	}

	actual := math.Abs(origTxn.Amount)
	variance := expected - actual // positive = received less than expected → debit

	detail := varianceDetailResponse{
		Label:    src.Name + " Variance",
		Expected: expected,
		Matched: []matchedTxn{
			{Date: origTxn.Date, Name: origTxn.Name, Amount: actual},
		},
		VarianceAmount: math.Abs(variance),
		IsCredit:       variance <= 0, // received MORE than expected = credit (good)
	}

	body, _ := json.Marshal(detail)
	return response{StatusCode: http.StatusOK, Body: string(body), Headers: jsonHeaders()}, nil
}

// ── Helpers (duplicated from apply-rules to keep Lambda self-contained) ───────

func matchesFixedCost(txn dbpkg.Transaction, fc dbpkg.MBFixedCost, ruleByID map[string]dbpkg.Rule) bool {
	merchant := strings.ToLower(txn.MerchantName)
	if merchant == "" {
		merchant = strings.ToLower(txn.Name)
	}
	if fc.RuleID != "" {
		rule, ok := ruleByID[fc.RuleID]
		if !ok {
			return false
		}
		if !strings.Contains(merchant, strings.ToLower(rule.Pattern)) {
			return false
		}
		if rule.AmountMatch > 0 {
			diff := math.Abs(math.Abs(txn.Amount) - rule.AmountMatch)
			if diff > rule.AmountTolerance {
				return false
			}
		}
		if rule.DayOfMonth > 0 {
			if t, err := time.Parse("2006-01-02", txn.Date); err == nil {
				day := t.Day()
				daysInMonth := time.Date(t.Year(), t.Month()+1, 0, 0, 0, 0, 0, time.UTC).Day()
				diff := day - rule.DayOfMonth
				if diff < 0 {
					diff = -diff
				}
				if diff > daysInMonth/2 {
					diff = daysInMonth - diff
				}
				if diff > rule.DayTolerance {
					return false
				}
			}
		}
		return true
	}
	return strings.Contains(merchant, strings.ToLower(fc.Name))
}

func periodicAmount(monthly float64, frequency string) float64 {
	switch frequency {
	case "weekly":
		return monthly * 12 / 52
	case "biweekly":
		return monthly * 12 / 26
	case "semimonthly":
		return monthly / 2
	case "monthly":
		return monthly
	case "quarterly":
		return monthly * 3
	case "semiannually":
		return monthly * 6
	case "annually":
		return monthly * 12
	default:
		return monthly
	}
}

func monthlyAmount(amount float64, frequency string) float64 {
	switch frequency {
	case "weekly":
		return amount * 52 / 12
	case "biweekly":
		return amount * 26 / 12
	case "semimonthly":
		return amount * 2
	case "monthly":
		return amount
	case "quarterly":
		return amount / 3
	case "semiannually":
		return amount / 6
	case "annually":
		return amount / 12
	default:
		return amount
	}
}

func main() { lambda.Start(handler) }

func errorResponse(status int, msg string) response {
	body, _ := json.Marshal(map[string]string{"error": msg})
	return response{StatusCode: status, Body: string(body), Headers: jsonHeaders()}
}

func jsonHeaders() map[string]string {
	return map[string]string{
		"Content-Type":                "application/json",
		"Access-Control-Allow-Origin": "*",
	}
}

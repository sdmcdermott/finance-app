package main

// get-variance-detail returns the breakdown for a synthetic variance transaction:
// expected amount, matched real transactions, and the resulting variance.
// Supports three variance ID schemes:
//   - Monthly-family fixed cost:      "variance-{fcID}-{YYYY-MM}"
//   - Cyclical fixed cost (matched):  "variance-{fcID}-{realPlaidTransactionID}"
//   - Cyclical fixed cost (missing):  "variance-{fcID}-{windowStartYYYY-MM}"
//   - Income:                         "variance-income-{originalTxnID}"
//
// fcID is always a standard 36-character UUID (crypto.randomUUID() on the
// frontend), so it can be reliably sliced off the front regardless of which
// suffix scheme follows — unlike splitting on "-", which is ambiguous since
// UUIDs themselves contain hyphens.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sort"
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
	withoutPrefix := strings.TrimPrefix(txnID, "variance-")
	const uuidLen = 36 // e.g. "d213e48e-2b6b-4d52-a042-000ed167464b"
	if len(withoutPrefix) < uuidLen+2 {
		return errorResponse(http.StatusBadRequest, fmt.Sprintf("cannot parse fixed cost txnId: %s", txnID)), nil
	}
	fcID := withoutPrefix[:uuidLen]
	suffix := withoutPrefix[uuidLen+1:] // +1 skips the separating hyphen

	// Load master budget to find the fixed cost config (search all versions —
	// we don't yet know which month/version is relevant until we've parsed
	// the suffix below).
	mbs, err := dbClient.GetMasterBudgets(ctx, userID)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}
	var fc *dbpkg.MBFixedCost
	for i := range mbs {
		for j := range mbs[i].FixedCosts {
			if mbs[i].FixedCosts[j].ID == fcID {
				fc = &mbs[i].FixedCosts[j]
			}
		}
	}
	if fc == nil {
		return errorResponse(http.StatusNotFound, fmt.Sprintf("fixed cost %s not found in any master budget version", fcID)), nil
	}

	rules, err := dbClient.GetRules(ctx, userID)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}
	ruleByID := make(map[string]dbpkg.Rule, len(rules))
	for _, r := range rules {
		ruleByID[r.RuleID] = r
	}

	accounts, err := dbClient.GetAccounts(ctx, userID)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	months := cycleMonths(fc.Frequency)
	isYearMonth := len(suffix) == 7 && suffix[4] == '-'

	if months == 1 {
		// ── Monthly-family cost: suffix is always "{YYYY-MM}" ────────────────
		if !isYearMonth {
			return errorResponse(http.StatusBadRequest, fmt.Sprintf("cannot parse YYYY-MM from txnId: %s", txnID)), nil
		}
		monthStart, monthEnd, err := monthBounds(suffix)
		if err != nil {
			return errorResponse(http.StatusBadRequest, "invalid month in txnId"), nil
		}

		var matched []matchedTxn
		var actualSum float64
		for _, acct := range accounts {
			txns, err := dbClient.GetTransactions(ctx, acct.AccountID, monthStart, monthEnd)
			if err != nil {
				continue
			}
			for _, txn := range txns {
				if txn.Pending || txn.Synthetic || txn.BudgetID != dbpkg.MasterBudgetID {
					continue
				}
				if matchesFixedCost(txn, *fc, ruleByID) {
					amt := math.Abs(txn.Amount)
					actualSum += amt
					matched = append(matched, matchedTxn{Date: txn.Date, Name: txn.Name, Amount: amt})
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

	// ── Cyclical cost (quarterly/semiannually/annually) ───────────────────────
	if isYearMonth {
		// "Missing" synthetic: the whole cycle window elapsed with zero
		// matches, so the full period amount was credited. Re-scan the
		// window for completeness, but it should come back empty.
		winStart, winEnd := cycleWindow(suffix, months)
		var matched []matchedTxn
		for _, acct := range accounts {
			txns, err := dbClient.GetTransactions(ctx, acct.AccountID, winStart, winEnd)
			if err != nil {
				continue
			}
			for _, txn := range txns {
				if txn.Pending || txn.Synthetic || txn.BudgetID != dbpkg.MasterBudgetID {
					continue
				}
				if matchesFixedCost(txn, *fc, ruleByID) {
					matched = append(matched, matchedTxn{Date: txn.Date, Name: txn.Name, Amount: math.Abs(txn.Amount)})
				}
			}
		}
		detail := varianceDetailResponse{
			Label:          fc.Name + " Variance",
			Expected:       fc.Amount,
			Matched:        matched,
			VarianceAmount: fc.Amount,
			IsCredit:       true,
		}
		if detail.Matched == nil {
			detail.Matched = []matchedTxn{}
		}
		body, _ := json.Marshal(detail)
		return response{StatusCode: http.StatusOK, Body: string(body), Headers: jsonHeaders()}, nil
	}

	// "Matched" synthetic: suffix is the real Plaid transaction ID that this
	// synthetic was generated from. Find it, determine which cycle window it
	// falls in, and re-derive whether it was the first (full expected) or a
	// later (zero expected) occurrence within that window — mirrors the
	// exact logic in apply-rules' processCyclicalFixedCostWindow.
	realTxnID := suffix
	var found *dbpkg.Transaction
	for _, acct := range accounts {
		// We don't know the date, so fetch a broad range (last 5 years).
		start := time.Now().AddDate(-5, 0, 0).Format("2006-01-02")
		end := time.Now().Format("2006-01-02")
		txns, err := dbClient.GetTransactions(ctx, acct.AccountID, start, end)
		if err != nil {
			continue
		}
		for i := range txns {
			if txns[i].TransactionID == realTxnID {
				found = &txns[i]
				break
			}
		}
		if found != nil {
			break
		}
	}
	if found == nil {
		return errorResponse(http.StatusNotFound, "matched transaction not found"), nil
	}

	winStart, winEnd := cycleWindow(found.Date[:7], months)
	var windowMatches []dbpkg.Transaction
	for _, acct := range accounts {
		txns, err := dbClient.GetTransactions(ctx, acct.AccountID, winStart, winEnd)
		if err != nil {
			continue
		}
		for _, txn := range txns {
			if txn.Pending || txn.Synthetic || txn.BudgetID != dbpkg.MasterBudgetID {
				continue
			}
			if matchesFixedCost(txn, *fc, ruleByID) {
				windowMatches = append(windowMatches, txn)
			}
		}
	}
	sort.Slice(windowMatches, func(i, j int) bool { return windowMatches[i].Date < windowMatches[j].Date })

	isFirst := len(windowMatches) > 0 && windowMatches[0].TransactionID == realTxnID
	expected := 0.0
	if isFirst {
		expected = fc.Amount
	}
	actual := math.Abs(found.Amount)
	variance := expected - actual

	detail := varianceDetailResponse{
		Label:          fc.Name + " Variance",
		Expected:       expected,
		Matched:        []matchedTxn{{Date: found.Date, Name: found.Name, Amount: actual}},
		VarianceAmount: math.Abs(variance),
		IsCredit:       variance >= 0,
	}
	body, _ := json.Marshal(detail)
	return response{StatusCode: http.StatusOK, Body: string(body), Headers: jsonHeaders()}, nil
}

// monthBounds returns the [start, end] YYYY-MM-DD bounds of the calendar
// month "YYYY-MM".
func monthBounds(ym string) (string, string, error) {
	monthStart := ym + "-01"
	t, err := time.Parse("2006-01-02", monthStart)
	if err != nil {
		return "", "", err
	}
	monthEnd := t.AddDate(0, 1, -1).Format("2006-01-02")
	return monthStart, monthEnd, nil
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

// cycleMonths returns the number of months in one full billing cycle for the
// given frequency. Frequencies of one month or less return 1.
func cycleMonths(frequency string) int {
	switch frequency {
	case "quarterly":
		return 3
	case "semiannually":
		return 6
	case "annually":
		return 12
	default:
		return 1
	}
}

// cycleWindow returns the calendar-aligned [start, end] date bounds (both
// inclusive, YYYY-MM-DD) of the `months`-long cycle window containing month
// `ym` (YYYY-MM).
func cycleWindow(ym string, months int) (string, string) {
	var y, m int
	fmt.Sscanf(ym, "%d-%d", &y, &m)
	windowIndex := (m - 1) / months
	startMonth := windowIndex*months + 1
	endMonth := startMonth + months - 1
	start := time.Date(y, time.Month(startMonth), 1, 0, 0, 0, 0, time.UTC)
	end := time.Date(y, time.Month(endMonth+1), 0, 0, 0, 0, 0, time.UTC)
	return start.Format("2006-01-02"), end.Format("2006-01-02")
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

package main

// apply-rules re-applies all auto-assignment rules to transactions for the
// current month (or an optional month supplied via query parameter).
// Only transactions that have NOT been manually categorized are updated.
//
// After applying rules it also upserts variance synthetic transactions for:
//   - Fixed costs with a linkedBudgetId: amount = -(expected - actual).
//     Under budget (spent less) → credit (negative). Over budget → debit (positive).
//   - Income sources with a linkedBudgetId: amount = expected - actual.
//     Under budget (received less) → debit (positive). Over budget → credit (negative).
//
// In both cases a synthetic is only written for months that have at least one
// matched transaction. Deterministic IDs enable upsert on re-run.

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

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil {
		return *deny, nil
	}
	dbClient, err := dbpkg.New(ctx)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	userID := plaidclient.UserID()

	// Determine date range: if month is provided restrict to that month,
	// otherwise apply to all transactions (no date filter).
	var startDate, endDate string
	month := req.QueryStringParameters["month"] // optional "YYYY-MM"
	if month != "" {
		var y, m int
		if _, err := fmt.Sscanf(month, "%d-%d", &y, &m); err == nil {
			t := time.Date(y, time.Month(m), 1, 0, 0, 0, 0, time.UTC)
			startDate = t.Format("2006-01-02")
			last := time.Date(y, time.Month(m+1), 0, 0, 0, 0, 0, time.UTC).Day()
			endDate = fmt.Sprintf("%04d-%02d-%02d", y, m, last)
		}
	}
	if startDate == "" {
		// No month filter — span the full range of plausible dates
		startDate = "2000-01-01"
		endDate = "2999-12-31"
	}

	accounts, err := dbClient.GetAccounts(ctx, userID)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	rules, err := dbClient.GetRules(ctx, userID)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	if len(rules) == 0 {
		body, _ := json.Marshal(map[string]interface{}{"updated": 0, "message": "no rules defined"})
		return response{StatusCode: http.StatusOK, Body: string(body), Headers: jsonHeaders()}, nil
	}

	// Collect all transactions for the period, with splits embedded
	var allTxns []dbpkg.Transaction
	for _, acct := range accounts {
		txns, err := dbClient.GetTransactions(ctx, acct.AccountID, startDate, endDate)
		if err != nil {
			return errorResponse(http.StatusInternalServerError, err.Error()), nil
		}
		splitMap, _ := dbClient.GetSplitsForRange(ctx, acct.AccountID, startDate, endDate)
		for i := range txns {
			if splits, ok := splitMap[txns[i].DateTransactionID]; ok {
				txns[i].Splits = splits
			}
		}
		allTxns = append(allTxns, txns...)
	}

	// Apply rules
	updated := dbpkg.ApplyRulesToTransactions(rules, allTxns)

	// Persist only the transactions whose customCategory or budgetId actually changed
	var toWrite []dbpkg.Transaction
	type origState struct{ cat, budget string }
	origMap := make(map[string]origState, len(allTxns))
	for _, t := range allTxns {
		origMap[t.DateTransactionID] = origState{t.CustomCategory, t.BudgetID}
	}
	for _, t := range updated {
		orig := origMap[t.DateTransactionID]
		if t.CustomCategory != orig.cat || t.BudgetID != orig.budget {
			toWrite = append(toWrite, t)
		}
	}

	if len(toWrite) > 0 {
		if err := dbClient.PutTransactions(ctx, toWrite); err != nil {
			return errorResponse(http.StatusInternalServerError, err.Error()), nil
		}
	}

	// ── Variance synthetic transactions ──────────────────────────────────────
	// For each fixed cost in the master budget that has a linkedBudgetId, find
	// matched master-budget transactions and upsert a synthetic variance
	// transaction into the system account tagged to that linked budget.
	//
	// We use the post-apply view (updated) so BudgetIDs are current.
	synthCount, synthErr := upsertVarianceSynthetics(ctx, dbClient, userID, updated, allTxns, rules, startDate, endDate)
	_ = synthErr // non-fatal — regular rule application already succeeded

	body, _ := json.Marshal(map[string]interface{}{
		"updated":    len(toWrite),
		"synthetics": synthCount,
		"startDate":  startDate,
		"endDate":    endDate,
	})
	return response{StatusCode: http.StatusOK, Body: string(body), Headers: jsonHeaders()}, nil
}

// upsertVarianceSynthetics computes variance for fixed costs with a
// linkedBudgetId and writes synthetic transactions to the system account.
// It returns the number of synthetic transactions written.
func upsertVarianceSynthetics(
	ctx context.Context,
	dbClient *dbpkg.Client,
	userID string,
	updatedTxns []dbpkg.Transaction, // post-apply-rules transactions
	origTxns []dbpkg.Transaction, // pre-apply-rules (same slice refs, used as pool)
	rules []dbpkg.Rule,
	startDate, endDate string,
) (int, error) {
	// Load the master budget versions that cover the processed date range.
	// We use GetMasterBudgets and check each version's EffectiveDate.
	mbs, err := dbClient.GetMasterBudgets(ctx, userID)
	if err != nil {
		return 0, err
	}
	if len(mbs) == 0 {
		return 0, nil
	}

	// Load income sources once — needed for expected net-pay amounts.
	incomeSources, err := dbClient.GetIncomeSources(ctx, userID)
	if err != nil {
		return 0, err
	}
	srcByID := make(map[string]dbpkg.IncomeSource, len(incomeSources))
	for _, s := range incomeSources {
		srcByID[s.IncomeSourceID] = s
	}

	// Build rule lookup
	ruleByID := make(map[string]dbpkg.Rule, len(rules))
	for _, r := range rules {
		ruleByID[r.RuleID] = r
	}

	// Collect master-budget transactions from the updated slice, grouped by YYYY-MM.
	// We use updatedTxns so that any BudgetID stamps applied this run are visible.
	type txnEntry struct {
		txn   dbpkg.Transaction
		month string // YYYY-MM
	}
	var masterTxns []txnEntry
	var incomeTxns []txnEntry
	for _, t := range updatedTxns {
		if t.Pending || t.Synthetic || len(t.Date) < 7 {
			continue
		}
		ym := t.Date[:7]
		if t.BudgetID == dbpkg.MasterBudgetID {
			masterTxns = append(masterTxns, txnEntry{txn: t, month: ym})
		}
		if strings.HasPrefix(t.BudgetID, dbpkg.IncomeBudgetPrefix) {
			incomeTxns = append(incomeTxns, txnEntry{txn: t, month: ym})
		}
	}

	if len(masterTxns) == 0 && len(incomeTxns) == 0 {
		return 0, nil
	}

	// Collect all YYYY-MM months present across master and income txns
	monthSet := make(map[string]bool)
	for _, e := range masterTxns {
		monthSet[e.month] = true
	}
	for _, e := range incomeTxns {
		monthSet[e.month] = true
	}

	var synthetics []dbpkg.Transaction

	for ym := range monthSet {
		// Pick the effective master budget for this month
		monthStart := ym + "-01"
		var mb *dbpkg.MasterBudget
		for i := len(mbs) - 1; i >= 0; i-- {
			if mbs[i].EffectiveDate <= monthStart {
				mb = &mbs[i]
				break
			}
		}
		if mb == nil {
			mb = &mbs[0]
		}

		// Filter master txns for this month
		var monthMasterTxns []dbpkg.Transaction
		for _, e := range masterTxns {
			if e.month == ym {
				monthMasterTxns = append(monthMasterTxns, e.txn)
			}
		}

		for _, fc := range mb.FixedCosts {
			if fc.LinkedBudgetID == "" {
				continue
			}

			// Match transactions for this fixed cost
			var actualSum float64
			var matchCount int
			for _, txn := range monthMasterTxns {
				if matchesFixedCost(txn, fc, ruleByID) {
					actualSum += math.Abs(txn.Amount)
					matchCount++
				}
			}

			if matchCount == 0 {
				// No match this month — don't create a synthetic transaction yet.
				// It will be created once a matching transaction appears.
				continue
			}

			// variance = expected - actual
			// positive → under budget → credit → negative amount (Plaid: negative = credit)
			// negative → over budget  → debit  → positive amount (Plaid: positive = debit)
			expected := monthlyAmount(fc.Amount, fc.Frequency)
			variance := expected - actualSum
			syntheticAmount := -variance // negate: under-budget credit is negative

			// Deterministic TransactionID enables upsert on re-run
			txnID := fmt.Sprintf("variance-%s-%s", fc.ID, ym)
			date := ym + "-01"

			synthetics = append(synthetics, dbpkg.Transaction{
				AccountID:         dbpkg.SystemAccountID,
				DateTransactionID: date + "#" + txnID,
				TransactionID:     txnID,
				Date:              date,
				Name:              fc.Name + " Variance",
				Amount:            syntheticAmount,
				BudgetID:          fc.LinkedBudgetID,
				Synthetic:         true,
			})
		}

		// ── Income source variance synthetics ─────────────────────────────────
		// Income variance is handled per-paycheck below, outside the month loop.
	}

	// ── Per-paycheck income variance synthetics ────────────────────────────────
	// For each individual income transaction, create a variance synthetic dated
	// the same day as the paycheck: amount = expectedPerPeriod - actual.
	//   received less than expected → positive → debit
	//   received more  than expected → negative → credit
	//
	// Build a lookup: incomeSourceID → effective master budget (use the most
	// recent MB version — income source config rarely changes mid-year).
	// For simplicity we pick the latest MB version.
	latestMB := &mbs[len(mbs)-1]

	for _, e := range incomeTxns {
		// Find the MBIncomeSource config
		var mbi *dbpkg.MBIncomeSource
		for i := range latestMB.IncomeSources {
			if latestMB.IncomeSources[i].IncomeSourceID == strings.TrimPrefix(e.txn.BudgetID, dbpkg.IncomeBudgetPrefix) {
				mbi = &latestMB.IncomeSources[i]
				break
			}
		}
		if mbi == nil || !mbi.Enabled || mbi.LinkedBudgetID == "" {
			continue
		}
		src, ok := srcByID[mbi.IncomeSourceID]
		if !ok {
			continue
		}

		// Expected amount per paycheck
		var expectedPerPeriod float64
		if mbi.MonthlyOverride > 0 {
			expectedPerPeriod = periodicAmount(mbi.MonthlyOverride, src.Frequency)
		} else {
			if src.LastNetPay != nil {
				expectedPerPeriod = src.LastNetPay.NetPay
			} else {
				expectedPerPeriod = src.GrossAmount
			}
		}

		actual := math.Abs(e.txn.Amount)
		syntheticAmount := expectedPerPeriod - actual

		// Deterministic ID tied to the specific paycheck transaction
		txnID := fmt.Sprintf("variance-income-%s", e.txn.TransactionID)

		synthetics = append(synthetics, dbpkg.Transaction{
			AccountID:         dbpkg.SystemAccountID,
			DateTransactionID: e.txn.Date + "#" + txnID,
			TransactionID:     txnID,
			Date:              e.txn.Date,
			Name:              src.Name + " Variance",
			Amount:            syntheticAmount,
			BudgetID:          mbi.LinkedBudgetID,
			Synthetic:         true,
		})
	}

	if len(synthetics) == 0 {
		return 0, nil
	}

	if err := dbClient.PutTransactions(ctx, synthetics); err != nil {
		return 0, err
	}
	return len(synthetics), nil
}

// periodicAmount converts a monthly amount back to the per-period equivalent.
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

// monthlyAmount converts a periodic amount to its monthly equivalent.
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

// matchesFixedCost returns true if txn matches the given fixed cost's rule
// (or name fallback), replicating the logic in get-master-budget-variance.
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

	// Legacy fallback: match by fixed cost name substring
	return strings.Contains(merchant, strings.ToLower(fc.Name))
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

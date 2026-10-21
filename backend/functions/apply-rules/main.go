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
	synthCount, synthErr := upsertVarianceSynthetics(ctx, dbClient, userID, accounts, updated, allTxns, rules, startDate, endDate)
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
	accounts []dbpkg.Account,
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

	var synthetics []dbpkg.Transaction

	// effectiveFixedCost finds the fixed cost with the given ID as defined by
	// whichever master budget version was in effect for the given "YYYY-MM"
	// month — so a fixed cost's amount/frequency changes across master
	// budget versions are respected per-month rather than always using
	// whichever version happens to be picked up first.
	effectiveFixedCost := func(fcID, ym string) (dbpkg.MBFixedCost, bool) {
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
		for _, fc := range mb.FixedCosts {
			if fc.ID == fcID {
				return fc, true
			}
		}
		return dbpkg.MBFixedCost{}, false
	}

	// ── Fixed-cost variance synthetics ────────────────────────────────────────
	// Processed once per fixed cost (deduped by ID across master budget
	// versions) rather than per month-that-happens-to-have-a-transaction, so
	// that months/cycles with ZERO matching transactions are still correctly
	// evaluated — a recurring cost that was expected but never charged should
	// show up as a full credit (the whole expected amount was saved), not
	// silence. We only ever do this starting from a fixed cost's first-ever
	// real match: a rule with zero history yet gives no baseline to judge
	// "missing" against, so it's left alone until it matches at least once.
	fixedCostIDs := make(map[string]bool)
	for i := range mbs {
		for _, fc := range mbs[i].FixedCosts {
			if fc.LinkedBudgetID != "" {
				fixedCostIDs[fc.ID] = true
			}
		}
	}

	now := time.Now().UTC()
	currentYM := now.Format("2006-01")
	todayStr := now.Format("2006-01-02")

	for fcID := range fixedCostIDs {
		// Earliest month this fixed cost has ever actually matched a real
		// transaction, using whichever MB version was effective each month.
		var firstMatchMonth string
		for _, e := range masterTxns {
			fc, ok := effectiveFixedCost(fcID, e.month)
			if !ok {
				continue
			}
			if matchesFixedCost(e.txn, fc, ruleByID) && (firstMatchMonth == "" || e.month < firstMatchMonth) {
				firstMatchMonth = e.month
			}
		}
		if firstMatchMonth == "" {
			continue // never matched anything — no baseline to detect "missing" against
		}

		// Use the cost's currently-effective definition to decide whether
		// it's a monthly-family or cyclical cost. Frequency changes mid
		// history are rare and not specially handled beyond this.
		latestFC, ok := effectiveFixedCost(fcID, currentYM)
		if !ok {
			continue // no longer part of the current master budget
		}
		months := cycleMonths(latestFC.Frequency)

		if months == 1 {
			// ── Monthly-family costs (monthly/weekly/biweekly/semimonthly) ────
			monthActual := make(map[string]float64)
			for _, e := range masterTxns {
				fc, ok := effectiveFixedCost(fcID, e.month)
				if !ok {
					continue
				}
				if matchesFixedCost(e.txn, fc, ruleByID) {
					monthActual[e.month] += math.Abs(e.txn.Amount)
				}
			}

			startIdx := monthIndex(firstMatchMonth)
			endIdx := monthIndex(currentYM)
			for i := startIdx; i <= endIdx; i++ {
				ym := monthFromIndex(i)
				fc, ok := effectiveFixedCost(fcID, ym)
				if !ok {
					continue // fixed cost wasn't part of the budget that month
				}
				expected := monthlyAmount(fc.Amount, fc.Frequency)
				actualSum, matched := monthActual[ym]

				if !matched && ym == currentYM {
					// The current month is still in progress and has no
					// match yet — the bill may simply not have posted this
					// month. Don't credit prematurely; a synthetic will be
					// created once (if) a real match arrives on a later run.
					continue
				}

				var syntheticAmount float64
				if matched {
					// variance = expected - actual
					// positive → under budget → credit → negative amount
					// negative → over budget  → debit  → positive amount
					syntheticAmount = -(expected - actualSum)
				} else {
					// No match this month at all — full credit: the whole
					// expected amount was never charged.
					syntheticAmount = -expected
				}

				txnID := fmt.Sprintf("variance-%s-%s", fcID, ym)
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
			continue
		}

		// ── Cyclical costs (quarterly/semiannually/annually) ────────────────────
		// Walk every calendar-aligned cycle window from the one containing
		// the first-ever match through the one containing today. Only fully
		// elapsed windows are eligible for a "missing → full credit" verdict;
		// the current, still-in-progress window is left alone since the bill
		// may simply not have posted yet.
		firstWindowIdx := monthIndex(firstMatchMonth) / months
		currentWindowIdx := monthIndex(currentYM) / months

		for w := firstWindowIdx; w <= currentWindowIdx; w++ {
			winStartYM := monthFromIndex(w * months)
			fc, ok := effectiveFixedCost(fcID, winStartYM)
			if !ok {
				continue
			}
			winStart, winEnd := cycleWindow(winStartYM, months)
			isCompleted := winEnd < todayStr
			windowSynthetics, err := processCyclicalFixedCostWindow(ctx, dbClient, accounts, fc, ruleByID, winStart, winEnd, isCompleted)
			if err == nil {
				synthetics = append(synthetics, windowSynthetics...)
			}
		}
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

// cycleMonths returns the number of months in one full billing cycle for the
// given frequency. Frequencies of one month or less (monthly and anything
// more frequent) return 1, meaning the simple per-month variance logic
// applies directly. Only quarterly/semiannually/annually get special
// cycle-aware handling.
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
// `ym` (YYYY-MM). E.g. for months=12, any month in 2026 maps to the full
// calendar year [2026-01-01, 2026-12-31]; for months=3, March 2026 maps to
// the Q1 window [2026-01-01, 2026-03-31].
func cycleWindow(ym string, months int) (string, string) {
	var y, m int
	fmt.Sscanf(ym, "%d-%d", &y, &m)
	windowIndex := (m - 1) / months
	startMonth := windowIndex*months + 1
	endMonth := startMonth + months - 1
	start := time.Date(y, time.Month(startMonth), 1, 0, 0, 0, 0, time.UTC)
	end := time.Date(y, time.Month(endMonth+1), 0, 0, 0, 0, 0, time.UTC) // day 0 = last day of endMonth
	return start.Format("2006-01-02"), end.Format("2006-01-02")
}

// monthIndex converts a "YYYY-MM" string to a linear month count since year 0
// (e.g. "2026-03" -> 2026*12+2), so cycle windows and month ranges can be
// walked with simple integer arithmetic instead of juggling date strings.
func monthIndex(ym string) int {
	var y, m int
	fmt.Sscanf(ym, "%d-%d", &y, &m)
	return y*12 + (m - 1)
}

// monthFromIndex is the inverse of monthIndex.
func monthFromIndex(idx int) string {
	y := idx / 12
	m := idx%12 + 1
	return fmt.Sprintf("%04d-%02d", y, m)
}

// processCyclicalFixedCostWindow computes variance synthetics for a single
// fixed cost across one full cycle window (e.g. one calendar year for an
// annual cost). The first matching transaction in the window (sorted by
// date) is compared against the full period amount (fc.Amount); any
// subsequent matches in the same window are treated as pure additional
// variance (expected = $0), since the period's budgeted allowance was
// already accounted for by the first occurrence.
//
// It also removes any stale per-month synthetics that the old (pre-fix)
// monthly-divided calculation may have left behind for months within this
// window, so they don't linger as duplicate/incorrect entries in the linked
// budget alongside the corrected ones.
func processCyclicalFixedCostWindow(
	ctx context.Context,
	dbClient *dbpkg.Client,
	accounts []dbpkg.Account,
	fc dbpkg.MBFixedCost,
	ruleByID map[string]dbpkg.Rule,
	winStart, winEnd string,
	isCompleted bool, // true if this cycle window has already fully elapsed
) ([]dbpkg.Transaction, error) {
	var matches []dbpkg.Transaction
	for _, acct := range accounts {
		txns, err := dbClient.GetTransactions(ctx, acct.AccountID, winStart, winEnd)
		if err != nil {
			return nil, err
		}
		for _, t := range txns {
			if t.Pending || t.Synthetic || t.BudgetID != dbpkg.MasterBudgetID {
				continue
			}
			if matchesFixedCost(t, fc, ruleByID) {
				matches = append(matches, t)
			}
		}
	}

	// Always attempt stale-synthetic cleanup, even if there are no current
	// matches (e.g. a previously-matched transaction was recategorized away).
	staleKeys := make([]struct{ Date, TxnID string }, 0)
	start, _ := time.Parse("2006-01-02", winStart)
	end, _ := time.Parse("2006-01-02", winEnd)
	for d := start; !d.After(end); d = d.AddDate(0, 1, 0) {
		ym := d.Format("2006-01")
		oldTxnID := fmt.Sprintf("variance-%s-%s", fc.ID, ym)
		staleKeys = append(staleKeys, struct{ Date, TxnID string }{Date: ym + "-01", TxnID: oldTxnID})
	}
	_ = dbClient.DeleteTransactions(ctx, dbpkg.SystemAccountID, staleKeys) // best-effort cleanup

	if len(matches) == 0 {
		if !isCompleted {
			// Still inside the current cycle — the bill may simply not have
			// posted yet. Don't credit prematurely.
			return nil, nil
		}
		// The cycle fully elapsed with zero matching transactions — the
		// entire expected amount was never charged, so credit it in full.
		txnID := fmt.Sprintf("variance-%s-%s", fc.ID, winStart[:7])
		return []dbpkg.Transaction{{
			AccountID:         dbpkg.SystemAccountID,
			DateTransactionID: winEnd + "#" + txnID,
			TransactionID:     txnID,
			Date:              winEnd,
			Name:              fc.Name + " Variance",
			Amount:            -fc.Amount, // full credit — nothing was charged this cycle
			BudgetID:          fc.LinkedBudgetID,
			Synthetic:         true,
		}}, nil
	}
	sort.Slice(matches, func(i, j int) bool { return matches[i].Date < matches[j].Date })

	synthetics := make([]dbpkg.Transaction, 0, len(matches))
	for i, txn := range matches {
		var expected float64
		if i == 0 {
			expected = fc.Amount // full period amount for the first occurrence in this cycle
		} else {
			expected = 0 // subsequent occurrences in the same cycle are pure variance
		}
		actual := math.Abs(txn.Amount)
		variance := expected - actual
		syntheticAmount := -variance

		// Deterministic per-matched-transaction ID (rather than per-month) so
		// multiple occurrences within the same cycle each get their own
		// synthetic, and re-running apply-rules upserts cleanly.
		txnID := fmt.Sprintf("variance-%s-%s", fc.ID, txn.TransactionID)

		synthetics = append(synthetics, dbpkg.Transaction{
			AccountID:         dbpkg.SystemAccountID,
			DateTransactionID: txn.Date + "#" + txnID,
			TransactionID:     txnID,
			Date:              txn.Date,
			Name:              fc.Name + " Variance",
			Amount:            syntheticAmount,
			BudgetID:          fc.LinkedBudgetID,
			Synthetic:         true,
		})
	}
	return synthetics, nil
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

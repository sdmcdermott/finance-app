package main

// get-cash-flow-forecast projects a future cash balance for the user's
// designated "cash" account (Account.IsCashAccount), combining:
//   - Expected income: from IncomeSource, anchored by the most recent
//     rule-matched paycheck transaction, or a manual NextPayDateOverride
//     fallback when no match history exists yet.
//   - Expected fixed/recurring costs: from the effective MasterBudget's
//     FixedCosts, anchored by the most recent real matched transaction, the
//     linked Rule's DayOfMonth, or a manual DayOfMonthOverride fallback.
//   - Expected credit card payments: reconstructed from each credit
//     account's own transaction history (see internal/db/cccycle.go) — no
//     Plaid Liabilities product involved. High-confidence cards get a
//     precise next due date/amount; low-confidence cards fall back to an
//     approximate monthly projection from historical payment patterns.
//
// Query params: days (forecast horizon, default 60)

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	auth "github.com/smcdermott/finance-app/internal/auth"
	dbpkg "github.com/smcdermott/finance-app/internal/db"
	plaidclient "github.com/smcdermott/finance-app/internal/plaid"
)

type response = events.APIGatewayV2HTTPResponse

type ccTxnSummary struct {
	Date   string  `json:"date"`
	Label  string  `json:"label"`
	Amount float64 `json:"amount"` // Plaid convention: positive = charge, negative = credit
}

// creditCardDetail gives the UI enough to explain how a creditCardPayment
// event's amount was derived, shown behind a "details" chip on the label.
type creditCardDetail struct {
	Confidence   string         `json:"confidence"` // "high" | "low" | "manual"
	BillingStart string         `json:"billingStart,omitempty"`
	BillingEnd   string         `json:"billingEnd,omitempty"`
	Transactions []ccTxnSummary `json:"transactions"`
}

type forecastEvent struct {
	Date             string            `json:"date"`
	Label            string            `json:"label"`
	Amount           float64           `json:"amount"` // positive = inflow, negative = outflow
	Type             string            `json:"type"`   // "income" | "fixedCost" | "creditCardPayment"
	CreditCardDetail *creditCardDetail `json:"creditCardDetail,omitempty"`
}

type forecastPoint struct {
	Date    string  `json:"date"`
	Balance float64 `json:"balance"`
}

type forecastResponse struct {
	CashAccountID    string          `json:"cashAccountId"`
	StartingBalance  float64         `json:"startingBalance"`
	BalanceUpdatedAt string          `json:"balanceUpdatedAt,omitempty"`
	AsOf             string          `json:"asOf"`
	HorizonDays      int             `json:"horizonDays"`
	Events           []forecastEvent `json:"events"`
	Series           []forecastPoint `json:"series"`
}

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil {
		return *deny, nil
	}

	days := 60
	if v := req.QueryStringParameters["days"]; v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			days = n
		}
	}

	dbClient, err := dbpkg.New(ctx)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}
	userID := plaidclient.UserID()

	accounts, err := dbClient.GetAccounts(ctx, userID)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	var cashAccount *dbpkg.Account
	for i := range accounts {
		if accounts[i].IsCashAccount {
			cashAccount = &accounts[i]
			break
		}
	}
	if cashAccount == nil {
		return errorResponse(http.StatusBadRequest, "no cash account designated — set one on the Accounts page"), nil
	}

	now := time.Now().UTC()
	today := now.Format("2006-01-02")
	horizonEnd := now.AddDate(0, 0, days)

	rules, err := dbClient.GetRules(ctx, userID)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}
	ruleByID := make(map[string]dbpkg.Rule, len(rules))
	for _, r := range rules {
		ruleByID[r.RuleID] = r
	}

	var events []forecastEvent

	// ── Transaction cache ────────────────────────────────────────────────────
	// Income-anchor and fixed-cost-anchor lookups each need to scan every
	// account's transaction history. Fetching that once per account up front
	// (instead of once per income source / fixed cost) turns what used to be
	// O(accounts * (incomeSources + fixedCosts)) DynamoDB queries into a flat
	// O(accounts) — this was previously causing 50s+ Lambda durations (and
	// resulting 503s from API Gateway's ~30s HTTP API integration timeout)
	// for users with many linked accounts and fixed costs.
	oneYearAgo := now.AddDate(-1, 0, 0).Format("2006-01-02")
	txnCache := fetchTxnCache(ctx, dbClient, accounts, oneYearAgo, today)

	// ── Income projection ───────────────────────────────────────────────────
	incomeSources, err := dbClient.GetIncomeSources(ctx, userID)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}
	for _, src := range incomeSources {
		if !src.IsActive {
			continue
		}
		anchor, ok := findIncomeAnchor(src, accounts, txnCache)
		if !ok {
			continue
		}
		amount := src.GrossAmount
		if src.LastNetPay != nil {
			amount = src.LastNetPay.NetPay
		}
		for _, d := range projectDates(anchor, src.Frequency, now, horizonEnd) {
			events = append(events, forecastEvent{
				Date:   d.Format("2006-01-02"),
				Label:  src.Name,
				Amount: amount,
				Type:   "income",
			})
		}
	}

	// ── Fixed cost projection ───────────────────────────────────────────────
	mb, err := dbClient.GetEffectiveMasterBudget(ctx, userID, today)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}
	if mb != nil {
		for _, fc := range mb.FixedCosts {
			anchor, sourceAccountID, ok := findFixedCostAnchor(fc, ruleByID, accounts, txnCache)
			if !ok {
				continue
			}
			// If this fixed cost's matched transaction lives on a different
			// account than the designated cash account (e.g. Netflix on a
			// credit card), don't project it as its own cash outflow — it's
			// already folded into that card's reconstructed payment amount
			// below, and counting both would double-count the spend. Fixed
			// costs with no real matched transaction yet (sourceAccountID
			// == "", anchored via a rule/override fallback) are assumed to
			// be direct cash draws, since that's the only reason a manual
			// anchor would be configured for them.
			if sourceAccountID != "" && sourceAccountID != cashAccount.AccountID {
				continue
			}
			for _, d := range projectDates(anchor, fc.Frequency, now, horizonEnd) {
				events = append(events, forecastEvent{
					Date:   d.Format("2006-01-02"),
					Label:  fc.Name,
					Amount: -fc.Amount,
					Type:   "fixedCost",
				})
			}
		}
	}

	// ── Credit card payment projection ──────────────────────────────────────
	lookbackStart := now.AddDate(0, -6, 0).Format("2006-01-02")
	for _, acct := range accounts {
		if acct.Type != "credit" {
			continue
		}
		// Skip disabled (sync-off) credit cards — the user has explicitly
		// opted this account out of syncing, so it shouldn't contribute a
		// projected payment to the forecast either.
		if !dbpkg.AccountEnabled(acct) {
			continue
		}
		txns := filterTxnsByDate(txnCache[acct.AccountID], lookbackStart, today)

		var result dbpkg.CCCycleResult
		if acct.CCPaymentDueDay > 0 && acct.CCGracePeriodDays > 0 {
			// User has manually configured this card's cycle (directly, via
			// the guided statement Q&A, or copied from a prior automatic
			// suggestion) — use it directly instead of re-running the search.
			result = dbpkg.ReconstructCreditCardCycleManual(txns, now, acct.CCPaymentDueDay, acct.CCGracePeriodDays)
		} else {
			result = dbpkg.ReconstructCreditCardCycle(txns, now)
		}

		label := acct.NickName
		if label == "" {
			label = acct.Name
		}

		buildDetail := func() *creditCardDetail {
			billingStart := result.LastCloseDate
			if lc, err := time.Parse("2006-01-02", result.LastCloseDate); err == nil {
				// LastCloseDate is the EXCLUSIVE bound (the day before the
				// window actually starts) — shift forward one day for
				// display so "billing start" shows the first day actually
				// included, not the day before it.
				billingStart = lc.AddDate(0, 0, 1).Format("2006-01-02")
			}
			// NextCloseDate (the presumed statement close date) is only
			// populated for "high"/"manual" — "low" confidence has no real
			// cycle to anchor to, so it keeps showing "since last payment
			// through today" as before.
			billingEnd := result.NextCloseDate
			if billingEnd == "" {
				billingEnd = today
			}
			detail := &creditCardDetail{
				Confidence:   result.Confidence,
				BillingStart: billingStart,
				BillingEnd:   billingEnd,
				Transactions: make([]ccTxnSummary, len(result.WindowTransactions)),
			}
			for i, t := range result.WindowTransactions {
				detail.Transactions[i] = ccTxnSummary{Date: t.Date, Label: t.Label, Amount: t.Amount}
			}
			return detail
		}

		switch result.Confidence {
		case "high", "manual":
			due, err := time.Parse("2006-01-02", result.NextDueDate)
			if err == nil && due.After(now) && !due.After(horizonEnd) {
				suffix := "est"
				if result.Confidence == "manual" {
					suffix = "manual"
				}
				events = append(events, forecastEvent{
					Date:             result.NextDueDate,
					Label:            label + " payment " + suffix,
					Amount:           -result.ProjectedNextPaymentAmount,
					Type:             "creditCardPayment",
					CreditCardDetail: buildDetail(),
				})
			}
		case "low":
			if result.FallbackMeanDay > 0 {
				detail := buildDetail()
				lastMonth := now.AddDate(0, -1, 0)
				anchor := dateWithDay(lastMonth.Year(), lastMonth.Month(), result.FallbackMeanDay)
				for _, d := range projectDates(anchor, "monthly", now, horizonEnd) {
					events = append(events, forecastEvent{
						Date:             d.Format("2006-01-02"),
						Label:            label + " payment approx",
						Amount:           -result.FallbackMeanAmount,
						Type:             "creditCardPayment",
						CreditCardDetail: detail,
					})
				}
			}
		}
	}

	sort.Slice(events, func(i, j int) bool { return events[i].Date < events[j].Date })

	// ── Build running-balance series ────────────────────────────────────────
	startingBalance := cashAccount.CurrentBalance
	balance := startingBalance
	series := []forecastPoint{{Date: today, Balance: round2(balance)}}
	for _, e := range events {
		balance += e.Amount
		series = append(series, forecastPoint{Date: e.Date, Balance: round2(balance)})
	}

	resp := forecastResponse{
		CashAccountID:   cashAccount.AccountID,
		StartingBalance: round2(startingBalance),
		AsOf:            today,
		HorizonDays:     days,
		Events:          events,
		Series:          series,
	}
	if !cashAccount.BalanceUpdatedAt.IsZero() {
		resp.BalanceUpdatedAt = cashAccount.BalanceUpdatedAt.Format("2006-01-02T15:04:05Z")
	}
	if resp.Events == nil {
		resp.Events = []forecastEvent{}
	}

	body, _ := json.Marshal(resp)
	return response{StatusCode: http.StatusOK, Body: string(body), Headers: jsonHeaders()}, nil
}

// fetchTxnCache fetches each account's transaction history for
// [startDate, endDate] in parallel and returns it keyed by accountID. Errors
// for an individual account are treated as "no transactions" rather than
// failing the whole request, matching the previous sequential behavior.
func fetchTxnCache(ctx context.Context, dbClient *dbpkg.Client, accounts []dbpkg.Account, startDate, endDate string) map[string][]dbpkg.Transaction {
	type result struct {
		accountID string
		txns      []dbpkg.Transaction
	}
	resultsCh := make(chan result, len(accounts))
	var wg sync.WaitGroup
	for _, acct := range accounts {
		wg.Add(1)
		go func(accountID string) {
			defer wg.Done()
			txns, err := dbClient.GetTransactions(ctx, accountID, startDate, endDate)
			if err != nil {
				txns = nil
			}
			resultsCh <- result{accountID: accountID, txns: txns}
		}(acct.AccountID)
	}
	wg.Wait()
	close(resultsCh)

	cache := make(map[string][]dbpkg.Transaction, len(accounts))
	for r := range resultsCh {
		cache[r.accountID] = r.txns
	}
	return cache
}

// findIncomeAnchor returns the date to project future paychecks from: the
// most recent rule-matched paycheck transaction across all accounts if one
// exists, otherwise the manual NextPayDateOverride fallback. ok=false means
// there's nothing to anchor a projection to yet.
func findIncomeAnchor(src dbpkg.IncomeSource, accounts []dbpkg.Account, txnCache map[string][]dbpkg.Transaction) (time.Time, bool) {
	budgetID := dbpkg.IncomeBudgetPrefix + src.IncomeSourceID

	var latest time.Time
	found := false
	for _, acct := range accounts {
		for _, t := range txnCache[acct.AccountID] {
			if t.Pending || t.BudgetID != budgetID {
				continue
			}
			d, err := time.Parse("2006-01-02", t.Date)
			if err != nil {
				continue
			}
			if !found || d.After(latest) {
				latest, found = d, true
			}
		}
	}
	if found {
		return latest, true
	}
	if src.NextPayDateOverride != "" {
		if d, err := time.Parse("2006-01-02", src.NextPayDateOverride); err == nil {
			return d, true
		}
	}
	return time.Time{}, false
}

// findFixedCostAnchor returns the date to project future occurrences from,
// preferring (in order): the most recent real matched transaction, the
// linked Rule's DayOfMonth applied to last month, or the manual
// DayOfMonthOverride fallback applied to last month.
// findFixedCostAnchor returns the date to project future occurrences from,
// preferring (in order): the most recent real matched transaction, the
// linked Rule's DayOfMonth applied to last month, or the manual
// DayOfMonthOverride fallback applied to last month. sourceAccountID is the
// account the matching transaction was found on ("" if anchored via a
// fallback rather than a real transaction) — used by the caller to decide
// whether this fixed cost draws directly from the cash account or is instead
// already accounted for inside a credit card's reconstructed payment amount.
func findFixedCostAnchor(fc dbpkg.MBFixedCost, ruleByID map[string]dbpkg.Rule, accounts []dbpkg.Account, txnCache map[string][]dbpkg.Transaction) (anchor time.Time, sourceAccountID string, ok bool) {
	var latest time.Time
	found := false
	latestAccountID := ""
	for _, acct := range accounts {
		for _, t := range txnCache[acct.AccountID] {
			if t.Pending || t.Synthetic || t.BudgetID != dbpkg.MasterBudgetID {
				continue
			}
			if matchesFixedCost(t, fc, ruleByID) {
				d, err := time.Parse("2006-01-02", t.Date)
				if err != nil {
					continue
				}
				if !found || d.After(latest) {
					latest, found = d, true
					latestAccountID = acct.AccountID
				}
			}
		}
	}
	if found {
		return latest, latestAccountID, true
	}

	now := time.Now()
	lastMonth := now.AddDate(0, -1, 0)
	if fc.RuleID != "" {
		if rule, ok := ruleByID[fc.RuleID]; ok && rule.DayOfMonth > 0 {
			return dateWithDay(lastMonth.Year(), lastMonth.Month(), rule.DayOfMonth), "", true
		}
	}
	if fc.DayOfMonthOverride > 0 {
		return dateWithDay(lastMonth.Year(), lastMonth.Month(), fc.DayOfMonthOverride), "", true
	}
	return time.Time{}, "", false
}

// filterTxnsByDate returns the subset of txns whose Date falls within
// [startDate, endDate] (inclusive), both "2006-01-02" formatted. Used to
// narrow an already-fetched 1-year transaction cache down to the shorter
// lookback window credit card cycle reconstruction needs, without an extra
// DynamoDB query.
func filterTxnsByDate(txns []dbpkg.Transaction, startDate, endDate string) []dbpkg.Transaction {
	out := make([]dbpkg.Transaction, 0, len(txns))
	for _, t := range txns {
		if t.Date >= startDate && t.Date <= endDate {
			out = append(out, t)
		}
	}
	return out
}

// projectDates returns each future occurrence date, strictly after `now`,
// through `horizonEnd`, projecting forward from `anchor` at the given
// frequency. Monthly-family cadences preserve day-of-month (clamped for
// shorter months) rather than assuming a fixed day-count interval.
func projectDates(anchor time.Time, frequency string, now, horizonEnd time.Time) []time.Time {
	switch frequency {
	case "weekly":
		return projectByDayInterval(anchor, now, horizonEnd, 7)
	case "biweekly":
		return projectByDayInterval(anchor, now, horizonEnd, 14)
	case "semimonthly":
		// Approximate: real semimonthly schedules are usually calendar-anchored
		// (e.g. 1st & 15th) but we only have a single anchor date to work
		// from, so every 15 days is a reasonable approximation.
		return projectByDayInterval(anchor, now, horizonEnd, 15)
	case "quarterly":
		return projectByMonthStep(anchor, now, horizonEnd, 3)
	case "semiannually":
		return projectByMonthStep(anchor, now, horizonEnd, 6)
	case "annually":
		return projectByMonthStep(anchor, now, horizonEnd, 12)
	default: // "monthly"
		return projectByMonthStep(anchor, now, horizonEnd, 1)
	}
}

func projectByDayInterval(anchor, now, horizonEnd time.Time, stepDays int) []time.Time {
	var out []time.Time
	d := anchor
	// Fast-forward past `now` without accumulating one iteration at a time
	// for anchors far in the past.
	if d.Before(now) {
		missedSteps := int(now.Sub(d).Hours()/24) / stepDays
		d = d.AddDate(0, 0, missedSteps*stepDays)
	}
	for !d.After(now) {
		d = d.AddDate(0, 0, stepDays)
	}
	for !d.After(horizonEnd) {
		out = append(out, d)
		d = d.AddDate(0, 0, stepDays)
	}
	return out
}

// projectByMonthStep projects forward from anchor in increments of
// stepMonths, preserving the original day-of-month (clamped for shorter
// months) each time via absolute month-index arithmetic — avoiding drift
// that repeated AddDate clamping would otherwise introduce.
func projectByMonthStep(anchor, now, horizonEnd time.Time, stepMonths int) []time.Time {
	day := anchor.Day()
	idx := anchor.Year()*12 + int(anchor.Month()) - 1

	var out []time.Time
	for {
		y := idx / 12
		m := time.Month(idx%12 + 1)
		d := dateWithDay(y, m, day)
		if d.After(horizonEnd) {
			break
		}
		if d.After(now) {
			out = append(out, d)
		}
		idx += stepMonths
	}
	return out
}

// dateWithDay returns the given day within (year, month), clamping to the
// last valid day of that month (e.g. day=31 in February clamps to 28/29).
func dateWithDay(year int, month time.Month, day int) time.Time {
	firstOfNext := time.Date(year, month+1, 1, 0, 0, 0, 0, time.UTC)
	lastDay := firstOfNext.AddDate(0, 0, -1).Day()
	if day > lastDay {
		day = lastDay
	}
	return time.Date(year, month, day, 0, 0, 0, 0, time.UTC)
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }

// matchesFixedCost is duplicated from apply-rules/get-variance-detail to keep
// this Lambda self-contained.
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

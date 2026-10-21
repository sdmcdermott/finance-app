package db

// Credit card billing cycle reconstruction for cash flow forecasting.
//
// Plaid's Liabilities product (which returns next_payment_due_date and
// minimum_payment_amount directly) is not used here — it's a separate
// subscription-billed product, unavailable on Trial plans, and can't be
// added to an existing Item without a full re-link. Instead, this infers a
// credit card's billing cycle purely from data already synced via the
// Transactions product: the card's own transaction history.
//
// Plaid represents credit card charges as positive amounts and credits
// (payments, refunds, statement credits) as negative amounts. Critically,
// NOT every negative-amount transaction is a statement payment — merchant
// refunds (e.g. "AMAZON MKTPLACE PMTS" for a returned item) and card-benefit
// credits (e.g. "AMEX RIDESHARE CREDIT") are also negative, and in practice
// can vastly outnumber actual bill payments. Validated against six real
// linked cards, genuine statement payments are reliably identified by name
// patterns issuers use consistently ("AUTOPAY", "AUTOMATIC PAYMENT",
// "PAYMENT MADE BY"), whereas merchant refunds never match these — so
// payment detection here is name-pattern-based, not purely sign-based.
//
// The fixed anchor is the PAYMENT DUE DAY, not the statement close day.
// Regulation Z (TILA) requires card issuers to use a fixed due date (the
// same numbered day every month) — but the statement close date is NOT
// fixed: it's simply "due date minus the grace period", and since months
// have different lengths, that lands on a different day-of-month each
// cycle. E.g. a card with due day 4 and a 25-26 day grace period might
// close 2/6 (close date = due 3/4 minus grace) for one statement and 3/10
// (close date = due 4/4 minus grace) for the next — a 4-day swing in close
// day despite the due day never changing. The statement's billing period
// START, in turn, is exactly one calendar month before its close date,
// measured in THAT close month's own length (e.g. a cycle closing in
// February spans exactly 28/29 days; one closing in March spans 31) — this
// is what produces the billing period shown on a real statement. An earlier
// version of this code incorrectly treated the close day as the fixed
// anchor and projected it forward via a fixed assumed cycle length, which
// drifts out of sync with real statements over time; see cycleForDueDate
// and projectNextCycle below for the corrected model.
//
// Assuming the card is paid in full each cycle, a payment's amount should
// equal the NET of all other transactions (charges minus any merchant
// refunds/credits, which reduce what's owed the same way they would on a
// real statement) in the billing window implied by the payment's own date
// (treated as the due date) and a candidate grace period. The grace period
// is unknown and searched for (rather than assumed), because real-world
// Plaid data has enough day-to-day noise (e.g. Date vs. AuthorizedDate
// discrepancies) that optimizing each payment independently produces an
// unstable, inconsistent "best fit" per month. Instead we search for the
// SINGLE (date field, grace period) combination that minimizes total error
// across ALL historical payments at once — a global least-error fit — which
// is far more robust to per-month noise than requiring every individual
// cycle to match independently.
//
// If no combination fits well across a majority of historical payments
// (e.g. the user carries a balance and pays only part of it, so no
// consistent full-statement pattern exists), we fall back to clustering the
// payment events themselves by day-of-month + amount — conceptually the
// same heuristic used by SuggestFixedCosts — yielding an approximate
// recurring "card payment" prediction instead of a precise statement
// reconstruction.
//
// As an alternative to both the automatic heuristic above and blind manual
// entry of a due-day/grace-period pair, users can instead answer a small
// guided Q&A using real data straight off their last few statements (billing
// period end date + payment due date) — see ValidateGuidedCycle. Those are
// concrete numbers anyone can read off a statement, and letting the app
// compute the grace period/due day via subtraction (median across entries)
// is both easier and, since it's validated against the account's own
// already-synced transactions, catches typos rather than blindly trusting
// hand-entered numbers.

import (
	"errors"
	"math"
	"sort"
	"strings"
	"time"
)

var (
	errTooFewEntries  = errors.New("at least 2 statement entries are required")
	errInvalidDate    = errors.New("invalid date format, expected YYYY-MM-DD")
	errDueBeforeClose = errors.New("due date must be after the billing period close date")
)

// ccPaymentKeywords are name substrings (checked case-insensitively) that
// reliably identify a genuine statement payment across issuers, validated
// against real linked card data. Deliberately conservative/specific so
// merchant refunds and card-benefit credits (which are also negative-amount)
// are never misclassified as payments.
var ccPaymentKeywords = []string{
	"AUTOPAY",
	"AUTOMATIC PAYMENT",
	"PAYMENT MADE BY",
}

// LooksLikeStatementPayment returns true if name matches a known statement
// payment pattern. Exported for reuse by diagnostic/debug tooling.
func LooksLikeStatementPayment(name string) bool {
	upper := strings.ToUpper(name)
	for _, kw := range ccPaymentKeywords {
		if strings.Contains(upper, kw) {
			return true
		}
	}
	return false
}

// CCTxnSummary is a single transaction's date/label/amount, used to show
// callers (e.g. the cash flow forecast UI) exactly which transactions fed
// into a reconstructed or approximated payment amount.
type CCTxnSummary struct {
	Date   string  // YYYY-MM-DD
	Label  string  // merchant name (falls back to raw transaction name)
	Amount float64 // Plaid convention: positive = charge, negative = credit
}

// CCCycleResult is the outcome of reconstructing a credit card's billing
// cycle from its own transaction history.
type CCCycleResult struct {
	Confidence string // "high" | "low" | "none" | "manual"

	// Populated when Confidence == "high" or "manual":
	// PaymentDueDay is the fixed day-of-month the payment is due (the one
	// constant anchor per Regulation Z — see package doc comment). The
	// statement close date is NOT fixed; it's derived from this due day via
	// cycleForDueDate below, and its day-of-month shifts cycle to cycle.
	PaymentDueDay   int
	GracePeriodDays int // days from statement close to payment due date
	// LastCloseDate is the exclusive start of the WindowTransactions window
	// below. When Confidence == "high" or "manual" it's the day before the
	// current in-progress billing period's start date; when Confidence ==
	// "low" (no fittable cycle) it's instead the most recent detected
	// payment date — there's no statement close to anchor to, so "since
	// your last payment" is the closest useful analog.
	LastCloseDate string
	NextCloseDate string // YYYY-MM-DD, next projected statement close date (Confidence == "high"/"manual" only)
	NextDueDate   string // YYYY-MM-DD, next projected payment due date (Confidence == "high"/"manual" only)
	// ProjectedNextPaymentAmount is the net of all transactions since the
	// last reconstructed close date through asOf — a floor, not a final
	// number, since more charges (or refunds) may post before the next close.
	// Populated when Confidence == "high" or "manual" only.
	ProjectedNextPaymentAmount float64
	// WindowTransactions are the individual charges/credits in
	// (LastCloseDate, asOf], sorted ascending by date. When Confidence ==
	// "high" or "manual" these sum to ProjectedNextPaymentAmount. When
	// Confidence == "low" these are simply what's posted since the last
	// detected payment — informational only, since there's no reliable
	// amount to reconcile them against (see FallbackMeanAmount).
	WindowTransactions []CCTxnSummary

	// Populated when Confidence == "low" (fallback): mean day-of-month and
	// mean amount across all historical payment events, treated like an
	// ordinary recurring cost rather than a precise statement reconstruction.
	FallbackMeanDay    int
	FallbackMeanAmount float64
	// HistoricalPayments are the actual past statement payment transactions
	// (positive dollar amounts) averaged to produce FallbackMeanAmount,
	// sorted ascending by date. Kept for diagnostics; the forecast UI shows
	// WindowTransactions instead (see above).
	HistoricalPayments []CCTxnSummary

	// Diagnostic info, useful for validating against real data.
	PaymentsConsidered int
	PaymentsFit        int
}

type ccTxn struct {
	date      time.Time // posted date (used for payment dating)
	authDate  time.Time // authorized date, falls back to posted date if absent
	label     string    // merchant name, falls back to raw transaction name
	amt       float64   // signed, Plaid convention: positive = charge, negative = credit
	isPayment bool
}

const (
	graceMin = 15
	graceMax = 32
	// maxCycleLen is the longest a billing cycle can possibly be (the
	// longest calendar month), used only to size the lookback margin
	// required before a payment can be tested — actual cycle length is
	// always derived per-cycle from the close month (see cycleForDueDate),
	// never assumed to be a fixed/searched value.
	maxCycleLen = 31
)

// buildCCTxns converts a raw Transaction slice into the internal ccTxn
// representation used throughout this file: parses dates, resolves the
// display label, flags statement payments, skips pending/synthetic entries,
// and sorts ascending by posted date.
func buildCCTxns(txns []Transaction) []ccTxn {
	var all []ccTxn
	for _, t := range txns {
		if t.Pending || t.Synthetic {
			continue
		}
		d, err := time.Parse("2006-01-02", t.Date)
		if err != nil {
			continue
		}
		ad := d
		if t.AuthorizedDate != "" {
			if parsed, err := time.Parse("2006-01-02", t.AuthorizedDate); err == nil {
				ad = parsed
			}
		}
		name := t.MerchantName
		if name == "" {
			name = t.Name
		}
		all = append(all, ccTxn{
			date:      d,
			authDate:  ad,
			label:     name,
			amt:       t.Amount,
			isPayment: t.Amount < 0 && LooksLikeStatementPayment(name),
		})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].date.Before(all[j].date) })
	return all
}

// windowTxns returns the individual non-payment transactions in
// (afterExclusive, throughInclusive], sorted ascending by date.
func windowTxns(all []ccTxn, useAuth bool, afterExclusive, throughInclusive time.Time) []CCTxnSummary {
	var out []CCTxnSummary
	for _, t := range all {
		if t.isPayment {
			continue
		}
		d := t.date
		if useAuth {
			d = t.authDate
		}
		if d.After(afterExclusive) && !d.After(throughInclusive) {
			out = append(out, CCTxnSummary{Date: d.Format("2006-01-02"), Label: t.label, Amount: t.amt})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Date < out[j].Date })
	return out
}

// netAmountOwed computes the net amount owed for a cycle using two
// DIFFERENT windows depending on transaction sign — debits (charges, amt >
// 0) are counted only within (debitAfterExclusive, debitThroughInclusive],
// the narrower statement period; credits (refunds/payments-in-kind, amt <
// 0) are counted within [creditFromInclusive, creditBeforeExclusive), a
// wider window keyed to payment due dates rather than statement close
// dates. Real-world card issuers appear to apply a credit against whichever
// payment is next due as soon as it posts, even if it posts after the
// statement already closed — so a credit landing anywhere from the
// previous payment's due date up to (but not including) this payment's due
// date reduces THIS payment's amount, not necessarily the statement period
// it happens to fall within. Statement payments themselves are always
// excluded from both sums (see HistoricalPayments/matched-payment handling
// instead).
func netAmountOwed(
	all []ccTxn, useAuth bool,
	debitAfterExclusive, debitThroughInclusive time.Time,
	creditFromInclusive, creditBeforeExclusive time.Time,
) float64 {
	var sum float64
	for _, t := range all {
		if t.isPayment {
			continue
		}
		d := t.date
		if useAuth {
			d = t.authDate
		}
		if t.amt > 0 {
			if d.After(debitAfterExclusive) && !d.After(debitThroughInclusive) {
				sum += t.amt
			}
		} else if t.amt < 0 {
			if !d.Before(creditFromInclusive) && d.Before(creditBeforeExclusive) {
				sum += t.amt
			}
		}
	}
	return sum
}

// windowTxnsOwed is windowTxns' asymmetric-window counterpart — returns the
// individual transactions that feed into netAmountOwed's two windows (both
// debits in the statement-period window and credits in the due-date-keyed
// window), sorted ascending by date.
func windowTxnsOwed(
	all []ccTxn, useAuth bool,
	debitAfterExclusive, debitThroughInclusive time.Time,
	creditFromInclusive, creditBeforeExclusive time.Time,
) []CCTxnSummary {
	var out []CCTxnSummary
	for _, t := range all {
		if t.isPayment {
			continue
		}
		d := t.date
		if useAuth {
			d = t.authDate
		}
		if t.amt > 0 {
			if d.After(debitAfterExclusive) && !d.After(debitThroughInclusive) {
				out = append(out, CCTxnSummary{Date: d.Format("2006-01-02"), Label: t.label, Amount: t.amt})
			}
		} else if t.amt < 0 {
			if !d.Before(creditFromInclusive) && d.Before(creditBeforeExclusive) {
				out = append(out, CCTxnSummary{Date: d.Format("2006-01-02"), Label: t.label, Amount: t.amt})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Date < out[j].Date })
	return out
}

func withinTolerance(actual, expected float64) bool {
	tol := math.Max(2.0, math.Abs(expected)*0.01)
	return math.Abs(actual-expected) <= tol
}

// capDebitThrough returns the correct upper bound for a cycle's debit
// window: asOf, unless the cycle's own close date (nextClose) has already
// passed, in which case nextClose — anything posted after a statement
// actually closed belongs to the FOLLOWING cycle, not this one, even if
// that following cycle's due date (and thus "next due" search) hasn't
// happened yet. Credits don't need this cap: their window's exclusive
// upper bound (the due date) is always strictly after asOf (see
// nextDueAfter), so no transaction data exists beyond asOf anyway.
func capDebitThrough(asOf, nextClose time.Time) time.Time {
	if nextClose.Before(asOf) {
		return nextClose
	}
	return asOf
}

// ReconstructCreditCardCycle infers a credit card's billing cycle from its
// own transaction history. txns should be the full available history for a
// single credit-type account — recommended at least 7-8 months, since
// reconstructing the OLDEST testable payment's cycle requires a further
// ~2 months of data before it. asOf is normally time.Now() but is a
// parameter to keep this function pure/testable.
func ReconstructCreditCardCycle(txns []Transaction, asOf time.Time) CCCycleResult {
	all := buildCCTxns(txns)

	if len(all) == 0 {
		return CCCycleResult{Confidence: "none"}
	}
	earliest := all[0].date

	var payments []ccTxn
	for _, t := range all {
		if t.isPayment {
			payments = append(payments, t)
		}
	}

	if len(payments) < 2 {
		return CCCycleResult{Confidence: "none", PaymentsConsidered: len(payments)}
	}

	// Only test payments for which a full prior cycle + grace period of data
	// is actually available — otherwise the "sum" is artificially low simply
	// because history got truncated, not because the cycle doesn't fit.
	maxLookback := graceMax + maxCycleLen
	var testPayments []ccTxn
	for _, p := range payments {
		if p.date.Sub(earliest).Hours()/24 >= float64(maxLookback) {
			testPayments = append(testPayments, p)
		}
	}
	if len(testPayments) > 8 {
		testPayments = testPayments[len(testPayments)-8:]
	}
	if len(testPayments) < 2 {
		testPayments = payments // not enough margin; fall back to using what we have
	}

	// Global least-error search: find the single (date field, grace period)
	// combination minimizing total absolute error across ALL test payments
	// at once, rather than optimizing each payment independently (which is
	// unstable — see package doc comment above). Each historical payment's
	// own date is treated as that cycle's due date (Regulation Z requires
	// issuers to actually pay on the fixed due date), and the cycle
	// start/end are derived from it via cycleForDueDate — there is no
	// separate "cycle length" to search for, since it's fully determined by
	// the close date's own month length.
	type candidate struct {
		useAuth  bool
		grace    int
		totalErr float64
		fitCount int
		dueDays  []int
	}
	var best *candidate

	for _, useAuth := range []bool{false, true} {
		for g := graceMin; g <= graceMax; g++ {
			c := candidate{useAuth: useAuth, grace: g}
			for _, p := range testPayments {
				amount := -p.amt
				cycleStart, cycleEnd := cycleForDueDate(p.date, g)
				prevDue := prevDueDate(p.date)
				sum := netAmountOwed(all, useAuth, cycleStart.AddDate(0, 0, -1), cycleEnd, prevDue, p.date)
				c.totalErr += math.Abs(sum - amount)
				if withinTolerance(sum, amount) {
					c.fitCount++
					c.dueDays = append(c.dueDays, p.date.Day())
				}
			}
			if best == nil || c.totalErr < best.totalErr {
				best = &c
			}
		}
	}

	minRequired := int(math.Ceil(float64(len(testPayments)) * 0.6))
	if minRequired < 2 {
		minRequired = 2
	}

	if best != nil && best.fitCount >= minRequired {
		dueDay := medianInt(best.dueDays)
		result := CCCycleResult{
			Confidence:         "high",
			PaymentDueDay:      dueDay,
			GracePeriodDays:    best.grace,
			PaymentsConsidered: len(testPayments),
			PaymentsFit:        best.fitCount,
		}
		useAuth := best.useAuth
		sumFn := func(debitAfter, debitThrough, creditFrom, creditBefore time.Time) float64 {
			return netAmountOwed(all, useAuth, debitAfter, debitThrough, creditFrom, creditBefore)
		}
		lastClose, nextClose, nextDue, projected := projectNextCycle(dueDay, best.grace, asOf, sumFn)
		result.LastCloseDate = lastClose.Format("2006-01-02")
		result.NextCloseDate = nextClose.Format("2006-01-02")
		result.NextDueDate = nextDue.Format("2006-01-02")
		result.ProjectedNextPaymentAmount = projected
		creditFrom := prevDueDate(nextDue)
		result.WindowTransactions = windowTxnsOwed(all, useAuth, lastClose, capDebitThrough(asOf, nextClose), creditFrom, nextDue)
		return result
	}

	// ── Fallback: cluster payment events by day-of-month + amount ───────────
	var daySum, amtSum float64
	var historicalPayments []CCTxnSummary
	for _, p := range payments {
		daySum += float64(p.date.Day())
		amtSum += -p.amt
		historicalPayments = append(historicalPayments, CCTxnSummary{Date: p.date.Format("2006-01-02"), Label: p.label, Amount: -p.amt})
	}
	n := float64(len(payments))
	fitCount := 0
	if best != nil {
		fitCount = best.fitCount
	}

	// No consistent statement cycle could be fit, so there's no "correct"
	// billing window to point to — but we can still show something useful:
	// the actual charges/credits posted since the most recent detected
	// payment through asOf. This won't necessarily sum to FallbackMeanAmount
	// (that's a historical average, not a literal running total), but it's a
	// concrete, actionable answer to "what's accruing on this card right
	// now" rather than a list of old lump-sum payment totals.
	lastPaymentDate := payments[len(payments)-1].date
	return CCCycleResult{
		Confidence:         "low",
		LastCloseDate:      lastPaymentDate.Format("2006-01-02"),
		WindowTransactions: windowTxns(all, false, lastPaymentDate, asOf),
		FallbackMeanDay:    int(math.Round(daySum / n)),
		FallbackMeanAmount: math.Round(amtSum/n*100) / 100,
		HistoricalPayments: historicalPayments,
		PaymentsConsidered: len(testPayments),
		PaymentsFit:        fitCount,
	}
}

// ReconstructCreditCardCycleManual computes a credit card's projected next
// payment using a user-supplied payment due day + grace period, instead of
// searching for a best fit. Used when the automatic heuristic falls back to
// "low" confidence (or the user simply prefers to enter their own known
// values, e.g. read straight off a paper/PDF statement).
func ReconstructCreditCardCycleManual(txns []Transaction, asOf time.Time, paymentDueDay, gracePeriodDays int) CCCycleResult {
	all := buildCCTxns(txns)
	result := CCCycleResult{
		Confidence:      "manual",
		PaymentDueDay:   paymentDueDay,
		GracePeriodDays: gracePeriodDays,
	}
	sumFn := func(debitAfter, debitThrough, creditFrom, creditBefore time.Time) float64 {
		return netAmountOwed(all, false, debitAfter, debitThrough, creditFrom, creditBefore)
	}
	lastClose, nextClose, nextDue, projected := projectNextCycle(paymentDueDay, gracePeriodDays, asOf, sumFn)
	result.LastCloseDate = lastClose.Format("2006-01-02")
	result.NextCloseDate = nextClose.Format("2006-01-02")
	result.NextDueDate = nextDue.Format("2006-01-02")
	result.ProjectedNextPaymentAmount = projected
	creditFrom := prevDueDate(nextDue)
	result.WindowTransactions = windowTxnsOwed(all, false, lastClose, capDebitThrough(asOf, nextClose), creditFrom, nextDue)
	return result
}

// ManualStatementEntry is one real statement's billing-period-end date and
// payment due date, as read directly off a card statement by the user —
// the raw input to ValidateGuidedCycle.
type ManualStatementEntry struct {
	CloseDate string // YYYY-MM-DD, the statement's billing period end date
	DueDate   string // YYYY-MM-DD, the payment due date for that statement
}

// GuidedCycleEntry describes how well one consecutive pair of entered
// statements' implied billing window matches the account's own synced
// transaction history.
type GuidedCycleEntry struct {
	CloseDate            string  // the later of the two close dates bounding this window
	DueDate              string  // the entered due date for this statement
	WindowSum            float64 // net amount owed for this window (see netAmountOwed)
	MatchedPaymentDate   string  // nearest actual statement-payment transaction found near DueDate, if any
	MatchedPaymentAmount float64
	Matched              bool // true if WindowSum is within tolerance of MatchedPaymentAmount
}

// GuidedCycleResult is the outcome of ValidateGuidedCycle.
type GuidedCycleResult struct {
	SuggestedPaymentDueDay   int
	SuggestedGracePeriodDays int
	Entries                  []GuidedCycleEntry
	MatchCount               int
	TotalCycles              int
}

// ValidateGuidedCycle derives a payment due day + grace period from a small
// set of real statements (billing-period-end date + payment due date, as
// read directly off the statements by the user), then cross-checks the
// derived cycle against the account's own already-synced transactions: for
// each consecutive pair of entered statements, it computes the net amount
// owed (see netAmountOwed — debits within the statement period, credits
// within the wider previous-due-date-to-this-due-date window) and checks
// whether that's within tolerance of the nearest actual statement-payment
// transaction found near the corresponding due date. This can't validate
// the very first entry (there's no earlier close/due date to bound its
// window), so N entries yield N-1 validatable cycles — at least 2 entries
// are required.
func ValidateGuidedCycle(txns []Transaction, entries []ManualStatementEntry) (GuidedCycleResult, error) {
	if len(entries) < 2 {
		return GuidedCycleResult{}, errTooFewEntries
	}

	type parsed struct {
		close time.Time
		due   time.Time
	}
	var ps []parsed
	for _, e := range entries {
		c, err := time.Parse("2006-01-02", e.CloseDate)
		if err != nil {
			return GuidedCycleResult{}, errInvalidDate
		}
		d, err := time.Parse("2006-01-02", e.DueDate)
		if err != nil {
			return GuidedCycleResult{}, errInvalidDate
		}
		if !d.After(c) {
			return GuidedCycleResult{}, errDueBeforeClose
		}
		ps = append(ps, parsed{close: c, due: d})
	}
	sort.Slice(ps, func(i, j int) bool { return ps[i].close.Before(ps[j].close) })

	// The due day is the fixed anchor (see package doc comment), so it's
	// just the entered due dates' own day-of-month — no derivation needed,
	// unlike the close day, which legitimately varies cycle to cycle.
	var dueDays, graceDays []int
	for _, p := range ps {
		dueDays = append(dueDays, p.due.Day())
		graceDays = append(graceDays, int(p.due.Sub(p.close).Hours()/24))
	}
	suggestedPaymentDueDay := medianInt(dueDays)
	suggestedGrace := medianInt(graceDays)

	all := buildCCTxns(txns)
	var payments []ccTxn
	for _, t := range all {
		if t.isPayment {
			payments = append(payments, t)
		}
	}

	// Find the nearest actual statement-payment transaction within 5 days
	// of each entered due date, to check the computed window sum against a
	// real payment rather than trusting the entry blindly.
	var matchCount int
	var out []GuidedCycleEntry
	for i := 1; i < len(ps); i++ {
		prevClose := ps[i-1].close
		close := ps[i].close
		// Credits use a wider window keyed to the user's own entered due
		// dates rather than close dates — see netAmountOwed's doc comment
		// for why. Using the REAL entered previous due date here (rather
		// than deriving one via prevDueDate) matches the guided method's
		// whole premise of trusting actual statement dates over assumptions.
		prevDue := ps[i-1].due
		due := ps[i].due

		sum := netAmountOwed(all, false, prevClose, close, prevDue, due)
		entry := GuidedCycleEntry{
			CloseDate: ps[i].close.Format("2006-01-02"),
			DueDate:   ps[i].due.Format("2006-01-02"),
			WindowSum: sum,
		}

		var nearest *ccTxn
		var nearestDist float64
		for pi := range payments {
			dist := math.Abs(payments[pi].date.Sub(due).Hours() / 24)
			if dist > 5 {
				continue
			}
			if nearest == nil || dist < nearestDist {
				nearest = &payments[pi]
				nearestDist = dist
			}
		}
		if nearest != nil {
			entry.MatchedPaymentDate = nearest.date.Format("2006-01-02")
			entry.MatchedPaymentAmount = -nearest.amt
			entry.Matched = withinTolerance(sum, -nearest.amt)
			if entry.Matched {
				matchCount++
			}
		}
		out = append(out, entry)
	}

	return GuidedCycleResult{
		SuggestedPaymentDueDay:   suggestedPaymentDueDay,
		SuggestedGracePeriodDays: suggestedGrace,
		Entries:                  out,
		MatchCount:               matchCount,
		TotalCycles:              len(ps) - 1,
	}, nil
}

// cycleForDueDate derives a statement's close date and billing-period start
// date from its (fixed-anchor) payment due date and a grace period. The
// close date is simply due date minus the grace period. The cycle start is
// exactly one calendar month before the close date, measured in the CLOSE
// date's own month length — e.g. a cycle closing 2/6 spans exactly 28 days
// back to 1/10 (February has 28 days in a non-leap year), while one closing
// 3/10 spans 31 days back to 2/7 (March has 31 days) — matching what real
// statements show, since the close day of month is not itself fixed (see
// package doc comment for the full explanation).
func cycleForDueDate(dueDate time.Time, gracePeriodDays int) (cycleStart, cycleEnd time.Time) {
	cycleEnd = dueDate.AddDate(0, 0, -gracePeriodDays)
	cycleStart = cycleEnd.AddDate(0, 0, -(daysInMonth(cycleEnd.Year(), cycleEnd.Month()) - 1))
	return
}

// nextDueAfter returns the next occurrence of the fixed payment due day
// strictly after asOf.
func nextDueAfter(asOf time.Time, paymentDueDay int) time.Time {
	candidate := dateWithDay(asOf.Year(), asOf.Month(), paymentDueDay)
	if candidate.After(asOf) {
		return candidate
	}
	next := asOf.AddDate(0, 1, 0)
	return dateWithDay(next.Year(), next.Month(), paymentDueDay)
}

// prevDueDate returns the payment due date exactly one calendar month
// before due, preserving the same day-of-month (clamped for shorter
// months) — the due day is the fixed anchor (see package doc comment), so
// the previous cycle's due date is always exactly one month earlier.
func prevDueDate(due time.Time) time.Time {
	day := due.Day()
	// time.Date normalizes month=0 to December of the prior year, so this
	// correctly rolls under a year boundary (e.g. due in January).
	firstOfPrevMonth := time.Date(due.Year(), due.Month()-1, 1, 0, 0, 0, 0, time.UTC)
	return dateWithDay(firstOfPrevMonth.Year(), firstOfPrevMonth.Month(), day)
}

// projectNextCycle finds the next occurrence of the payment due day
// strictly after asOf, derives that cycle's close/start dates from it (see
// cycleForDueDate), and returns: lastClose (the exclusive start of the
// current in-progress window — the day before the cycle's start date),
// nextClose (the cycle's statement close date), nextDue (the due date
// itself), and the net amount owed so far — debits since lastClose through
// asOf (a running floor for the next statement's likely amount, since the
// cycle may not be finished yet) plus credits since the PREVIOUS payment's
// due date through asOf (see netAmountOwed's doc comment for why credits
// use a different window than debits).
func projectNextCycle(
	paymentDueDay, gracePeriodDays int,
	asOf time.Time,
	netAmountOwed func(debitAfterExclusive, debitThroughInclusive, creditFromInclusive, creditBeforeExclusive time.Time) float64,
) (lastClose, nextClose, nextDue time.Time, projectedAmount float64) {
	nextDue = nextDueAfter(asOf, paymentDueDay)
	cycleStart, cycleEnd := cycleForDueDate(nextDue, gracePeriodDays)
	nextClose = cycleEnd
	lastClose = cycleStart.AddDate(0, 0, -1)
	creditFrom := prevDueDate(nextDue)
	projectedAmount = netAmountOwed(lastClose, capDebitThrough(asOf, nextClose), creditFrom, nextDue)
	return
}

// daysInMonth returns the number of days in the given (year, month).
func daysInMonth(year int, month time.Month) int {
	firstOfNext := time.Date(year, month+1, 1, 0, 0, 0, 0, time.UTC)
	return firstOfNext.AddDate(0, 0, -1).Day()
}

// dateWithDay returns the given day within (year, month), clamping to the
// last valid day of that month (e.g. day=31 in February clamps to 28/29).
func dateWithDay(year int, month time.Month, day int) time.Time {
	lastDay := daysInMonth(year, month)
	if day > lastDay {
		day = lastDay
	}
	return time.Date(year, month, day, 0, 0, 0, 0, time.UTC)
}

func medianInt(vals []int) int {
	if len(vals) == 0 {
		return 0
	}
	sorted := append([]int(nil), vals...)
	sort.Ints(sorted)
	return sorted[len(sorted)/2]
}

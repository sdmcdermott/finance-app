package main

// find-refunds scans all transactions and finds probable refund pairs:
// a credit (amount < 0) that was likely a return of an earlier debit from
// the same merchant.
//
// Match rules:
//   - Same merchant (substring match in either direction, min key length 3; falls back to exact match)
//   - Credit occurred AFTER the debit, within 90 days (Amazon: debit may post up to 30 days after credit)
//   - Exact amount match AND credit after debit → "confident"
//   - Exact amount match BUT credit before debit → "ambiguous" (rare; please verify)
//   - 0 < debit − |credit| ≤ $5.00                              → "ambiguous"
//   - debit − |credit| > $5.00 AND debit has a Note             → "partial" (Amazon partial return)
//   - 2+ debits satisfy the above for one credit                 → "multi"
//   - All candidates are included so user can override pre-selection.
//   - Already-linked credits (LinkedOriginalId is set) are excluded from the report.
//   - Debits whose remaining unrefunded amount would be exceeded are excluded.
//   - Within-batch duplicates that would over-refund a debit are downgraded to ambiguous.
//   - Credit occurred AFTER the debit, within 90 days
//   - Exact:    |debit.amount - |credit.amount|| == 0           → "confident"
//   - Ambiguous: 0 < debit.amount - |credit.amount| ≤ $5.00    → "ambiguous"
//     (debit slightly larger accounts for restocking/shipping fees)
//   - Partial:  debit.amount - |credit.amount| > $5.00 AND debit has a Note
//     (Amazon-linked order; credit is a partial item return)    → "partial"
//   - Multi:    2+ debits satisfy the above for one credit       → "multi"
//
// Already-linked credits (LinkedOriginalId is set) are excluded from the report.
// Already-linked debits are NOT excluded — a debit may have multiple partial refunds.
// A debit is only skipped for a specific credit if they are already linked to each other.

import (
	"context"
	"encoding/json"
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

const (
	ambiguousTolerance = 5.00 // debit may exceed credit by up to this (restocking fee)
	lookbackDays       = 90   // how far back a debit can precede a credit
	amazonLeadDays     = 30   // Amazon-linked debits may post up to this many days AFTER the credit
	// (multi-shipment orders: refund sometimes settles before final charge)
)

// RefundStatus indicates confidence of the match.
type RefundStatus string

const (
	StatusConfident RefundStatus = "confident" // exactly 1 debit candidate, exact $ match
	StatusAmbiguous RefundStatus = "ambiguous" // exactly 1 debit candidate, debit slightly larger (≤$5)
	StatusPartial   RefundStatus = "partial"   // exactly 1 debit candidate with a note; credit is a partial item return
	StatusMulti     RefundStatus = "multi"     // 2+ debit candidates — user must pick one
)

// RefundCandidate is a trimmed view of a debit transaction used in match results.
// Only the fields needed by the frontend are included to keep response size small.
type RefundCandidate struct {
	DateTransactionID string  `json:"dateTransactionId"`
	Date              string  `json:"date"`
	Amount            float64 `json:"amount"`
	MerchantName      string  `json:"merchantName,omitempty"`
	Name              string  `json:"name,omitempty"`
	CustomName        string  `json:"customName,omitempty"`
	Note              string  `json:"note,omitempty"`
	CustomCategory    string  `json:"customCategory,omitempty"`
	BudgetID          string  `json:"budgetId,omitempty"`
}

// RefundMatch is one row in the report: one credit and its debit candidate(s).
type RefundMatch struct {
	Credit     dbpkg.Transaction `json:"credit"`
	Status     RefundStatus      `json:"status"`
	Candidates []RefundCandidate `json:"candidates"` // ≥1 for all statuses
	Note       string            `json:"note"`
}

func toCandidate(t dbpkg.Transaction) RefundCandidate {
	return RefundCandidate{
		DateTransactionID: t.DateTransactionID,
		Date:              t.Date,
		Amount:            t.Amount,
		MerchantName:      t.MerchantName,
		Name:              t.Name,
		CustomName:        t.CustomName,
		Note:              t.Note,
		CustomCategory:    t.CustomCategory,
		BudgetID:          t.BudgetID,
	}
}

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil {
		return *deny, nil
	}

	userID := plaidclient.UserID()
	dbClient, err := dbpkg.New(ctx)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	accounts, err := dbClient.GetAccounts(ctx, userID)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	// Load all non-pending, non-synthetic transactions across all accounts.
	var allTxns []dbpkg.Transaction
	for _, acct := range accounts {
		if !dbpkg.AccountEnabled(acct) {
			continue
		}
		txns, err := dbClient.GetTransactions(ctx, acct.AccountID, "2000-01-01", "2999-12-31")
		if err != nil {
			continue
		}
		for _, t := range txns {
			if !t.Pending && !t.Synthetic {
				allTxns = append(allTxns, t)
			}
		}
	}

	matches := findRefunds(allTxns)

	// If a specific creditId was requested, filter to just that match.
	if creditID := req.QueryStringParameters["creditId"]; creditID != "" {
		filtered := make([]RefundMatch, 0)
		for _, m := range matches {
			if m.Credit.DateTransactionID == creditID {
				filtered = append(filtered, m)
				break
			}
		}
		matches = filtered
	}

	body, _ := json.Marshal(map[string]interface{}{
		"matches": matches,
		"total":   len(matches),
	})
	return response{StatusCode: http.StatusOK, Body: string(body), Headers: jsonHeaders()}, nil
}

// findRefunds pairs credits with their probable original debit(s).
func findRefunds(txns []dbpkg.Transaction) []RefundMatch {
	// Build a full lookup map for resolving LinkedRefundIds → amounts.
	txnByDTID := make(map[string]dbpkg.Transaction, len(txns))
	for _, t := range txns {
		txnByDTID[t.DateTransactionID] = t
	}

	// Separate credits and debits; skip already-linked transactions.
	var credits []dbpkg.Transaction
	var debits []dbpkg.Transaction
	for _, t := range txns {
		if t.LinkedOriginalId != "" {
			continue // already confirmed as a refund credit
		}
		if t.Amount < 0 {
			credits = append(credits, t)
		} else if t.Amount > 0 {
			debits = append(debits, t)
		}
	}

	// Collect all eligible debits as a flat slice for merchant-fuzzy matching.
	type debitEntry struct {
		txn dbpkg.Transaction
		key string
	}
	var allDebits []debitEntry
	for _, d := range debits {
		allDebits = append(allDebits, debitEntry{txn: d, key: merchantKey(d)})
	}

	// hitEntry carries a candidate together with metadata used for classification.
	type hitEntry struct {
		candidate         RefundCandidate
		creditBeforeDebit bool // true when the credit date precedes the debit date
	}

	var results []RefundMatch
	for _, credit := range credits {
		creditAbs := math.Abs(credit.Amount)
		creditDate, err := time.Parse("2006-01-02", credit.Date)
		if err != nil {
			continue
		}

		ck := merchantKey(credit)

		var hits []hitEntry
		for _, entry := range allDebits {
			if !merchantsMatch(ck, entry.key) {
				continue
			}
			// Skip this debit if it is already linked to this specific credit.
			alreadyLinked := false
			for _, id := range entry.txn.LinkedRefundIds {
				if id == credit.DateTransactionID {
					alreadyLinked = true
					break
				}
			}
			if alreadyLinked {
				continue
			}
			// Debit must be within the lookback window.
			// For Amazon-linked debits (Note set), also allow the debit to post
			// up to amazonLeadDays AFTER the credit (refund can settle before
			// the final shipment charge on multi-shipment orders).
			debitDate, err := time.Parse("2006-01-02", entry.txn.Date)
			if err != nil {
				continue
			}
			days := creditDate.Sub(debitDate).Hours() / 24
			if entry.txn.Note != "" {
				if days < -amazonLeadDays || days > lookbackDays {
					continue
				}
			} else {
				if days < 0 || days > lookbackDays {
					continue
				}
			}
			// Amount check: credit must not exceed what remains unrefunded on the debit.
			// Compute how much of the debit has already been refunded via persisted links.
			var alreadyRefunded float64
			for _, refID := range entry.txn.LinkedRefundIds {
				if refTxn, ok := txnByDTID[refID]; ok {
					alreadyRefunded += math.Abs(refTxn.Amount)
				}
			}
			remaining := entry.txn.Amount - alreadyRefunded
			if remaining <= 0 {
				continue // debit is already fully refunded
			}
			diff := remaining - creditAbs
			if diff < 0 {
				continue // this credit would over-refund the debit
			}
			hits = append(hits, hitEntry{
				candidate:         toCandidate(entry.txn),
				creditBeforeDebit: days < 0,
			})
		}

		if len(hits) == 0 {
			continue
		}

		// Helper: build a note for confident matches where the credit predates the debit.
		confidentNote := func(creditBefore bool) string {
			if creditBefore {
				return "Refund posted before the original charge — please verify."
			}
			return "Exact amount match."
		}
		confidentStatus := func(creditBefore bool) RefundStatus {
			if creditBefore {
				return StatusAmbiguous
			}
			return StatusConfident
		}

		candidates := make([]RefundCandidate, len(hits))
		for i, h := range hits {
			candidates[i] = h.candidate
		}

		switch len(hits) {
		case 1:
			h := hits[0]
			diff := h.candidate.Amount - creditAbs
			if diff == 0 {
				results = append(results, RefundMatch{
					Credit:     credit,
					Status:     confidentStatus(h.creditBeforeDebit),
					Candidates: candidates,
					Note:       confidentNote(h.creditBeforeDebit),
				})
			} else if diff > ambiguousTolerance && h.candidate.Note != "" {
				results = append(results, RefundMatch{
					Credit:     credit,
					Status:     StatusPartial,
					Candidates: candidates,
					Note:       "Partial refund — credit is less than the original Amazon charge.",
				})
			} else if diff > ambiguousTolerance {
				results = append(results, RefundMatch{
					Credit:     credit,
					Status:     StatusPartial,
					Candidates: candidates,
					Note:       "Partial refund — credit is less than the original charge.",
				})
			} else {
				results = append(results, RefundMatch{
					Credit:     credit,
					Status:     StatusAmbiguous,
					Candidates: candidates,
					Note:       "Original charge was slightly higher (possible restocking or return shipping fee).",
				})
			}
		default:
			// Among multiple candidates, prefer a single exact-amount match.
			// Keep ALL candidates so the user can override the pre-selection.
			var exactHits []hitEntry
			for _, h := range hits {
				if h.candidate.Amount-creditAbs == 0 {
					exactHits = append(exactHits, h)
				}
			}
			if len(exactHits) == 1 {
				// One exact match — confident (or ambiguous if credit precedes debit),
				// but include all candidates so the user can switch if needed.
				h := exactHits[0]
				// Re-order candidates so the exact match is first (frontend pre-selects index 0).
				ordered := []RefundCandidate{h.candidate}
				for _, c := range candidates {
					if c.DateTransactionID != h.candidate.DateTransactionID {
						ordered = append(ordered, c)
					}
				}
				results = append(results, RefundMatch{
					Credit:     credit,
					Status:     confidentStatus(h.creditBeforeDebit),
					Candidates: ordered,
					Note:       confidentNote(h.creditBeforeDebit),
				})
			} else {
				results = append(results, RefundMatch{
					Credit:     credit,
					Status:     StatusMulti,
					Candidates: candidates,
					Note:       "Multiple original transactions match — please pick one.",
				})
			}
		}
	}

	// Post-process: within this batch of matches, detect cases where multiple credits
	// reference the same debit and their combined total would exceed the debit amount.
	// Downgrade any over-budget matches to ambiguous.
	// Build a map: debitDTID → sorted list of match indices referencing it.
	type debitRef struct {
		matchIdx  int
		creditAbs float64
	}
	debitRefs := make(map[string][]debitRef)
	for i, m := range results {
		if len(m.Candidates) > 0 {
			// The first candidate is always the pre-selected / best match.
			debitRefs[m.Candidates[0].DateTransactionID] = append(
				debitRefs[m.Candidates[0].DateTransactionID],
				debitRef{matchIdx: i, creditAbs: math.Abs(m.Credit.Amount)},
			)
		}
	}
	for debitDTID, refs := range debitRefs {
		if len(refs) <= 1 {
			continue
		}
		debit, ok := txnByDTID[debitDTID]
		if !ok {
			continue
		}
		// Compute already-persisted refunds for this debit.
		var alreadyRefunded float64
		for _, refID := range debit.LinkedRefundIds {
			if refTxn, ok := txnByDTID[refID]; ok {
				alreadyRefunded += math.Abs(refTxn.Amount)
			}
		}
		// Walk the new credits in order; once cumulative total exceeds the debit, downgrade.
		running := alreadyRefunded
		for _, ref := range refs {
			running += ref.creditAbs
			if running > debit.Amount+ambiguousTolerance {
				m := results[ref.matchIdx]
				if m.Status == StatusConfident || m.Status == StatusAmbiguous {
					results[ref.matchIdx].Status = StatusAmbiguous
					results[ref.matchIdx].Note = "Total refunds for this charge may exceed the original amount — please verify."
				}
			}
		}
	}

	return results
}

// merchantKey returns a normalised key for merchant matching.
// Uses MerchantName if available, otherwise falls back to the transaction Name.
func merchantKey(t dbpkg.Transaction) string {
	if t.MerchantName != "" {
		return strings.ToLower(strings.TrimSpace(t.MerchantName))
	}
	return strings.ToLower(strings.TrimSpace(t.Name))
}

// merchantsMatch reports whether two normalised merchant keys refer to the same
// merchant. It uses substring containment in either direction so that truncated
// or decorated names (e.g. "amazon" vs "amazon mark* bg2t22p30") still match.
// A minimum key length of 3 is required on both sides to avoid spurious matches
// on very short tokens.
func merchantsMatch(a, b string) bool {
	if len(a) < 3 || len(b) < 3 {
		return a == b
	}
	return a == b || strings.Contains(a, b) || strings.Contains(b, a)
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

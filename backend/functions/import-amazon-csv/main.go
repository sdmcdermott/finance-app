package main

// import-amazon-csv parses an Amazon Order History CSV and attempts to match
// each order to Plaid transactions already stored in DynamoDB.
//
// The endpoint is read-only — it returns a match report but writes nothing.
// The user reviews the report in the UI and calls /import/amazon-csv/confirm
// to persist the chosen matches.
//
// Supported CSV formats:
//
//  1. Amazon Order History Report (legacy export):
//     "Order Date", "Order ID", "Order Total" / "Total Charged", "Title"
//
//  2. Amazon Order History Exporter Chrome extension:
//     "orderId", "orderPlaced", "total", "itemTitles" (pipe-separated),
//     "orderDetailsUrl", "shipmentStatus"
//
// Only Order ID, Order Date, and Amount columns are strictly required.
// Multiple item titles in a single cell are split on "|".

import (
	"context"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	auth "github.com/smcdermott/finance-app/internal/auth"
	dbpkg "github.com/smcdermott/finance-app/internal/db"
	plaidclient "github.com/smcdermott/finance-app/internal/plaid"
)

type response = events.APIGatewayV2HTTPResponse

// ── Types ────────────────────────────────────────────────────────────────────

// AmazonOrder represents one order after grouping CSV rows by Order ID.
type AmazonOrder struct {
	OrderID   string   `json:"orderId"`
	OrderDate string   `json:"orderDate"` // YYYY-MM-DD
	Amount    float64  `json:"amount"`    // total charged (dollars)
	Titles    []string `json:"titles"`    // item titles
	OrderURL  string   `json:"orderUrl"`  // deep link to order details
	Refunded  bool     `json:"refunded"`  // true when shipmentStatus contains "refund"
}

// MatchStatus indicates how confident the match is.
type MatchStatus string

const (
	StatusConfident MatchStatus = "confident" // exactly 1 txn ↔ 1 order
	StatusAmbiguous MatchStatus = "ambiguous" // multiple candidates
	StatusUnmatched MatchStatus = "unmatched" // no candidate found
	StatusLinked    MatchStatus = "linked"    // already confirmed in a prior import
)

// MatchResult is one row in the report returned to the frontend.
type MatchResult struct {
	Order      AmazonOrder         `json:"order"`
	Status     MatchStatus         `json:"status"`
	Candidates []dbpkg.Transaction `json:"candidates"` // ≥1 for confident/ambiguous
	Note       string              `json:"note"`       // human-readable explanation
}

// TxnCandidate is a trimmed view of a transaction for the manual picker.
type TxnCandidate struct {
	DateTransactionID string  `json:"dateTransactionId"`
	AccountID         string  `json:"accountId"`
	Date              string  `json:"date"`
	Amount            float64 `json:"amount"`
	MerchantName      string  `json:"merchantName,omitempty"`
	Name              string  `json:"name,omitempty"`
	CustomName        string  `json:"customName,omitempty"`
	CustomCategory    string  `json:"customCategory,omitempty"`
	BudgetID          string  `json:"budgetId,omitempty"`
}

// ── Handler ───────────────────────────────────────────────────────────────────

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil {
		return *deny, nil
	}
	// The body is raw CSV text sent as application/octet-stream or text/plain.
	// API Gateway v2 base64-encodes binary bodies; we handle both.
	csvData := req.Body
	if req.IsBase64Encoded {
		decoded, err := base64.StdEncoding.DecodeString(csvData)
		if err != nil {
			return errorResponse(http.StatusBadRequest, "failed to decode base64 body"), nil
		}
		csvData = string(decoded)
	}
	if csvData == "" {
		return errorResponse(http.StatusBadRequest, "request body is empty"), nil
	}

	orders, err := parseCSV(csvData)
	if err != nil {
		return errorResponse(http.StatusBadRequest, fmt.Sprintf("CSV parse error: %v", err)), nil
	}
	if len(orders) == 0 {
		return errorResponse(http.StatusBadRequest, "no orders found in CSV"), nil
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

	// Determine date range to query: earliest order date -7 days to latest +7 days
	minDate, maxDate := dateRange(orders)
	minDate = shiftDate(minDate, -7)
	maxDate = shiftDate(maxDate, 7)

	// Fetch all Amazon-ish transactions in the range across all accounts.
	// Two buckets:
	//   candidates — unlinked posted transactions available for matching
	//   linked     — already-confirmed transactions keyed by order ID
	var candidates []dbpkg.Transaction
	linked := make(map[string]dbpkg.Transaction) // orderId → transaction
	for _, acct := range accounts {
		txns, err := dbClient.GetTransactions(ctx, acct.AccountID, minDate, maxDate)
		if err != nil {
			continue
		}
		for _, t := range txns {
			if !isAmazon(t) || t.Pending {
				continue
			}
			if t.ReferenceURL != "" {
				// Check whether this transaction's note references one of our orders.
				// referenceNote format: "Amazon Order #<orderId>[ — <title>]"
				// Fall back to parsing the orderID query param from the URL for
				// transactions that were linked manually (no referenceNote set).
				orderID := extractOrderID(t.ReferenceNote)
				if orderID == "" {
					orderID = extractOrderIDFromURL(t.ReferenceURL)
				}
				if orderID != "" {
					linked[orderID] = t
				}
				continue
			}
			candidates = append(candidates, t)
		}
	}

	results := matchOrders(orders, candidates, linked)

	// Build trimmed transaction list for the manual picker on unmatched rows.
	txnCandidates := make([]TxnCandidate, 0, len(candidates))
	for _, t := range candidates {
		txnCandidates = append(txnCandidates, TxnCandidate{
			DateTransactionID: t.DateTransactionID,
			AccountID:         t.AccountID,
			Date:              t.Date,
			Amount:            t.Amount,
			MerchantName:      t.MerchantName,
			Name:              t.Name,
			CustomName:        t.CustomName,
			CustomCategory:    t.CustomCategory,
			BudgetID:          t.BudgetID,
		})
	}

	body, _ := json.Marshal(map[string]interface{}{
		"results":      results,
		"orderCount":   len(orders),
		"txnPool":      len(candidates),
		"transactions": txnCandidates,
	})
	return response{StatusCode: http.StatusOK, Body: string(body), Headers: jsonHeaders()}, nil
}

// ── CSV parsing ───────────────────────────────────────────────────────────────

func parseCSV(data string) ([]AmazonOrder, error) {
	r := csv.NewReader(strings.NewReader(data))
	r.LazyQuotes = true
	r.TrimLeadingSpace = true

	records, err := r.ReadAll()
	if err != nil {
		return nil, err
	}
	if len(records) < 2 {
		return nil, fmt.Errorf("CSV has no data rows")
	}

	// Build column index map (case-insensitive, strip spaces)
	colIdx := make(map[string]int)
	for i, h := range records[0] {
		colIdx[strings.ToLower(strings.TrimSpace(h))] = i
	}

	// Required columns — support both legacy Amazon export and Chrome extension formats
	orderIDCol := firstCol(colIdx, "order id", "order_id", "orderid")
	orderDateCol := firstCol(colIdx, "order date", "order_date", "orderplaced")
	amountCol := firstCol(colIdx, "total charged", "order total", "item total", "total")
	titleCol := firstCol(colIdx, "title", "product name", "item name", "itemtitles")
	// Optional columns (Chrome extension)
	orderURLCol := firstCol(colIdx, "orderdetailsurl", "order details url", "order url")
	statusCol := firstCol(colIdx, "shipmentstatus", "shipment status")

	if orderIDCol < 0 || orderDateCol < 0 || amountCol < 0 {
		return nil, fmt.Errorf("required columns missing (need Order ID, Order Date, Total Charged/Order Total)")
	}

	// Group rows by order ID
	type orderAccum struct {
		date     string
		amount   float64
		titles   []string
		url      string
		refunded bool
		seen     bool
	}
	accum := make(map[string]*orderAccum)
	orderSeq := []string{} // preserve original row order

	for _, row := range records[1:] {
		if len(row) <= orderIDCol {
			continue
		}
		orderID := strings.TrimSpace(row[orderIDCol])
		if orderID == "" {
			continue
		}

		rawDate := ""
		if orderDateCol < len(row) {
			rawDate = strings.TrimSpace(row[orderDateCol])
		}
		date := normalizeDate(rawDate)

		rawAmt := ""
		if amountCol < len(row) {
			rawAmt = strings.TrimSpace(row[amountCol])
		}
		amount := parseAmount(rawAmt)

		title := ""
		if titleCol >= 0 && titleCol < len(row) {
			title = strings.TrimSpace(row[titleCol])
		}

		rawURL := ""
		if orderURLCol >= 0 && orderURLCol < len(row) {
			rawURL = strings.TrimSpace(row[orderURLCol])
		}

		refunded := false
		if statusCol >= 0 && statusCol < len(row) {
			lower := strings.ToLower(row[statusCol])
			refunded = strings.Contains(lower, "refund") || strings.Contains(lower, "return")
		}

		if _, exists := accum[orderID]; !exists {
			accum[orderID] = &orderAccum{}
			orderSeq = append(orderSeq, orderID)
		}
		a := accum[orderID]
		if !a.seen {
			a.date = date
			a.amount = amount
			a.url = rawURL
			a.refunded = refunded
			a.seen = true
		}
		// If a later row has a higher amount it's likely the "Total Charged" row
		if amount > a.amount {
			a.amount = amount
		}
		// Split on "|" to handle Chrome extension format (all titles in one cell)
		if title != "" {
			for _, part := range strings.Split(title, "|") {
				if t := strings.TrimSpace(part); t != "" {
					a.titles = append(a.titles, t)
				}
			}
		}
		if a.titles == nil {
			a.titles = []string{}
		}
	}

	var orders []AmazonOrder
	for _, id := range orderSeq {
		a := accum[id]
		if a.amount <= 0 || a.date == "" {
			continue
		}
		orderURL := a.url
		if orderURL == "" {
			orderURL = "https://www.amazon.com/gp/css/order-details?orderID=" + id
		}
		orders = append(orders, AmazonOrder{
			OrderID:   id,
			OrderDate: a.date,
			Amount:    a.amount,
			Titles:    a.titles,
			OrderURL:  orderURL,
			Refunded:  a.refunded,
		})
	}
	return orders, nil
}

// ── Matching ──────────────────────────────────────────────────────────────────

const (
	amountTolerance = 1.00 // dollars
	dateTolerance   = 7    // days
)

func matchOrders(orders []AmazonOrder, txnPool []dbpkg.Transaction, linked map[string]dbpkg.Transaction) []MatchResult {
	results := make([]MatchResult, 0, len(orders))

	// ── Pass 1: collect candidate hits per order (unlinked orders only) ───────
	// Also build txnContestCount: how many orders each transaction is a hit for.
	// A transaction claimed by more than one order cannot be a confident match
	// for any of them — both orders must go ambiguous so the user can choose.

	type orderHits struct {
		order AmazonOrder
		hits  []dbpkg.Transaction
	}
	pendingHits := make([]orderHits, 0, len(orders))
	txnContestCount := make(map[string]int) // dateTransactionID → # of orders that hit it

	for _, order := range orders {
		if _, ok := linked[order.OrderID]; ok {
			continue // already linked; handled in pass 2
		}
		var hits []dbpkg.Transaction
		for _, t := range txnPool {
			if !amountMatches(t.Amount, order.Amount) {
				continue
			}
			if !dateMatches(t.Date, order.OrderDate) {
				continue
			}
			hits = append(hits, t)
		}
		pendingHits = append(pendingHits, orderHits{order, hits})
		for _, t := range hits {
			txnContestCount[t.DateTransactionID]++
		}
	}

	// ── Pass 2: emit results ──────────────────────────────────────────────────

	// Index pendingHits by orderID for the loop below.
	pendingByID := make(map[string]orderHits, len(pendingHits))
	for _, oh := range pendingHits {
		pendingByID[oh.order.OrderID] = oh
	}

	for _, order := range orders {
		// Already confirmed in a prior import?
		if t, ok := linked[order.OrderID]; ok {
			results = append(results, MatchResult{
				Order:      order,
				Status:     StatusLinked,
				Candidates: []dbpkg.Transaction{t},
				Note:       "Already linked to a transaction.",
			})
			continue
		}

		oh := pendingByID[order.OrderID]
		hits := oh.hits

		switch len(hits) {
		case 0:
			results = append(results, MatchResult{
				Order:  order,
				Status: StatusUnmatched,
				Note:   "No Amazon transaction found within ±$1.00 / ±7 days.",
			})
		case 1:
			// Confident only if no other order also matched this transaction.
			if txnContestCount[hits[0].DateTransactionID] == 1 {
				results = append(results, MatchResult{
					Order:      order,
					Status:     StatusConfident,
					Candidates: hits,
					Note:       "Exact match.",
				})
			} else {
				// Another order shares this transaction — surface as ambiguous.
				results = append(results, MatchResult{
					Order:      order,
					Status:     StatusAmbiguous,
					Candidates: hits,
					Note:       "Transaction also matches another order — please confirm.",
				})
			}
		default:
			// Sort candidates by date proximity to the order date (closest first)
			sort.Slice(hits, func(i, j int) bool {
				di := dateDeltaDays(hits[i].Date, order.OrderDate)
				dj := dateDeltaDays(hits[j].Date, order.OrderDate)
				return di < dj
			})
			results = append(results, MatchResult{
				Order:      order,
				Status:     StatusAmbiguous,
				Candidates: hits,
				Note:       fmt.Sprintf("%d transactions match this order — please pick one.", len(hits)),
			})
		}
	}
	return results
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func isAmazon(t dbpkg.Transaction) bool {
	name := strings.ToLower(t.MerchantName + " " + t.Name)
	return strings.Contains(name, "amazon") || strings.Contains(name, "whole foods")
}

// extractOrderID parses the order ID out of a referenceNote written by this
// importer. Expected format: "Amazon Order #<orderId>[…]"
func extractOrderID(note string) string {
	const prefix = "Amazon Order #"
	idx := strings.Index(note, prefix)
	if idx < 0 {
		return ""
	}
	rest := note[idx+len(prefix):]
	// Order ID ends at first space, em-dash, or end of string
	end := strings.IndexAny(rest, " \t—")
	if end < 0 {
		return rest
	}
	return rest[:end]
}

// extractOrderIDFromURL parses the orderID query param from an Amazon order URL.
// e.g. https://www.amazon.com/gp/css/summary/print.html?orderID=111-1234567-1234567&…
func extractOrderIDFromURL(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	return u.Query().Get("orderID")
}

func amountMatches(txnAmt, orderAmt float64) bool {
	// Plaid amounts are positive for debits
	return math.Abs(txnAmt-orderAmt) <= amountTolerance
}

func dateMatches(txnDate, orderDate string) bool {
	t1, e1 := time.Parse("2006-01-02", txnDate)
	t2, e2 := time.Parse("2006-01-02", orderDate)
	if e1 != nil || e2 != nil {
		return false
	}
	// Ignore transactions that posted before the order was placed
	if t1.Before(t2) {
		return false
	}
	return t1.Sub(t2) <= time.Duration(dateTolerance)*24*time.Hour
}

// dateDeltaDays returns the absolute number of days between two YYYY-MM-DD dates.
// Returns a large value if either date fails to parse.
func dateDeltaDays(a, b string) int {
	t1, e1 := time.Parse("2006-01-02", a)
	t2, e2 := time.Parse("2006-01-02", b)
	if e1 != nil || e2 != nil {
		return 9999
	}
	diff := t1.Sub(t2)
	if diff < 0 {
		diff = -diff
	}
	return int(diff / (24 * time.Hour))
}

// normalizeDate converts various Amazon date formats to YYYY-MM-DD.
func normalizeDate(s string) string {
	formats := []string{
		"01/02/2006", "1/2/2006",
		"2006-01-02",
		"January 2, 2006", "Jan 2, 2006",
		"02-Jan-2006",
	}
	for _, f := range formats {
		if t, err := time.Parse(f, s); err == nil {
			return t.Format("2006-01-02")
		}
	}
	return s
}

// parseAmount strips currency symbols and parses a float.
func parseAmount(s string) float64 {
	s = strings.ReplaceAll(s, "$", "")
	s = strings.ReplaceAll(s, ",", "")
	s = strings.TrimSpace(s)
	v, _ := strconv.ParseFloat(s, 64)
	return v
}

func firstCol(idx map[string]int, keys ...string) int {
	for _, k := range keys {
		if i, ok := idx[k]; ok {
			return i
		}
	}
	return -1
}

func dateRange(orders []AmazonOrder) (min, max string) {
	for _, o := range orders {
		if min == "" || o.OrderDate < min {
			min = o.OrderDate
		}
		if max == "" || o.OrderDate > max {
			max = o.OrderDate
		}
	}
	return
}

func shiftDate(date string, days int) string {
	t, err := time.Parse("2006-01-02", date)
	if err != nil {
		return date
	}
	return t.AddDate(0, 0, days).Format("2006-01-02")
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

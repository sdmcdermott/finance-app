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
)

// MatchResult is one row in the report returned to the frontend.
type MatchResult struct {
	Order      AmazonOrder         `json:"order"`
	Status     MatchStatus         `json:"status"`
	Candidates []dbpkg.Transaction `json:"candidates"` // ≥1 for confident/ambiguous
	Note       string              `json:"note"`       // human-readable explanation
}

// ── Handler ───────────────────────────────────────────────────────────────────

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil { return *deny, nil }
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

	// Fetch all Amazon-ish transactions in the range across all accounts
	var candidates []dbpkg.Transaction
	for _, acct := range accounts {
		txns, err := dbClient.GetTransactions(ctx, acct.AccountID, minDate, maxDate)
		if err != nil {
			continue
		}
		for _, t := range txns {
			if isAmazon(t) {
				candidates = append(candidates, t)
			}
		}
	}

	results := matchOrders(orders, candidates)

	body, _ := json.Marshal(map[string]interface{}{
		"results":    results,
		"orderCount": len(orders),
		"txnPool":    len(candidates),
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
	orderIDCol   := firstCol(colIdx, "order id", "order_id", "orderid")
	orderDateCol := firstCol(colIdx, "order date", "order_date", "orderplaced")
	amountCol    := firstCol(colIdx, "total charged", "order total", "item total", "total")
	titleCol     := firstCol(colIdx, "title", "product name", "item name", "itemtitles")
	// Optional columns (Chrome extension)
	orderURLCol  := firstCol(colIdx, "orderdetailsurl", "order details url", "order url")
	statusCol    := firstCol(colIdx, "shipmentstatus", "shipment status")

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
	accum    := make(map[string]*orderAccum)
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
			refunded = strings.Contains(strings.ToLower(row[statusCol]), "refund")
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

func matchOrders(orders []AmazonOrder, txnPool []dbpkg.Transaction) []MatchResult {
	results := make([]MatchResult, 0, len(orders))
	// Track which transactions have already been confidently claimed
	claimed := make(map[string]bool)

	for _, order := range orders {
		var hits []dbpkg.Transaction
		for _, t := range txnPool {
			if claimed[t.DateTransactionID] {
				continue
			}
			if !amountMatches(t.Amount, order.Amount) {
				continue
			}
			if !dateMatches(t.Date, order.OrderDate) {
				continue
			}
			hits = append(hits, t)
		}

		switch len(hits) {
		case 0:
			results = append(results, MatchResult{
				Order:  order,
				Status: StatusUnmatched,
				Note:   "No Amazon transaction found within ±$1.00 / ±7 days.",
			})
		case 1:
			claimed[hits[0].DateTransactionID] = true
			results = append(results, MatchResult{
				Order:      order,
				Status:     StatusConfident,
				Candidates: hits,
				Note:       "Exact match.",
			})
		default:
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
	return strings.Contains(name, "amazon")
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
	diff := t1.Sub(t2)
	if diff < 0 {
		diff = -diff
	}
	return diff <= time.Duration(dateTolerance)*24*time.Hour
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

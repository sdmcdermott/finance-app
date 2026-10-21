package main

// cc-cycle-guided validates a small set of real statements (billing period
// end date + payment due date, as read directly off the statements by the
// user) against a credit card account's own already-synced transaction
// history — see internal/db/cccycle.go's ValidateGuidedCycle. Returns the
// derived close day/grace period plus a per-cycle match breakdown, so the
// user can see whether their entered dates line up with what actually
// happened, before saving them as a manual override. Nothing is persisted
// here; saving happens via PATCH /accounts/{accountId} separately.

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	auth "github.com/smcdermott/finance-app/internal/auth"
	dbpkg "github.com/smcdermott/finance-app/internal/db"
	plaidclient "github.com/smcdermott/finance-app/internal/plaid"
)

type response = events.APIGatewayV2HTTPResponse

type guidedRequest struct {
	Statements []dbpkg.ManualStatementEntry `json:"statements"`
}

type guidedEntryResponse struct {
	CloseDate            string  `json:"closeDate"`
	DueDate              string  `json:"dueDate"`
	WindowSum            float64 `json:"windowSum"`
	MatchedPaymentDate   string  `json:"matchedPaymentDate,omitempty"`
	MatchedPaymentAmount float64 `json:"matchedPaymentAmount,omitempty"`
	Matched              bool    `json:"matched"`
}

type guidedResponse struct {
	SuggestedPaymentDueDay   int                   `json:"suggestedPaymentDueDay"`
	SuggestedGracePeriodDays int                   `json:"suggestedGracePeriodDays"`
	Entries                  []guidedEntryResponse `json:"entries"`
	MatchCount               int                   `json:"matchCount"`
	TotalCycles              int                   `json:"totalCycles"`
}

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil {
		return *deny, nil
	}

	accountID := req.PathParameters["accountId"]
	if accountID == "" {
		return errorResponse(http.StatusBadRequest, "accountId is required"), nil
	}

	var body guidedRequest
	if err := json.Unmarshal([]byte(req.Body), &body); err != nil {
		return errorResponse(http.StatusBadRequest, "invalid request body"), nil
	}
	if len(body.Statements) < 2 {
		return errorResponse(http.StatusBadRequest, "at least 2 statement entries are required"), nil
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
	var account *dbpkg.Account
	for i := range accounts {
		if accounts[i].AccountID == accountID {
			account = &accounts[i]
			break
		}
	}
	if account == nil {
		return errorResponse(http.StatusNotFound, "account not found"), nil
	}
	if account.Type != "credit" {
		return errorResponse(http.StatusBadRequest, "cash flow cycle configuration only applies to credit card accounts"), nil
	}

	now := time.Now().UTC()
	// Look back far enough to cover the earliest entered close date plus a
	// margin for the cycle before it (needed to bound that entry's window).
	lookbackStart := now.AddDate(0, -13, 0).Format("2006-01-02")
	today := now.Format("2006-01-02")
	txns, err := dbClient.GetTransactions(ctx, accountID, lookbackStart, today)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	result, err := dbpkg.ValidateGuidedCycle(txns, body.Statements)
	if err != nil {
		return errorResponse(http.StatusBadRequest, err.Error()), nil
	}

	resp := guidedResponse{
		SuggestedPaymentDueDay:   result.SuggestedPaymentDueDay,
		SuggestedGracePeriodDays: result.SuggestedGracePeriodDays,
		MatchCount:               result.MatchCount,
		TotalCycles:              result.TotalCycles,
		Entries:                  make([]guidedEntryResponse, len(result.Entries)),
	}
	for i, e := range result.Entries {
		resp.Entries[i] = guidedEntryResponse{
			CloseDate:            e.CloseDate,
			DueDate:              e.DueDate,
			WindowSum:            e.WindowSum,
			MatchedPaymentDate:   e.MatchedPaymentDate,
			MatchedPaymentAmount: e.MatchedPaymentAmount,
			Matched:              e.Matched,
		}
	}

	out, _ := json.Marshal(resp)
	return response{StatusCode: http.StatusOK, Body: string(out), Headers: jsonHeaders()}, nil
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

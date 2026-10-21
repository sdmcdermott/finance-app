package main

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

// bulkDeleteRequest scopes a bulk-delete operation to a single account and an
// inclusive date range. Unlike the single-transaction delete endpoint, this
// is permitted to remove real Plaid-synced transactions (not just manual
// ones) — it exists specifically for reconciling duplicate history left
// behind when the same real-world account is re-linked under a new Plaid
// Item (e.g. a broken Elan connection re-added via Fidelity), which produces
// a fresh set of transaction IDs that don't naturally de-duplicate against
// the old ones.
//
// Confirm defaults to false so callers must first preview what would be
// deleted before committing to it.
type bulkDeleteRequest struct {
	AccountID string `json:"accountId"`
	StartDate string `json:"startDate"` // YYYY-MM-DD, inclusive
	EndDate   string `json:"endDate"`   // YYYY-MM-DD, inclusive
	Confirm   bool   `json:"confirm"`
}

type txnSummary struct {
	Date   string  `json:"date"`
	Name   string  `json:"name"`
	Amount float64 `json:"amount"`
}

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil {
		return *deny, nil
	}

	var body bulkDeleteRequest
	if err := json.Unmarshal([]byte(req.Body), &body); err != nil {
		return errResp(http.StatusBadRequest, "invalid request body"), nil
	}
	if body.AccountID == "" || body.StartDate == "" || body.EndDate == "" {
		return errResp(http.StatusBadRequest, "accountId, startDate, and endDate are required"), nil
	}
	if _, err := time.Parse("2006-01-02", body.StartDate); err != nil {
		return errResp(http.StatusBadRequest, "startDate must be YYYY-MM-DD"), nil
	}
	if _, err := time.Parse("2006-01-02", body.EndDate); err != nil {
		return errResp(http.StatusBadRequest, "endDate must be YYYY-MM-DD"), nil
	}
	if body.EndDate < body.StartDate {
		return errResp(http.StatusBadRequest, "endDate must be on or after startDate"), nil
	}

	dbClient, err := dbpkg.New(ctx)
	if err != nil {
		return errResp(http.StatusInternalServerError, err.Error()), nil
	}

	// Verify the account actually belongs to this user before touching
	// anything — accountId is caller-supplied.
	userID := plaidclient.UserID()
	accounts, err := dbClient.GetAccounts(ctx, userID)
	if err != nil {
		return errResp(http.StatusInternalServerError, err.Error()), nil
	}
	found := false
	for _, a := range accounts {
		if a.AccountID == body.AccountID {
			found = true
			break
		}
	}
	if !found {
		return errResp(http.StatusForbidden, "account not found"), nil
	}

	txns, err := dbClient.GetTransactions(ctx, body.AccountID, body.StartDate, body.EndDate)
	if err != nil {
		return errResp(http.StatusInternalServerError, err.Error()), nil
	}

	if !body.Confirm {
		// Preview mode: report how many would be deleted plus a capped
		// sample, so the caller can render a confirmation UI without
		// risking an accidental irreversible delete.
		const sampleLimit = 50
		sample := make([]txnSummary, 0, sampleLimit)
		for i, t := range txns {
			if i >= sampleLimit {
				break
			}
			sample = append(sample, txnSummary{Date: t.Date, Name: t.Name, Amount: t.Amount})
		}
		respBody, _ := json.Marshal(map[string]interface{}{
			"preview":    true,
			"count":      len(txns),
			"sample":     sample,
			"sampleSize": len(sample),
		})
		return response{StatusCode: http.StatusOK, Body: string(respBody), Headers: jsonHeaders()}, nil
	}

	keys := make([]struct{ Date, TxnID string }, 0, len(txns))
	for _, t := range txns {
		keys = append(keys, struct{ Date, TxnID string }{Date: t.Date, TxnID: t.TransactionID})
	}
	if err := dbClient.DeleteTransactions(ctx, body.AccountID, keys); err != nil {
		return errResp(http.StatusInternalServerError, err.Error()), nil
	}

	respBody, _ := json.Marshal(map[string]interface{}{
		"deleted": len(txns),
	})
	return response{StatusCode: http.StatusOK, Body: string(respBody), Headers: jsonHeaders()}, nil
}

func main() {
	lambda.Start(handler)
}

func errResp(status int, msg string) response {
	body, _ := json.Marshal(map[string]string{"error": msg})
	return response{StatusCode: status, Body: string(body), Headers: jsonHeaders()}
}

func jsonHeaders() map[string]string {
	return map[string]string{
		"Content-Type":                "application/json",
		"Access-Control-Allow-Origin": "*",
	}
}

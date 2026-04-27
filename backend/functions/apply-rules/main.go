package main

// apply-rules re-applies all auto-assignment rules to transactions for the
// current month (or an optional month supplied via query parameter).
// Only transactions that have NOT been manually categorized are updated.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
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

	// Determine date range: default to current month
	now := time.Now()
	month := req.QueryStringParameters["month"] // optional "YYYY-MM"
	var startDate, endDate string
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
		startDate = fmt.Sprintf("%d-%02d-01", now.Year(), now.Month())
		last := time.Date(now.Year(), now.Month()+1, 0, 0, 0, 0, 0, time.UTC).Day()
		endDate = fmt.Sprintf("%d-%02d-%02d", now.Year(), now.Month(), last)
	}

	// Fetch all accounts and rules
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

	// Persist only the transactions whose customCategory actually changed
	var toWrite []dbpkg.Transaction
	origMap := make(map[string]string, len(allTxns))
	for _, t := range allTxns {
		origMap[t.DateTransactionID] = t.CustomCategory
	}
	for _, t := range updated {
		if t.CustomCategory != origMap[t.DateTransactionID] {
			toWrite = append(toWrite, t)
		}
	}

	if len(toWrite) > 0 {
		if err := dbClient.PutTransactions(ctx, toWrite); err != nil {
			return errorResponse(http.StatusInternalServerError, err.Error()), nil
		}
	}

	body, _ := json.Marshal(map[string]interface{}{
		"updated":   len(toWrite),
		"startDate": startDate,
		"endDate":   endDate,
	})
	return response{StatusCode: http.StatusOK, Body: string(body), Headers: jsonHeaders()}, nil
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

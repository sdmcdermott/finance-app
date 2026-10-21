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

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil {
		return *deny, nil
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

	// Optional query params: accountId, startDate, endDate
	// Defaults: last 30 days, all accounts
	qp := req.QueryStringParameters
	startDate := qp["startDate"]
	endDate := qp["endDate"]
	filterAccountID := qp["accountId"]

	if endDate == "" {
		endDate = time.Now().Format("2006-01-02")
	}
	if startDate == "" {
		startDate = time.Now().AddDate(0, -1, 0).Format("2006-01-02")
	}

	var allTxns []dbpkg.Transaction
	for _, acct := range accounts {
		if filterAccountID != "" && acct.AccountID != filterAccountID {
			continue
		}
		txns, err := dbClient.GetTransactions(ctx, acct.AccountID, startDate, endDate)
		if err != nil {
			return errorResponse(http.StatusInternalServerError, err.Error()), nil
		}

		// Fetch splits for this account/range and embed them on each transaction
		splitMap, err := dbClient.GetSplitsForRange(ctx, acct.AccountID, startDate, endDate)
		if err != nil {
			// Non-fatal: return transactions without splits rather than failing
			splitMap = map[string][]dbpkg.TransactionSplit{}
		}
		for i := range txns {
			if splits, ok := splitMap[txns[i].DateTransactionID]; ok {
				txns[i].Splits = splits
			}
		}

		allTxns = append(allTxns, txns...)
	}

	body, _ := json.Marshal(map[string]interface{}{
		"transactions": allTxns,
		"startDate":    startDate,
		"endDate":      endDate,
		"userID":       userID,
	})
	return response{StatusCode: http.StatusOK, Body: string(body), Headers: jsonHeaders()}, nil
}

func main() {
	lambda.Start(handler)
}

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

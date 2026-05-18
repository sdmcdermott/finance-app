package main

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
)

type response = events.APIGatewayV2HTTPResponse

type putRequest struct {
	AccountID      string  `json:"accountId"`
	Date           string  `json:"date"`           // YYYY-MM-DD
	Name           string  `json:"name"`
	Amount         float64 `json:"amount"`
	CustomCategory string  `json:"customCategory"`
	BudgetID       string  `json:"budgetId"`
	// Provided when editing an existing manual transaction
	TransactionID string `json:"transactionId"`
}

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil {
		return *deny, nil
	}

	var body putRequest
	if err := json.Unmarshal([]byte(req.Body), &body); err != nil {
		return errResp(http.StatusBadRequest, "invalid request body"), nil
	}
	if body.AccountID == "" || body.Date == "" || body.Name == "" {
		return errResp(http.StatusBadRequest, "accountId, date, and name are required"), nil
	}
	if _, err := time.Parse("2006-01-02", body.Date); err != nil {
		return errResp(http.StatusBadRequest, "date must be YYYY-MM-DD"), nil
	}

	// Generate a stable txnId for new transactions, or reuse the provided one
	txnID := body.TransactionID
	if txnID == "" {
		txnID = fmt.Sprintf("manual-%d", time.Now().UnixNano())
	}
	dtid := body.Date + "#" + txnID

	txn := dbpkg.Transaction{
		AccountID:         body.AccountID,
		DateTransactionID: dtid,
		TransactionID:     txnID,
		Date:              body.Date,
		Name:              body.Name,
		Amount:            body.Amount,
		CustomCategory:    body.CustomCategory,
		ManualCategory:    body.CustomCategory != "",
		BudgetID:          body.BudgetID,
		ManualBudget:      body.BudgetID != "",
	}

	dbClient, err := dbpkg.New(ctx)
	if err != nil {
		return errResp(http.StatusInternalServerError, err.Error()), nil
	}

	if err := dbClient.PutTransactions(ctx, []dbpkg.Transaction{txn}); err != nil {
		return errResp(http.StatusInternalServerError, err.Error()), nil
	}

	respBody, _ := json.Marshal(txn)
	return response{StatusCode: http.StatusOK, Body: string(respBody), Headers: jsonHeaders()}, nil
}

func main() { lambda.Start(handler) }

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

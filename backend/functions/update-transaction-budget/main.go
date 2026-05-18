package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	auth "github.com/smcdermott/finance-app/internal/auth"
	dbpkg "github.com/smcdermott/finance-app/internal/db"
)

type response = events.APIGatewayV2HTTPResponse

type updateRequest struct {
	BudgetID string `json:"budgetId"` // empty string clears the manual override
}

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil { return *deny, nil }
	accountID := req.PathParameters["accountId"]
	dtid := req.PathParameters["dateTransactionId"]
	if accountID == "" || dtid == "" {
		return errorResponse(http.StatusBadRequest, "accountId and dateTransactionId are required"), nil
	}

	parts := strings.SplitN(dtid, "#", 2)
	if len(parts) != 2 {
		return errorResponse(http.StatusBadRequest, "dateTransactionId must be in format <date>#<txnId>"), nil
	}
	date, txnID := parts[0], parts[1]

	var body updateRequest
	if err := json.Unmarshal([]byte(req.Body), &body); err != nil {
		return errorResponse(http.StatusBadRequest, "invalid request body"), nil
	}

	dbClient, err := dbpkg.New(ctx)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	if err := dbClient.UpdateTransactionBudget(ctx, accountID, date, txnID, body.BudgetID); err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	respBody, _ := json.Marshal(map[string]string{
		"accountId":         accountID,
		"dateTransactionId": dtid,
		"budgetId":          body.BudgetID,
	})
	return response{StatusCode: http.StatusOK, Body: string(respBody), Headers: jsonHeaders()}, nil
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

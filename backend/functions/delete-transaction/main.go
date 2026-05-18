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

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil {
		return *deny, nil
	}

	accountID := req.PathParameters["accountId"]
	dtid := req.PathParameters["dateTransactionId"]
	if accountID == "" || dtid == "" {
		return errResp(http.StatusBadRequest, "accountId and dateTransactionId are required"), nil
	}

	parts := strings.SplitN(dtid, "#", 2)
	if len(parts) != 2 {
		return errResp(http.StatusBadRequest, "dateTransactionId must be in format <date>#<txnId>"), nil
	}
	date, txnID := parts[0], parts[1]

	// Only allow deleting manual transactions
	if !strings.HasPrefix(txnID, "manual-") {
		return errResp(http.StatusForbidden, "only manually-created transactions can be deleted"), nil
	}

	dbClient, err := dbpkg.New(ctx)
	if err != nil {
		return errResp(http.StatusInternalServerError, err.Error()), nil
	}

	if err := dbClient.DeleteTransaction(ctx, accountID, date, txnID); err != nil {
		return errResp(http.StatusInternalServerError, err.Error()), nil
	}

	body, _ := json.Marshal(map[string]string{"status": "deleted"})
	return response{StatusCode: http.StatusOK, Body: string(body), Headers: jsonHeaders()}, nil
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

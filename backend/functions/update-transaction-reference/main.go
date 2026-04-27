package main

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	auth "github.com/smcdermott/finance-app/internal/auth"
	dbpkg "github.com/smcdermott/finance-app/internal/db"
)

type response = events.APIGatewayV2HTTPResponse

type referenceRequest struct {
	ReferenceURL  string `json:"referenceUrl"`
	ReferenceNote string `json:"referenceNote"`
}

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil { return *deny, nil }
	accountID := req.PathParameters["accountId"]
	dateTransactionID := req.PathParameters["dateTransactionId"]
	if accountID == "" || dateTransactionID == "" {
		return errorResponse(http.StatusBadRequest, "accountId and dateTransactionId path parameters are required"), nil
	}

	var body referenceRequest
	if err := json.Unmarshal([]byte(req.Body), &body); err != nil {
		return errorResponse(http.StatusBadRequest, "invalid request body"), nil
	}

	// dateTransactionId format: "YYYY-MM-DD#<txnId>"
	date, txnID := splitDateTxnID(dateTransactionID)
	if date == "" || txnID == "" {
		return errorResponse(http.StatusBadRequest, "invalid dateTransactionId format"), nil
	}

	dbClient, err := dbpkg.New(ctx)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	if err := dbClient.UpdateTransactionReference(ctx, accountID, date, txnID, body.ReferenceURL, body.ReferenceNote); err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	respBody, _ := json.Marshal(map[string]string{
		"referenceUrl":  body.ReferenceURL,
		"referenceNote": body.ReferenceNote,
	})
	return response{StatusCode: http.StatusOK, Body: string(respBody), Headers: jsonHeaders()}, nil
}

// splitDateTxnID splits "YYYY-MM-DD#txnId" into (date, txnId).
func splitDateTxnID(s string) (date, txnID string) {
	for i := 0; i < len(s); i++ {
		if s[i] == '#' {
			return s[:i], s[i+1:]
		}
	}
	return "", ""
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

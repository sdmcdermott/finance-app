package main

// confirm-amazon-import accepts the user-confirmed match list from the import
// preview UI and persists referenceUrl + referenceNote on each matched transaction.

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

// ConfirmedMatch is one user-approved order↔transaction pairing.
type ConfirmedMatch struct {
	// Transaction identifiers
	AccountID         string `json:"accountId"`
	DateTransactionID string `json:"dateTransactionId"`
	// Reference data to write
	ReferenceURL  string `json:"referenceUrl"`
	ReferenceNote string `json:"referenceNote"`
}

type confirmRequest struct {
	Matches []ConfirmedMatch `json:"matches"`
}

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil { return *deny, nil }
	var body confirmRequest
	if err := json.Unmarshal([]byte(req.Body), &body); err != nil {
		return errorResponse(http.StatusBadRequest, "invalid request body"), nil
	}
	if len(body.Matches) == 0 {
		return errorResponse(http.StatusBadRequest, "no matches provided"), nil
	}

	dbClient, err := dbpkg.New(ctx)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	saved := 0
	var errs []string
	for _, m := range body.Matches {
		if m.AccountID == "" || m.DateTransactionID == "" {
			continue
		}
		date, txnID := splitDateTxnID(m.DateTransactionID)
		if date == "" || txnID == "" {
			errs = append(errs, "invalid dateTransactionId: "+m.DateTransactionID)
			continue
		}
		if err := dbClient.UpdateTransactionReference(ctx, m.AccountID, date, txnID, m.ReferenceURL, m.ReferenceNote); err != nil {
			errs = append(errs, err.Error())
			continue
		}
		saved++
	}

	respBody, _ := json.Marshal(map[string]interface{}{
		"saved":  saved,
		"errors": errs,
	})
	return response{StatusCode: http.StatusOK, Body: string(respBody), Headers: jsonHeaders()}, nil
}

func splitDateTxnID(s string) (date, txnID string) {
	idx := strings.Index(s, "#")
	if idx < 0 {
		return "", ""
	}
	return s[:idx], s[idx+1:]
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

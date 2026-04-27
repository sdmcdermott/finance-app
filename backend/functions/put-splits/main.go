package main

// put-splits saves a complete set of splits for a transaction, replacing any
// existing splits. Sending an empty "splits" array removes all splits.
//
// Route: PUT /transactions/{accountId}/{dateTransactionId}/splits
//
// Request body:
//
//	{
//	  "splits": [
//	    { "splitId": "", "amount": 12.50, "customCategory": "cat-abc", "budgetId": "", "note": "Groceries" },
//	    { "splitId": "", "amount": 7.50,  "customCategory": "cat-xyz", "budgetId": "", "note": "Household" }
//	  ]
//	}
//
// Rules enforced:
//   - Split amounts must all be positive (debits from parent are positive).
//   - Sum of split amounts must equal the absolute value of the parent transaction amount.
//   - Minimum 2 splits required when splits array is non-empty.
//   - splitId is auto-generated (UUID) if empty.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/google/uuid"
	auth "github.com/smcdermott/finance-app/internal/auth"
	dbpkg "github.com/smcdermott/finance-app/internal/db"
)

type response = events.APIGatewayV2HTTPResponse

type putSplitsRequest struct {
	Splits []dbpkg.TransactionSplit `json:"splits"`
}

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil {
		return *deny, nil
	}

	accountID := req.PathParameters["accountId"]
	dateTransactionID := req.PathParameters["dateTransactionId"]
	if accountID == "" || dateTransactionID == "" {
		return errorResponse(http.StatusBadRequest, "accountId and dateTransactionId are required"), nil
	}

	var body putSplitsRequest
	if err := json.Unmarshal([]byte(req.Body), &body); err != nil {
		return errorResponse(http.StatusBadRequest, "invalid JSON: "+err.Error()), nil
	}

	// Validate splits
	if len(body.Splits) == 1 {
		return errorResponse(http.StatusBadRequest, "must have 0 or 2+ splits (use 0 to remove splits)"), nil
	}

	// Assign UUIDs and fill accountId / dateTransactionId
	var total float64
	for i := range body.Splits {
		if body.Splits[i].SplitID == "" {
			body.Splits[i].SplitID = uuid.NewString()
		}
		body.Splits[i].AccountID = accountID
		body.Splits[i].DateTransactionID = dateTransactionID
		if body.Splits[i].Amount <= 0 {
			return errorResponse(http.StatusBadRequest, fmt.Sprintf("split %d: amount must be positive", i)), nil
		}
		total += body.Splits[i].Amount
	}

	// Fetch the parent transaction to validate the sum (only when splits are present)
	if len(body.Splits) > 0 {
		dbClient, err := dbpkg.New(ctx)
		if err != nil {
			return errorResponse(http.StatusInternalServerError, err.Error()), nil
		}

		// Parse date from dateTransactionId
		parts := strings.SplitN(dateTransactionID, "#", 2)
		if len(parts) != 2 {
			return errorResponse(http.StatusBadRequest, "invalid dateTransactionId format"), nil
		}
		date := parts[0]
		txns, err := dbClient.GetTransactions(ctx, accountID, date, date)
		if err != nil {
			return errorResponse(http.StatusInternalServerError, err.Error()), nil
		}
		var parent *dbpkg.Transaction
		for i := range txns {
			if txns[i].DateTransactionID == dateTransactionID {
				parent = &txns[i]
				break
			}
		}
		if parent == nil {
			return errorResponse(http.StatusNotFound, "transaction not found"), nil
		}

		parentAbs := math.Abs(parent.Amount)
		// Allow up to 1-cent tolerance for floating-point sums
		if math.Abs(total-parentAbs) > 0.015 {
			return errorResponse(http.StatusBadRequest,
				fmt.Sprintf("split amounts sum to %.2f but transaction amount is %.2f", total, parentAbs)), nil
		}

		if err := dbClient.PutSplits(ctx, accountID, dateTransactionID, body.Splits); err != nil {
			return errorResponse(http.StatusInternalServerError, err.Error()), nil
		}

		out, _ := json.Marshal(map[string]interface{}{"splits": body.Splits})
		return response{StatusCode: http.StatusOK, Body: string(out), Headers: jsonHeaders()}, nil
	}

	// Empty splits — just delete
	dbClient, err := dbpkg.New(ctx)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}
	if err := dbClient.DeleteSplits(ctx, accountID, dateTransactionID); err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}
	out, _ := json.Marshal(map[string]interface{}{"splits": []interface{}{}})
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

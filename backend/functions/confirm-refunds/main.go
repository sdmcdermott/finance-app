package main

// confirm-refunds persists confirmed refund pairs.
// For each pair it:
//   1. Sets LinkedOriginalId on the credit (pointing to the debit's DateTransactionID)
//   2. Sets LinkedRefundId   on the debit  (pointing to the credit's DateTransactionID)
//   3. Copies the debit's customCategory and budgetId onto the credit
//      (only if the credit doesn't already have them set; caller can pre-set overrides)
//
// Request body (JSON):
//
//	{
//	  "pairs": [
//	    {
//	      "creditDateTransactionId":  "2026-05-12#txn_abc",
//	      "debitDateTransactionId":   "2026-04-01#txn_xyz",
//	      "categoryOverride": "cat-123",   // optional — overrides copied value
//	      "budgetOverride":   "bud-456"    // optional — overrides copied value
//	    }
//	  ]
//	}

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	auth "github.com/smcdermott/finance-app/internal/auth"
	dbpkg "github.com/smcdermott/finance-app/internal/db"
	plaidclient "github.com/smcdermott/finance-app/internal/plaid"
)

type response = events.APIGatewayV2HTTPResponse

type RefundPair struct {
	CreditDateTransactionID string `json:"creditDateTransactionId"`
	DebitDateTransactionID  string `json:"debitDateTransactionId"`
	CategoryOverride        string `json:"categoryOverride,omitempty"`
	BudgetOverride          string `json:"budgetOverride,omitempty"`
}

type confirmRequest struct {
	Pairs []RefundPair `json:"pairs"`
}

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil {
		return *deny, nil
	}

	var body confirmRequest
	if err := json.Unmarshal([]byte(req.Body), &body); err != nil || len(body.Pairs) == 0 {
		return errorResponse(http.StatusBadRequest, "pairs array is required"), nil
	}

	userID := plaidclient.UserID()
	dbClient, err := dbpkg.New(ctx)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	accounts, err := dbClient.GetAccounts(ctx, userID)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	// Build a lookup map: dateTransactionId → Transaction across all accounts.
	// We need this to fetch individual transactions by their composite key.
	txnByDTID := make(map[string]dbpkg.Transaction)
	for _, acct := range accounts {
		if !dbpkg.AccountEnabled(acct) {
			continue
		}
		txns, err := dbClient.GetTransactions(ctx, acct.AccountID, "2000-01-01", "2999-12-31")
		if err != nil {
			continue
		}
		for _, t := range txns {
			txnByDTID[t.DateTransactionID] = t
		}
	}

	var toWrite []dbpkg.Transaction
	confirmed := 0

	for _, pair := range body.Pairs {
		credit, creditOK := txnByDTID[pair.CreditDateTransactionID]
		debit, debitOK := txnByDTID[pair.DebitDateTransactionID]
		if !creditOK || !debitOK {
			continue
		}

		// Link the pair.
		credit.LinkedOriginalId = debit.DateTransactionID
		// Append this credit to the debit's refund list (deduplicate).
		alreadyLinked := false
		for _, id := range debit.LinkedRefundIds {
			if id == credit.DateTransactionID {
				alreadyLinked = true
				break
			}
		}
		if !alreadyLinked {
			debit.LinkedRefundIds = append(debit.LinkedRefundIds, credit.DateTransactionID)
		}

		// If the credit has a reference URL (e.g. Amazon order link), copy it to the
		// debit so the original charge is also linked to the order.
		if credit.ReferenceURL != "" && debit.ReferenceURL == "" {
			debit.ReferenceURL = credit.ReferenceURL
			debit.ReferenceNote = credit.ReferenceNote
		}

		// Copy category/budget from debit to credit, respecting overrides.
		if pair.CategoryOverride != "" {
			credit.CustomCategory = pair.CategoryOverride
			// Also apply to the debit if it doesn't already have one
			if debit.CustomCategory == "" {
				debit.CustomCategory = pair.CategoryOverride
			}
		} else if credit.CustomCategory == "" && debit.CustomCategory != "" {
			credit.CustomCategory = debit.CustomCategory
		}
		if pair.BudgetOverride != "" {
			credit.BudgetID = pair.BudgetOverride
			// Also apply to the debit if it doesn't already have one
			if debit.BudgetID == "" {
				debit.BudgetID = pair.BudgetOverride
			}
		} else if credit.BudgetID == "" && debit.BudgetID != "" {
			credit.BudgetID = debit.BudgetID
		}

		toWrite = append(toWrite, credit, debit)
		// Write debit back to the lookup map so subsequent pairs in this same
		// batch that reference the same debit see the already-updated LinkedRefundIds.
		txnByDTID[debit.DateTransactionID] = debit
		confirmed++
	}

	if len(toWrite) > 0 {
		// Deduplicate by DateTransactionID (belt-and-suspenders against DynamoDB duplicate key error).
		dedupMap := make(map[string]dbpkg.Transaction)
		for _, t := range toWrite {
			dedupMap[t.DateTransactionID] = t
		}
		toWrite = toWrite[:0]
		for _, t := range dedupMap {
			toWrite = append(toWrite, t)
		}
		if err := dbClient.PutTransactions(ctx, toWrite); err != nil {
			return errorResponse(http.StatusInternalServerError, err.Error()), nil
		}
	}

	respBody, _ := json.Marshal(map[string]interface{}{"confirmed": confirmed})
	return response{StatusCode: http.StatusOK, Body: string(respBody), Headers: jsonHeaders()}, nil
}

func main() { lambda.Start(handler) }

func errorResponse(status int, msg string) response {
	b, _ := json.Marshal(map[string]string{"error": msg})
	return response{StatusCode: status, Body: string(b), Headers: jsonHeaders()}
}

func jsonHeaders() map[string]string {
	return map[string]string{
		"Content-Type":                "application/json",
		"Access-Control-Allow-Origin": "*",
	}
}

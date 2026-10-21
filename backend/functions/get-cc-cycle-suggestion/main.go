package main

// get-cc-cycle-suggestion runs the automatic credit card billing cycle
// heuristic (internal/db/cccycle.go) for a single account and returns the
// result, without saving anything. Powers the "Run Analysis" button in the
// Accounts page's "Configure cash flow" modal — the same reconstruction the
// cash flow forecast itself would use automatically if no manual override
// is set, surfaced here on demand so the user can preview it (and copy the
// suggested values into the manual override fields) before saving.

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

type suggestionResponse struct {
	Confidence                 string  `json:"confidence"` // "high" | "low" | "none"
	PaymentDueDay              int     `json:"paymentDueDay,omitempty"`
	GracePeriodDays            int     `json:"gracePeriodDays,omitempty"`
	NextDueDate                string  `json:"nextDueDate,omitempty"`
	ProjectedNextPaymentAmount float64 `json:"projectedNextPaymentAmount,omitempty"`
	FallbackMeanDay            int     `json:"fallbackMeanDay,omitempty"`
	FallbackMeanAmount         float64 `json:"fallbackMeanAmount,omitempty"`
	PaymentsConsidered         int     `json:"paymentsConsidered"`
	PaymentsFit                int     `json:"paymentsFit"`
}

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil {
		return *deny, nil
	}

	accountID := req.PathParameters["accountId"]
	if accountID == "" {
		return errorResponse(http.StatusBadRequest, "accountId is required"), nil
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
	var account *dbpkg.Account
	for i := range accounts {
		if accounts[i].AccountID == accountID {
			account = &accounts[i]
			break
		}
	}
	if account == nil {
		return errorResponse(http.StatusNotFound, "account not found"), nil
	}
	if account.Type != "credit" {
		return errorResponse(http.StatusBadRequest, "cash flow cycle configuration only applies to credit card accounts"), nil
	}

	now := time.Now().UTC()
	// Same 6-month lookback the cash flow forecast itself uses, so this
	// preview matches exactly what the forecast would auto-detect.
	lookbackStart := now.AddDate(0, -6, 0).Format("2006-01-02")
	today := now.Format("2006-01-02")
	txns, err := dbClient.GetTransactions(ctx, accountID, lookbackStart, today)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	result := dbpkg.ReconstructCreditCardCycle(txns, now)
	resp := suggestionResponse{
		Confidence:         result.Confidence,
		PaymentsConsidered: result.PaymentsConsidered,
		PaymentsFit:        result.PaymentsFit,
	}
	switch result.Confidence {
	case "high":
		resp.PaymentDueDay = result.PaymentDueDay
		resp.GracePeriodDays = result.GracePeriodDays
		resp.NextDueDate = result.NextDueDate
		resp.ProjectedNextPaymentAmount = result.ProjectedNextPaymentAmount
	case "low":
		resp.FallbackMeanDay = result.FallbackMeanDay
		resp.FallbackMeanAmount = result.FallbackMeanAmount
	}

	body, _ := json.Marshal(resp)
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

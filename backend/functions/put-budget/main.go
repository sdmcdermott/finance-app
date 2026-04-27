package main

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	auth "github.com/smcdermott/finance-app/internal/auth"
	"github.com/google/uuid"
	dbpkg "github.com/smcdermott/finance-app/internal/db"
	plaidclient "github.com/smcdermott/finance-app/internal/plaid"
)

type response = events.APIGatewayV2HTTPResponse

type budgetRequest struct {
	BudgetID         string   `json:"budgetId"`         // omit to create; include to update
	Name             string   `json:"name"`             // required
	BudgetType       string   `json:"budgetType"`       // "goal" | "checkbook"
	Period           string   `json:"period"`           // daily|weekly|biweekly|monthly|quarterly|annually
	PeriodFormat     string   `json:"periodFormat"`     // label template, e.g. "{name} - {mon} {yyyy}"
	CategoryIDs      []string `json:"categoryIds"`      // categories that feed this budget
	GoalAmount       float64  `json:"goalAmount"`       // goal type only
	GoalDirection    string   `json:"goalDirection"`    // "limit" | "target"
	SurplusHandling  string   `json:"surplusHandling"`  // "ignore"|"rollover"|"transfer"
	TransferBudgetID string   `json:"transferBudgetId"` // dest budget when surplusHandling="transfer"
	TransferAmount   float64  `json:"transferAmount"`   // 0 = full delta
	OpeningBalance   float64  `json:"openingBalance"`   // checkbook type only
}

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil { return *deny, nil }
	var body budgetRequest
	if err := json.Unmarshal([]byte(req.Body), &body); err != nil {
		return errorResponse(http.StatusBadRequest, "invalid request body"), nil
	}
	if body.Name == "" {
		return errorResponse(http.StatusBadRequest, "name is required"), nil
	}
	if body.BudgetType != "goal" && body.BudgetType != "checkbook" {
		return errorResponse(http.StatusBadRequest, "budgetType must be 'goal' or 'checkbook'"), nil
	}
	if body.Period == "" {
		body.Period = "monthly"
	}
	if body.PeriodFormat == "" {
		body.PeriodFormat = defaultFormat(body.Period)
	}
	if body.BudgetID == "" {
		body.BudgetID = uuid.NewString()
	}
	if body.CategoryIDs == nil {
		body.CategoryIDs = []string{}
	}

	dbClient, err := dbpkg.New(ctx)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	budget := dbpkg.Budget{
		UserID:           plaidclient.UserID(),
		BudgetID:         body.BudgetID,
		Name:             body.Name,
		BudgetType:       body.BudgetType,
		Period:           body.Period,
		PeriodFormat:     body.PeriodFormat,
		CategoryIDs:      body.CategoryIDs,
		GoalAmount:       body.GoalAmount,
		GoalDirection:    body.GoalDirection,
		SurplusHandling:  body.SurplusHandling,
		TransferBudgetID: body.TransferBudgetID,
		TransferAmount:   body.TransferAmount,
		OpeningBalance:   body.OpeningBalance,
	}

	if err := dbClient.PutBudget(ctx, budget); err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	respBody, _ := json.Marshal(budget)
	return response{StatusCode: http.StatusOK, Body: string(respBody), Headers: jsonHeaders()}, nil
}

func defaultFormat(period string) string {
	switch period {
	case "daily":
		return "{name} - {mon} {dd} {yyyy}"
	case "weekly", "biweekly":
		return "{name} - W{wk} {mon} {yyyy}"
	case "quarterly":
		return "{name} - {q} {yyyy}"
	case "annually":
		return "{name} - {yyyy}"
	default:
		return "{name} - {mon} {yyyy}"
	}
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

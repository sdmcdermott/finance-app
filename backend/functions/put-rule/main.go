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

type ruleRequest struct {
	RuleID     string `json:"ruleId"`     // omit to create; include to update
	Pattern    string `json:"pattern"`    // required: substring to match merchant name
	CategoryID string `json:"categoryId"` // required: category to assign on match
	Priority   int    `json:"priority"`   // lower = applied first
}

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil { return *deny, nil }
	var body ruleRequest
	if err := json.Unmarshal([]byte(req.Body), &body); err != nil {
		return errorResponse(http.StatusBadRequest, "invalid request body"), nil
	}
	if body.Pattern == "" || body.CategoryID == "" {
		return errorResponse(http.StatusBadRequest, "pattern and categoryId are required"), nil
	}

	if body.RuleID == "" {
		body.RuleID = uuid.NewString()
	}

	dbClient, err := dbpkg.New(ctx)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	rule := dbpkg.Rule{
		UserID:     plaidclient.UserID(),
		RuleID:     body.RuleID,
		Pattern:    body.Pattern,
		CategoryID: body.CategoryID,
		Priority:   body.Priority,
	}

	if err := dbClient.PutRule(ctx, rule); err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	respBody, _ := json.Marshal(rule)
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

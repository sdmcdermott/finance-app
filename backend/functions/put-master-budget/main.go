package main

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

type masterBudgetRequest struct {
	IncomeSources []dbpkg.MBIncomeSource `json:"incomeSources"`
	FixedCosts    []dbpkg.MBFixedCost    `json:"fixedCosts"`
	Buckets       []dbpkg.MBBucket       `json:"buckets"`
}

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil { return *deny, nil }

	var body masterBudgetRequest
	if err := json.Unmarshal([]byte(req.Body), &body); err != nil {
		return errorResponse(http.StatusBadRequest, "invalid request body"), nil
	}

	// Normalise nil slices to empty so JSON marshals as [] not null
	if body.IncomeSources == nil { body.IncomeSources = []dbpkg.MBIncomeSource{} }
	if body.FixedCosts    == nil { body.FixedCosts    = []dbpkg.MBFixedCost{} }
	if body.Buckets       == nil { body.Buckets       = []dbpkg.MBBucket{} }

	dbClient, err := dbpkg.New(ctx)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	mb := dbpkg.MasterBudget{
		UserID:        plaidclient.UserID(),
		IncomeSources: body.IncomeSources,
		FixedCosts:    body.FixedCosts,
		Buckets:       body.Buckets,
	}

	if err := dbClient.PutMasterBudget(ctx, mb); err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	respBody, _ := json.Marshal(mb)
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

package main

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

type getMasterBudgetResponse struct {
	Versions []dbpkg.MasterBudget  `json:"versions"`
	Current  *dbpkg.MasterBudget   `json:"current"`
}

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil {
		return *deny, nil
	}

	userID := plaidclient.UserID()

	dbClient, err := dbpkg.New(ctx)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	versions, err := dbClient.GetMasterBudgets(ctx, userID)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	// Return an empty scaffold when no versions exist yet.
	if len(versions) == 0 {
		empty := dbpkg.MasterBudget{
			UserID:        userID,
			IncomeSources: []dbpkg.MBIncomeSource{},
			FixedCosts:    []dbpkg.MBFixedCost{},
			Buckets:       []dbpkg.MBBucket{},
		}
		versions = []dbpkg.MasterBudget{empty}
	}

	// Current = the version whose EffectiveDate is the latest one <= today.
	today := time.Now().UTC().Format("2006-01-02")
	var current *dbpkg.MasterBudget
	for i := range versions {
		ed := versions[i].EffectiveDate
		if ed == "" || ed <= today {
			current = &versions[i]
		}
	}
	// Fallback: if all versions are future-dated, use the earliest.
	if current == nil {
		current = &versions[0]
	}

	body, _ := json.Marshal(getMasterBudgetResponse{
		Versions: versions,
		Current:  current,
	})
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

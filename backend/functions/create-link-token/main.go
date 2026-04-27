package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	auth "github.com/smcdermott/finance-app/internal/auth"
	plaid "github.com/plaid/plaid-go/v26/plaid"
	plaidclient "github.com/smcdermott/finance-app/internal/plaid"
)

type response = events.APIGatewayV2HTTPResponse

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil { return *deny, nil }
	client, err := plaidclient.New()
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	userID := plaidclient.UserID()
	country := plaid.CountryCode(plaid.COUNTRYCODE_US)
	products := []plaid.Products{plaid.PRODUCTS_TRANSACTIONS}

	linkReq := plaid.NewLinkTokenCreateRequest(
		"Finance App",
		"en",
		[]plaid.CountryCode{country},
		plaid.LinkTokenCreateRequestUser{
			ClientUserId: userID,
		},
	)
	linkReq.SetProducts(products)

	// Optionally restrict to the webhook URL if set
	if webhookURL := os.Getenv("PLAID_WEBHOOK_URL"); webhookURL != "" {
		linkReq.SetWebhook(webhookURL)
	}

	resp, _, err := client.PlaidApi.LinkTokenCreate(ctx).LinkTokenCreateRequest(*linkReq).Execute()
	if err != nil {
		return errorResponse(http.StatusBadGateway, plaidclient.HandlePlaidError(ctx, err)), nil
	}

	body, _ := json.Marshal(map[string]string{
		"linkToken": resp.GetLinkToken(),
	})
	return response{StatusCode: http.StatusOK, Body: string(body), Headers: jsonHeaders()}, nil
}

func main() {
	lambda.Start(handler)
}

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

var _ = fmt.Sprintf // suppress unused import

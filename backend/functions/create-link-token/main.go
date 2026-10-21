package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	plaid "github.com/plaid/plaid-go/v42/plaid"
	auth "github.com/smcdermott/finance-app/internal/auth"
	dbpkg "github.com/smcdermott/finance-app/internal/db"
	plaidclient "github.com/smcdermott/finance-app/internal/plaid"
)

type response = events.APIGatewayV2HTTPResponse

// linkTokenRequest is optional — an empty/absent body creates a link token
// for connecting a brand-new institution. Supplying itemId requests Plaid
// Link's "update mode" for an existing (e.g. re-authentication-required)
// connection instead.
type linkTokenRequest struct {
	ItemID string `json:"itemId"`
}

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil { return *deny, nil }

	var body linkTokenRequest
	if req.Body != "" {
		_ = json.Unmarshal([]byte(req.Body), &body) // optional body — ignore parse errors
	}

	client, err := plaidclient.New()
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	userID := plaidclient.UserID()
	country := plaid.CountryCode(plaid.COUNTRYCODE_US)

	linkReq := plaid.NewLinkTokenCreateRequest(
		"Finance App",
		"en",
		[]plaid.CountryCode{country},
	)
	linkReq.SetUser(plaid.LinkTokenCreateRequestUser{
		ClientUserId: userID,
	})

	if body.ItemID != "" {
		// Update mode: re-authenticate an existing Item. Plaid requires the
		// existing access token and does not accept `products` in this mode.
		dbClient, err := dbpkg.New(ctx)
		if err != nil {
			return errorResponse(http.StatusInternalServerError, err.Error()), nil
		}
		item, err := dbClient.GetPlaidItem(ctx, userID, body.ItemID)
		if err != nil {
			return errorResponse(http.StatusNotFound, "plaid item not found"), nil
		}
		linkReq.SetAccessToken(item.AccessToken)
	} else {
		linkReq.SetProducts([]plaid.Products{plaid.PRODUCTS_TRANSACTIONS})
	}

	// Redirect URI is required by Plaid for Link's "update mode" (and
	// recommended for new connections to support mobile webviews). Must
	// exactly match an entry in the Plaid Dashboard's Allowed redirect URIs.
	if redirectURI := os.Getenv("PLAID_REDIRECT_URI"); redirectURI != "" {
		linkReq.SetRedirectUri(redirectURI)
	}

	// Optionally restrict to the webhook URL if set
	if webhookURL := os.Getenv("PLAID_WEBHOOK_URL"); webhookURL != "" {
		linkReq.SetWebhook(webhookURL)
	}

	resp, _, err := client.PlaidApi.LinkTokenCreate(ctx).LinkTokenCreateRequest(*linkReq).Execute()
	if err != nil {
		return errorResponse(http.StatusBadGateway, plaidclient.HandlePlaidError(ctx, err)), nil
	}

	body2, _ := json.Marshal(map[string]string{
		"linkToken": resp.GetLinkToken(),
	})
	return response{StatusCode: http.StatusOK, Body: string(body2), Headers: jsonHeaders()}, nil
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

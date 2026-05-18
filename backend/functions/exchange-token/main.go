package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	auth "github.com/smcdermott/finance-app/internal/auth"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	plaid "github.com/plaid/plaid-go/v42/plaid"
	dbpkg "github.com/smcdermott/finance-app/internal/db"
	plaidclient "github.com/smcdermott/finance-app/internal/plaid"
)

type exchangeRequest struct {
	PublicToken     string `json:"publicToken"`
	InstitutionName string `json:"institutionName"`
}

type response = events.APIGatewayV2HTTPResponse

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil { return *deny, nil }
	var body exchangeRequest
	if err := json.Unmarshal([]byte(req.Body), &body); err != nil || body.PublicToken == "" {
		return errorResponse(http.StatusBadRequest, "publicToken is required"), nil
	}

	// Exchange the public token for an access token
	plaidClient, err := plaidclient.New()
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	exchangeResp, _, err := plaidClient.PlaidApi.
		ItemPublicTokenExchange(ctx).
		ItemPublicTokenExchangeRequest(
			*plaid.NewItemPublicTokenExchangeRequest(body.PublicToken),
		).Execute()
	if err != nil {
		return errorResponse(http.StatusBadGateway, plaidclient.HandlePlaidError(ctx, err)), nil
	}

	accessToken := exchangeResp.GetAccessToken()
	itemID := exchangeResp.GetItemId()

	// Fetch accounts associated with this Item
	accountsResp, _, err := plaidClient.PlaidApi.
		AccountsGet(ctx).
		AccountsGetRequest(
			*plaid.NewAccountsGetRequest(accessToken),
		).Execute()
	if err != nil {
		return errorResponse(http.StatusBadGateway, plaidclient.HandlePlaidError(ctx, err)), nil
	}

	// Persist each account to DynamoDB
	awsCfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}
	_ = dynamodb.NewFromConfig(awsCfg) // ensure SDK is linked

	dbClient, err := dbpkg.New(ctx)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	userID := plaidclient.UserID()
	var savedAccounts []dbpkg.Account

	for _, acct := range accountsResp.GetAccounts() {
		record := dbpkg.Account{
			UserID:      userID,
			AccountID:   acct.GetAccountId(),
			AccessToken: accessToken,
			ItemID:      itemID,
			Institution: body.InstitutionName,
			Name:        acct.GetName(),
			Type:        string(acct.GetType()),
			Subtype:     string(acct.GetSubtype()),
			LastSynced:  time.Now().UTC(),
		}
		if err := dbClient.PutAccount(ctx, record); err != nil {
			return errorResponse(http.StatusInternalServerError, fmt.Sprintf("failed to save account: %v", err)), nil
		}
		savedAccounts = append(savedAccounts, record)
	}

	respBody, _ := json.Marshal(map[string]interface{}{
		"accounts": savedAccounts,
		"itemId":   itemID,
	})
	return response{StatusCode: http.StatusOK, Body: string(respBody), Headers: jsonHeaders()}, nil
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

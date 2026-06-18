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

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil { return *deny, nil }
	dbClient, err := dbpkg.New(ctx)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	userID := plaidclient.UserID()
	accounts, err := dbClient.GetAccounts(ctx, userID)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	// Strip access tokens before sending to the frontend
	type safeAccount struct {
		AccountID   string `json:"accountId"`
		ItemID      string `json:"itemId"`
		Institution string `json:"institution"`
		Name        string `json:"name"`
		NickName    string `json:"nickName,omitempty"`
		Type        string `json:"type"`
		Subtype     string `json:"subtype"`
		LastSynced  string `json:"lastSynced"`
		Enabled     *bool  `json:"enabled,omitempty"`
	}
	safe := make([]safeAccount, 0, len(accounts))
	for _, a := range accounts {
		safe = append(safe, safeAccount{
			AccountID:   a.AccountID,
			ItemID:      a.ItemID,
			Institution: a.Institution,
			Name:        a.Name,
			NickName:    a.NickName,
			Type:        a.Type,
			Subtype:     a.Subtype,
			LastSynced:  a.LastSynced.Format("2006-01-02T15:04:05Z"),
			Enabled:     a.Enabled,
		})
	}

	body, _ := json.Marshal(map[string]interface{}{"accounts": safe})
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

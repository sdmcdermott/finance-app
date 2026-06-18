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

type updateRequest struct {
	Enabled  *bool   `json:"enabled"`
	NickName *string `json:"nickName"`
}

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil {
		return *deny, nil
	}

	accountID := req.PathParameters["accountId"]
	if accountID == "" {
		return errorResponse(http.StatusBadRequest, "accountId is required"), nil
	}

	var body updateRequest
	if err := json.Unmarshal([]byte(req.Body), &body); err != nil {
		return errorResponse(http.StatusBadRequest, "invalid request body"), nil
	}
	if body.Enabled == nil && body.NickName == nil {
		return errorResponse(http.StatusBadRequest, "at least one of enabled or nickName is required"), nil
	}

	dbClient, err := dbpkg.New(ctx)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	userID := plaidclient.UserID()

	if body.Enabled != nil {
		if err := dbClient.UpdateAccountEnabled(ctx, userID, accountID, *body.Enabled); err != nil {
			return errorResponse(http.StatusInternalServerError, err.Error()), nil
		}
	}
	if body.NickName != nil {
		if err := dbClient.UpdateAccountNickName(ctx, userID, accountID, *body.NickName); err != nil {
			return errorResponse(http.StatusInternalServerError, err.Error()), nil
		}
	}

	resp := map[string]interface{}{"accountId": accountID}
	if body.Enabled != nil {
		resp["enabled"] = *body.Enabled
	}
	if body.NickName != nil {
		resp["nickName"] = *body.NickName
	}
	out, _ := json.Marshal(resp)
	return response{StatusCode: http.StatusOK, Body: string(out), Headers: jsonHeaders()}, nil
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

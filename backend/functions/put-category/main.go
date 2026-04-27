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

type categoryRequest struct {
	CategoryID string `json:"categoryId"` // omit to create new; include to update
	Name       string `json:"name"`
	Color      string `json:"color"`
}

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil { return *deny, nil }
	var body categoryRequest
	if err := json.Unmarshal([]byte(req.Body), &body); err != nil || body.Name == "" {
		return errorResponse(http.StatusBadRequest, "name is required"), nil
	}

	if body.CategoryID == "" {
		body.CategoryID = uuid.NewString()
	}
	if body.Color == "" {
		body.Color = "#6366f1" // default indigo
	}

	dbClient, err := dbpkg.New(ctx)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	cat := dbpkg.Category{
		UserID:     plaidclient.UserID(),
		CategoryID: body.CategoryID,
		Name:       body.Name,
		Color:      body.Color,
	}

	if err := dbClient.PutCategory(ctx, cat); err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	respBody, _ := json.Marshal(cat)
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

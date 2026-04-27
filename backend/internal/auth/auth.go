// Package auth provides a lightweight helper for Lambda functions to verify
// that a request was authenticated by the Cognito JWT authorizer.
//
// In production, API Gateway rejects unauthenticated requests before the Lambda
// is invoked, so this check is defense-in-depth. Locally (sam local start-api),
// the authorizer is not enforced; setting AUTH_DISABLED=true bypasses the check
// so local development works without real Cognito tokens.
package auth

import (
	"net/http"
	"os"

	"github.com/aws/aws-lambda-go/events"
)

type response = events.APIGatewayV2HTTPResponse

// Check returns a non-nil error response if the request is missing auth context
// and AUTH_DISABLED is not "true". Returns nil when the request should proceed.
func Check(req events.APIGatewayV2HTTPRequest) *response {
	if os.Getenv("AUTH_DISABLED") == "true" {
		return nil
	}
	// API Gateway HTTP API JWT authorizer populates
	// req.RequestContext.Authorizer.JWT when auth succeeds.
	if req.RequestContext.Authorizer.JWT == nil ||
		req.RequestContext.Authorizer.JWT.Claims == nil {
		r := unauthorizedResponse()
		return &r
	}
	return nil
}

func unauthorizedResponse() response {
	return response{
		StatusCode: http.StatusUnauthorized,
		Body:       `{"error":"unauthorized"}`,
		Headers:    map[string]string{"Content-Type": "application/json"},
	}
}

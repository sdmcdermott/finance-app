// Package plaidclient provides a shared Plaid API client configured from
// environment variables.
package plaidclient

import (
	"context"
	"fmt"
	"os"

	plaid "github.com/plaid/plaid-go/v26/plaid"
)

// New returns a configured Plaid API client.
func New() (*plaid.APIClient, error) {
	clientID := os.Getenv("PLAID_CLIENT_ID")
	secret := os.Getenv("PLAID_SECRET")
	plaidEnv := os.Getenv("PLAID_ENV")

	if clientID == "" || secret == "" {
		return nil, fmt.Errorf("PLAID_CLIENT_ID and PLAID_SECRET must be set")
	}

	cfg := plaid.NewConfiguration()
	cfg.AddDefaultHeader("PLAID-CLIENT-ID", clientID)
	cfg.AddDefaultHeader("PLAID-SECRET", secret)

	switch plaidEnv {
	case "production":
		cfg.UseEnvironment(plaid.Production)
	case "development":
		cfg.UseEnvironment(plaid.Development)
	default:
		cfg.UseEnvironment(plaid.Sandbox)
	}

	return plaid.NewAPIClient(cfg), nil
}

// UserID returns a hardcoded user ID — for a single-user personal app this
// is sufficient. Replace with real auth if you ever open the app to others.
func UserID() string {
	userID := os.Getenv("USER_ID")
	if userID == "" {
		return "default-user"
	}
	return userID
}

// HandlePlaidError extracts a human-readable message from a Plaid API error.
func HandlePlaidError(ctx context.Context, err error) string {
	if plaidErr, ok := err.(plaid.GenericOpenAPIError); ok {
		return fmt.Sprintf("plaid error: %s — %s", plaidErr.Error(), string(plaidErr.Body()))
	}
	return err.Error()
}

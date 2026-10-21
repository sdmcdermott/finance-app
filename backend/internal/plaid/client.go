// Package plaidclient provides a shared Plaid API client configured from
// environment variables.
package plaidclient

import (
	"context"
	"fmt"
	"os"

	plaid "github.com/plaid/plaid-go/v42/plaid"
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
	default:
		// Plaid removed the Development tier in 2024; sandbox covers local dev.
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

// ReauthRequiredCodes are Plaid item error codes that indicate the stored
// connection to the institution is no longer valid and the user must
// re-authenticate via Plaid Link's "update mode". This is a normal, expected
// condition — banks periodically invalidate sessions (password changes, MFA
// resets, periodic security re-verification, etc.) — not a bug in Plaid or
// this application.
//
// ITEM_NOT_FOUND is included defensively: it means Plaid has no record of the
// Item at all (e.g. it was removed server-side). Update mode won't succeed in
// that case, but surfacing the same "reconnect" affordance to the user is the
// correct recovery path — Link will guide them through a fresh connection.
var ReauthRequiredCodes = map[string]bool{
	"ITEM_LOGIN_REQUIRED": true,
	"ITEM_NOT_FOUND":      true,
	"PENDING_EXPIRATION":  true,
	"PENDING_DISCONNECT":  true,
}

// ParsePlaidError attempts to extract the structured Plaid error code and
// message from err. ok is false if err is not a recognized Plaid API error.
func ParsePlaidError(err error) (code string, message string, ok bool) {
	if err == nil {
		return "", "", false
	}
	plaidErr, isPlaidErr := plaid.ToPlaidError(err)
	if isPlaidErr != nil {
		return "", "", false
	}
	return plaidErr.GetErrorCode(), plaidErr.GetErrorMessage(), true
}

// NeedsReauth returns true if err represents a Plaid item error that requires
// the user to re-authenticate via Link's update mode.
func NeedsReauth(err error) (code string, message string, needsReauth bool) {
	code, message, ok := ParsePlaidError(err)
	if !ok {
		return "", "", false
	}
	return code, message, ReauthRequiredCodes[code]
}

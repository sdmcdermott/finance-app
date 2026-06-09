package main

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	auth "github.com/smcdermott/finance-app/internal/auth"
	dbpkg "github.com/smcdermott/finance-app/internal/db"
	plaidclient "github.com/smcdermott/finance-app/internal/plaid"
)

type response = events.APIGatewayV2HTTPResponse

type masterBudgetRequest struct {
	EffectiveDate         string                 `json:"effectiveDate"`         // YYYY-MM-DD; empty = legacy singleton
	PreviousEffectiveDate string                 `json:"previousEffectiveDate"` // set when renaming a version's date
	Label                 string                 `json:"label"`
	// Discretionary is the frontend-computed monthly discretionary remainder
	// (total income − fixed costs).  Sent by the client so the backend does not
	// need to re-derive it from income source gross/net pay data.
	Discretionary float64                `json:"discretionary"`
	IncomeSources []dbpkg.MBIncomeSource `json:"incomeSources"`
	FixedCosts    []dbpkg.MBFixedCost    `json:"fixedCosts"`
	Buckets       []dbpkg.MBBucket       `json:"buckets"`
}

type putMasterBudgetResponse struct {
	Version          dbpkg.MasterBudget `json:"version"`
	UpdatedBudgetIDs []string           `json:"updatedBudgetIds"`
}

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil {
		return *deny, nil
	}

	var body masterBudgetRequest
	if err := json.Unmarshal([]byte(req.Body), &body); err != nil {
		return errorResponse(http.StatusBadRequest, "invalid request body"), nil
	}

	// Normalise nil slices to empty so JSON marshals as [] not null.
	if body.IncomeSources == nil { body.IncomeSources = []dbpkg.MBIncomeSource{} }
	if body.FixedCosts    == nil { body.FixedCosts    = []dbpkg.MBFixedCost{} }
	if body.Buckets       == nil { body.Buckets       = []dbpkg.MBBucket{} }

	userID := plaidclient.UserID()

	dbClient, err := dbpkg.New(ctx)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	mb := dbpkg.MasterBudget{
		UserID:        userID,
		EffectiveDate: body.EffectiveDate,
		Label:         body.Label,
		IncomeSources: body.IncomeSources,
		FixedCosts:    body.FixedCosts,
		Buckets:       body.Buckets,
	}

	if err := dbClient.PutMasterBudget(ctx, mb); err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	// If this is a versioned save (has an effectiveDate), delete the legacy
	// singleton item so it no longer appears alongside dated versions.
	if mb.EffectiveDate != "" {
		_ = dbClient.DeleteLegacyMasterBudget(ctx, userID) // best-effort; non-fatal
	}

	// If the user renamed the version's effective date, delete the old versioned item.
	prev := body.PreviousEffectiveDate
	if prev != "" && prev != mb.EffectiveDate {
		_ = dbClient.DeleteMasterBudgetVersion(ctx, userID, prev) // best-effort; non-fatal
	}

	// ── Propagate to linked budgets and their periods ─────────────────────────
	updatedBudgetIDs := propagate(ctx, dbClient, userID, mb, body.Discretionary)

	respBody, _ := json.Marshal(putMasterBudgetResponse{
		Version:          mb,
		UpdatedBudgetIDs: updatedBudgetIDs,
	})
	return response{StatusCode: http.StatusOK, Body: string(respBody), Headers: jsonHeaders()}, nil
}

// propagate pushes each linked bucket's effective monthly amount to the linked
// budget's goal/openingBalance and to any existing BudgetPeriod records that
// fall within this version's effective date range.
// Returns the list of budget IDs that were updated (for cache invalidation on
// the frontend).
func propagate(ctx context.Context, db *dbpkg.Client, userID string, saved dbpkg.MasterBudget, discretionary float64) []string {
	linkedBuckets := make([]dbpkg.MBBucket, 0)
	for _, b := range saved.Buckets {
		if b.LinkedBudgetID != "" {
			linkedBuckets = append(linkedBuckets, b)
		}
	}
	if len(linkedBuckets) == 0 {
		return nil
	}

	// ── Determine effective date range for this version ───────────────────────
	// fromDate: this version's effectiveDate (empty → treat as "0001-01-01").
	// toDate:   the next version's effectiveDate, or open-ended ("2999-12-31").
	allVersions, err := db.GetMasterBudgets(ctx, userID)
	if err != nil {
		return nil // non-fatal; propagation best-effort
	}

	fromDate := saved.EffectiveDate
	if fromDate == "" {
		fromDate = "0001-01-01"
	}
	toDate := "2999-12-31"
	for _, v := range allVersions {
		ed := v.EffectiveDate
		if ed == "" {
			continue
		}
		if ed > fromDate && (ed < toDate) {
			toDate = ed
		}
	}

	// Is this the "current" version (effectiveDate <= today and no later version <= today)?
	today := time.Now().UTC().Format("2006-01-02")
	isCurrent := fromDate <= today && toDate > today

	// ── Pre-compute $ remaining value ─────────────────────────────────────────
	// discretionary is passed in from the frontend (already correctly computed
	// from income source net pay / gross amounts which are not stored here).
	nonRemainingTotal := 0.0
	for _, b := range saved.Buckets {
		if b.AmountType == "remaining" {
			continue
		}
		if b.AmountType == "percent" || (b.AmountType == "" && b.Percent > 0) {
			nonRemainingTotal += discretionary * b.Percent
		} else {
			nonRemainingTotal += b.AmountMonthly
		}
	}
	remainingVal := math.Max(0, round(discretionary-nonRemainingTotal))

	// ── Propagate each linked bucket ──────────────────────────────────────────
	updated := make([]string, 0)

	for _, b := range linkedBuckets {
		// Compute effective monthly amount for this bucket.
		var monthly float64
		switch {
		case b.AmountType == "remaining":
			monthly = remainingVal
		case b.AmountType == "percent" || (b.AmountType == "" && b.Percent > 0):
			monthly = round(discretionary * b.Percent)
		default:
			monthly = round(b.AmountMonthly)
		}

		linkedBudget, err := db.GetBudget(ctx, userID, b.LinkedBudgetID)
		if err != nil || linkedBudget == nil {
			continue
		}

		lt := b.LinkType
		if lt == "" {
			if linkedBudget.BudgetType == "checkbook" {
				lt = "credit"
			} else {
				lt = "goal"
			}
		}

		if lt == "credit" {
			// Checkbook: update openingBalance (and masterBudgetAmount as the indicator)
			// only when this is the current version.
			if isCurrent {
				budgetCopy := *linkedBudget
				additional := math.Max(0, round(linkedBudget.OpeningBalance-linkedBudget.MasterBudgetAmount))
				budgetCopy.MasterBudgetAmount = monthly
				budgetCopy.OpeningBalance = monthly + additional
				_ = db.PutBudget(ctx, budgetCopy)
			}
		} else {
			// Goal: preserve any user-added additional amount on the budget record.
			if isCurrent {
				additional := math.Max(0, round(linkedBudget.GoalAmount-linkedBudget.MasterBudgetAmount))
				budgetCopy := *linkedBudget
				budgetCopy.MasterBudgetAmount = monthly
				budgetCopy.GoalAmount = monthly + additional
				_ = db.PutBudget(ctx, budgetCopy)
			}

			// Update MasterBudgetGoal on all existing periods within the date range.
			periods, err := db.GetBudgetPeriodsByDateRange(ctx, b.LinkedBudgetID, fromDate, toDate)
			if err != nil {
				continue
			}
			for _, p := range periods {
				_ = db.UpdateBudgetPeriodMasterGoal(ctx, b.LinkedBudgetID, p.StartDate, monthly)
			}
		}

		updated = append(updated, b.LinkedBudgetID)
	}

	return updated
}

func round(v float64) float64 { return math.Round(v*100) / 100 }

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

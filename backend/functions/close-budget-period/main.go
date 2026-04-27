package main

// close-budget-period finalises a budget period:
//  1. Computes the surplus or shortfall.
//  2. Applies the configured SurplusHandling (ignore / rollover / transfer).
//  3. Marks the period as closed.
//  4. For "transfer": adds the transferred amount as a rolled-over credit on
//     the destination checkbook budget's current period.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/google/uuid"
	auth "github.com/smcdermott/finance-app/internal/auth"
	dbpkg "github.com/smcdermott/finance-app/internal/db"
	plaidclient "github.com/smcdermott/finance-app/internal/plaid"
)

type response = events.APIGatewayV2HTTPResponse

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil {
		return *deny, nil
	}
	budgetID := req.PathParameters["budgetId"]
	startDate := req.PathParameters["startDate"]
	if budgetID == "" || startDate == "" {
		return errorResponse(http.StatusBadRequest, "budgetId and startDate path parameters are required"), nil
	}

	userID := plaidclient.UserID()
	dbClient, err := dbpkg.New(ctx)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	budget, err := dbClient.GetBudget(ctx, userID, budgetID)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}
	if budget == nil {
		return errorResponse(http.StatusNotFound, "budget not found"), nil
	}

	period, err := dbClient.GetBudgetPeriod(ctx, budgetID, startDate)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}
	if period == nil {
		return errorResponse(http.StatusNotFound, "period not found"), nil
	}
	if period.Closed {
		return errorResponse(http.StatusConflict, "period is already closed"), nil
	}

	accounts, err := dbClient.GetAccounts(ctx, userID)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	catSet := make(map[string]bool, len(budget.CategoryIDs))
	for _, id := range budget.CategoryIDs {
		catSet[id] = true
	}

	debits, credits := computeTotals(ctx, dbClient, accounts, budget, catSet, period.StartDate, period.EndDate)

	var delta float64 // positive = surplus, negative = shortfall
	switch budget.BudgetType {
	case "goal":
		effectiveGoal := budget.GoalAmount + period.RolledOverAmount
		if budget.GoalDirection == "limit" {
			// surplus = money not spent
			delta = effectiveGoal - debits
		} else {
			// target: surplus = exceeded the target
			delta = debits - effectiveGoal
		}
	case "checkbook":
		delta = budget.OpeningBalance + period.RolledOverAmount + credits - debits
	}

	period.Closed = true

	switch budget.SurplusHandling {
	case "rollover":
		period.RolledOverAmount += delta
		// The next period will inherit this via the RolledOverAmount on the new period.
		// We store a marker on the current period so the UI can display it.
		if err := dbClient.PutBudgetPeriod(ctx, *period); err != nil {
			return errorResponse(http.StatusInternalServerError, err.Error()), nil
		}
		// Open the next period with the rolled-over amount
		nextStart, nextEnd := dbpkg.PeriodDates(budget.Period, nextPeriodRef(budget.Period, period.EndDate))
		nextLabel := dbpkg.FormatPeriodLabel(budget.Name, budget.PeriodFormat, nextStart)
		nextPeriod := dbpkg.BudgetPeriod{
			PeriodID:         uuid.NewString(),
			BudgetID:         budgetID,
			StartDate:        nextStart,
			EndDate:          nextEnd,
			Label:            nextLabel,
			RolledOverAmount: delta,
		}
		if err := dbClient.PutBudgetPeriod(ctx, nextPeriod); err != nil {
			return errorResponse(http.StatusInternalServerError, err.Error()), nil
		}

	case "transfer":
		// Transfer to destination checkbook budget's current period
		amount := budget.TransferAmount
		if amount == 0 {
			amount = math.Abs(delta)
		}
		period.TransferredOut = amount
		if err := dbClient.PutBudgetPeriod(ctx, *period); err != nil {
			return errorResponse(http.StatusInternalServerError, err.Error()), nil
		}
		if budget.TransferBudgetID != "" {
			destBudget, err := dbClient.GetBudget(ctx, userID, budget.TransferBudgetID)
			if err == nil && destBudget != nil {
				destStart, destEnd := dbpkg.PeriodDates(destBudget.Period, time.Now())
				destPeriod, err := dbClient.GetBudgetPeriod(ctx, budget.TransferBudgetID, destStart)
				if err == nil {
					if destPeriod == nil {
						destLabel := dbpkg.FormatPeriodLabel(destBudget.Name, destBudget.PeriodFormat, destStart)
						destPeriod = &dbpkg.BudgetPeriod{
							PeriodID:  uuid.NewString(),
							BudgetID:  budget.TransferBudgetID,
							StartDate: destStart,
							EndDate:   destEnd,
							Label:     destLabel,
						}
					}
					destPeriod.RolledOverAmount += amount
					_ = dbClient.PutBudgetPeriod(ctx, *destPeriod)
				}
			}
		}

	default: // "ignore" or unset
		if err := dbClient.PutBudgetPeriod(ctx, *period); err != nil {
			return errorResponse(http.StatusInternalServerError, err.Error()), nil
		}
	}

	body, _ := json.Marshal(map[string]interface{}{
		"closed":  true,
		"delta":   delta,
		"debits":  debits,
		"credits": credits,
	})
	return response{StatusCode: http.StatusOK, Body: string(body), Headers: jsonHeaders()}, nil
}

// computeTotals is duplicated here to keep each Lambda self-contained.
// When a transaction has splits, each split is evaluated independently.
func computeTotals(
	ctx context.Context,
	dbClient *dbpkg.Client,
	accounts []dbpkg.Account,
	budget *dbpkg.Budget,
	catSet map[string]bool,
	startDate, endDate string,
) (debits, credits float64) {
	for _, acct := range accounts {
		txns, err := dbClient.GetTransactions(ctx, acct.AccountID, startDate, endDate)
		if err != nil {
			continue
		}
		splitMap, err := dbClient.GetSplitsForRange(ctx, acct.AccountID, startDate, endDate)
		if err != nil {
			splitMap = map[string][]dbpkg.TransactionSplit{}
		}
		for _, t := range txns {
			if t.Pending {
				continue
			}
			splits := splitMap[t.DateTransactionID]
			if len(splits) > 0 {
				for _, sp := range splits {
					inBudget := false
					if sp.BudgetID != "" {
						inBudget = sp.BudgetID == budget.BudgetID
					} else if sp.CustomCategory != "" {
						inBudget = catSet[sp.CustomCategory]
					}
					if !inBudget {
						continue
					}
					if sp.Amount > 0 {
						debits += sp.Amount
					} else {
						credits += -sp.Amount
					}
				}
			} else {
				effectiveBudget := ""
				if t.ManualBudget {
					effectiveBudget = t.BudgetID
				} else if t.CustomCategory != "" && catSet[t.CustomCategory] {
					effectiveBudget = budget.BudgetID
				}
				if effectiveBudget != budget.BudgetID {
					continue
				}
				if t.Amount > 0 {
					debits += t.Amount
				} else {
					credits += -t.Amount
				}
			}
		}
	}
	return
}

// nextPeriodRef returns a time that falls inside the period following endDate.
func nextPeriodRef(period, endDate string) time.Time {
	t, err := time.Parse("2006-01-02", endDate)
	if err != nil {
		return time.Now().AddDate(0, 1, 0)
	}
	switch period {
	case "daily":
		return t.AddDate(0, 0, 1)
	case "weekly":
		return t.AddDate(0, 0, 1)
	case "biweekly":
		return t.AddDate(0, 0, 1)
	case "monthly":
		return t.AddDate(0, 1, 0)
	case "quarterly":
		return t.AddDate(0, 3, 0)
	case "annually":
		return t.AddDate(1, 0, 0)
	default:
		return t.AddDate(0, 1, 0)
	}
}

// Ensure fmt is used (for FormatPeriodLabel via dbpkg).
var _ = fmt.Sprintf

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

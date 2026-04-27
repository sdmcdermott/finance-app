package main

// get-budget-period returns all stored periods for a budget and also
// ensures the current period exists (auto-creates it if needed).
// The response includes computed totals (debit sum, credit sum, balance)
// derived from transactions in each period's date range.

import (
	"context"
	"encoding/json"
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

type periodWithTotals struct {
	dbpkg.BudgetPeriod
	DebitTotal  float64 `json:"debitTotal"`
	CreditTotal float64 `json:"creditTotal"`
	// For goal budgets: effectiveGoal = GoalAmount ± rolledOver
	EffectiveGoal float64 `json:"effectiveGoal"`
	// For checkbook budgets: balance = openingBalance + rolledOver + credits - debits
	Balance float64 `json:"balance"`
}

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil {
		return *deny, nil
	}
	budgetID := req.PathParameters["budgetId"]
	if budgetID == "" {
		return errorResponse(http.StatusBadRequest, "budgetId path parameter is required"), nil
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

	// Ensure current period exists
	startDate, endDate := dbpkg.PeriodDates(budget.Period, time.Now())
	current, err := dbClient.GetBudgetPeriod(ctx, budgetID, startDate)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}
	if current == nil {
		label := dbpkg.FormatPeriodLabel(budget.Name, budget.PeriodFormat, startDate)
		current = &dbpkg.BudgetPeriod{
			PeriodID:  uuid.NewString(),
			BudgetID:  budgetID,
			StartDate: startDate,
			EndDate:   endDate,
			Label:     label,
		}
		if err := dbClient.PutBudgetPeriod(ctx, *current); err != nil {
			return errorResponse(http.StatusInternalServerError, err.Error()), nil
		}
	}

	// Fetch all periods
	periods, err := dbClient.GetBudgetPeriods(ctx, budgetID)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	// Fetch accounts once for transaction lookups
	accounts, err := dbClient.GetAccounts(ctx, userID)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	// Build category set for this budget
	catSet := make(map[string]bool, len(budget.CategoryIDs))
	for _, id := range budget.CategoryIDs {
		catSet[id] = true
	}

	result := make([]periodWithTotals, 0, len(periods))
	for _, p := range periods {
		debits, credits := computeTotals(ctx, dbClient, accounts, budget, catSet, p.StartDate, p.EndDate)
		pw := periodWithTotals{
			BudgetPeriod: p,
			DebitTotal:   debits,
			CreditTotal:  credits,
		}
		if budget.BudgetType == "goal" {
			pw.EffectiveGoal = budget.GoalAmount + p.RolledOverAmount
		} else {
			pw.Balance = budget.OpeningBalance + p.RolledOverAmount + credits - debits
		}
		result = append(result, pw)
	}

	body, _ := json.Marshal(map[string]interface{}{
		"budget":  budget,
		"periods": result,
	})
	return response{StatusCode: http.StatusOK, Body: string(body), Headers: jsonHeaders()}, nil
}

// computeTotals sums debits and credits for transactions in [startDate, endDate]
// that belong to the budget's categories (or have a manual budgetId override).
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

		// Fetch splits for this account/range
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
				// Transaction is subdivided — evaluate each split independently
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
				// No splits — use transaction-level category/budget
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

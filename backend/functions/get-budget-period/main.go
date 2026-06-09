package main

// get-budget-period returns all stored periods for a budget and also
// ensures the current period exists (auto-creates it if needed).
// The response includes computed totals (debit sum, credit sum, balance)
// derived from transactions in each period's date range, plus the
// individual transaction rows included in those totals.

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

// BudgetTxn is a flattened row for a transaction (or split) contributing to
// this budget's totals.
type BudgetTxn struct {
	Date              string  `json:"date"`
	Name              string  `json:"name"`
	Amount            float64 `json:"amount"` // positive = debit, negative = credit
	AccountID         string  `json:"accountId"`
	DateTransactionID string  `json:"dateTransactionId"`
	IsSplit           bool    `json:"isSplit,omitempty"`
}

type periodWithTotals struct {
	dbpkg.BudgetPeriod
	DebitTotal  float64     `json:"debitTotal"`
	CreditTotal float64     `json:"creditTotal"`
	// For goal budgets: effectiveGoal = GoalAmount + carry-in RolledOverAmount
	EffectiveGoal float64    `json:"effectiveGoal"`
	// For checkbook budgets: balance = openingBalance + carry-in + credits - debits
	Balance      float64     `json:"balance"`
	// LiveDelta is the live-computed surplus/shortfall for this period.
	// For goal/limit:  effectiveGoal - debits  (positive = under, negative = over)
	// For goal/target: debits - effectiveGoal  (positive = met/exceeded)
	// For checkbook:   balance (same as Balance above)
	// This is what a subsequent period's RolledOverAmount was seeded from at close
	// time, but is always recomputed so late transactions are reflected accurately.
	LiveDelta    float64     `json:"liveDelta"`
	Transactions []BudgetTxn `json:"transactions"`
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

	// Fetch accounts once — used for both ensurePeriodsForTransactions and computeTotals.
	accounts, err := dbClient.GetAccounts(ctx, userID)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	// Auto-create periods for any transactions assigned to this budget that fall
	// outside already-stored periods.
	if err := ensurePeriodsForTransactions(ctx, dbClient, userID, budget, accounts); err != nil {
		// non-fatal: log and continue; worst case the period just won't appear yet
		_ = err
	}

	// Fetch all periods
	periods, err := dbClient.GetBudgetPeriods(ctx, budgetID)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	result := make([]periodWithTotals, 0, len(periods))
	for _, p := range periods {
		debits, credits, txns := computeTotals(ctx, dbClient, accounts, budget, p.StartDate, p.EndDate)
		pw := periodWithTotals{
			BudgetPeriod: p,
			DebitTotal:   debits,
			CreditTotal:  credits,
			Transactions: txns,
		}
		if budget.BudgetType == "goal" {
			periodGoal := budget.GoalAmount
			if p.MasterBudgetGoal > 0 {
				periodGoal = p.MasterBudgetGoal
			}
			effectiveGoal := periodGoal + p.RolledOverAmount
			pw.EffectiveGoal = effectiveGoal
			if budget.GoalDirection == "limit" {
				pw.LiveDelta = effectiveGoal - debits
			} else {
				pw.LiveDelta = debits - effectiveGoal
			}
		} else {
			pw.Balance = budget.OpeningBalance + p.RolledOverAmount + credits - debits
			pw.LiveDelta = pw.Balance
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
// that are directly assigned to this budget (txn.BudgetID == budget.BudgetID).
// When a transaction has splits, each split is evaluated independently.
// Returns debits, credits, and the individual rows that contributed.
func computeTotals(
	ctx context.Context,
	dbClient *dbpkg.Client,
	accounts []dbpkg.Account,
	budget *dbpkg.Budget,
	startDate, endDate string,
) (debits, credits float64, rows []BudgetTxn) {
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
					if sp.BudgetID != budget.BudgetID {
						continue
					}
					if sp.Amount > 0 {
						debits += sp.Amount
					} else {
						credits += -sp.Amount
					}
					rows = append(rows, BudgetTxn{
						Date:              t.Date,
						Name:              t.Name,
						Amount:            sp.Amount,
						AccountID:         acct.AccountID,
						DateTransactionID: t.DateTransactionID,
						IsSplit:           true,
					})
				}
			} else {
				if t.BudgetID != budget.BudgetID {
					continue
				}
				if t.Amount > 0 {
					debits += t.Amount
				} else {
					credits += -t.Amount
				}
				rows = append(rows, BudgetTxn{
					Date:              t.Date,
					Name:              t.Name,
					Amount:            t.Amount,
					AccountID:         acct.AccountID,
					DateTransactionID: t.DateTransactionID,
				})
			}
		}
	}
	return
}

// ensurePeriodsForTransactions scans all transactions assigned to the budget,
// determines which period each one belongs to, and creates any missing periods.
func ensurePeriodsForTransactions(
	ctx context.Context,
	dbClient *dbpkg.Client,
	userID string,
	budget *dbpkg.Budget,
	accounts []dbpkg.Account,
) error {
	// Collect every unique period start-date that has at least one matching transaction.
	needed := map[string]string{} // startDate → endDate

	for _, acct := range accounts {
		txns, err := dbClient.GetTransactions(ctx, acct.AccountID, "2000-01-01", "2999-12-31")
		if err != nil {
			continue
		}
		splitMap, err := dbClient.GetSplitsForRange(ctx, acct.AccountID, "2000-01-01", "2999-12-31")
		if err != nil {
			splitMap = map[string][]dbpkg.TransactionSplit{}
		}

		for _, t := range txns {
			if t.Pending {
				continue
			}
			splits := splitMap[t.DateTransactionID]
			matched := false
			if len(splits) > 0 {
				for _, sp := range splits {
					if sp.BudgetID == budget.BudgetID {
						matched = true
						break
					}
				}
			} else {
				matched = t.BudgetID == budget.BudgetID
			}
			if !matched {
				continue
			}

			ref, err := time.Parse("2006-01-02", t.Date)
			if err != nil {
				continue
			}
			s, e := dbpkg.PeriodDates(budget.Period, ref)
			needed[s] = e
		}
	}

	if len(needed) == 0 {
		return nil
	}

	// Fetch existing periods so we don't duplicate.
	existing, err := dbClient.GetBudgetPeriods(ctx, budget.BudgetID)
	if err != nil {
		return err
	}
	covered := map[string]bool{}
	for _, p := range existing {
		covered[p.StartDate] = true
	}

	for s, e := range needed {
		if covered[s] {
			continue
		}
		label := dbpkg.FormatPeriodLabel(budget.Name, budget.PeriodFormat, s)
		p := dbpkg.BudgetPeriod{
			PeriodID:  uuid.NewString(),
			BudgetID:  budget.BudgetID,
			StartDate: s,
			EndDate:   e,
			Label:     label,
		}
		if err := dbClient.PutBudgetPeriod(ctx, p); err != nil {
			return err
		}
	}
	return nil
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

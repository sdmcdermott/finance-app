package main

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	auth "github.com/smcdermott/finance-app/internal/auth"
	dbpkg "github.com/smcdermott/finance-app/internal/db"
	plaidclient "github.com/smcdermott/finance-app/internal/plaid"
)

type response = events.APIGatewayV2HTTPResponse

// IncomeVariance holds expected vs actual for one income source for a given month.
type IncomeVariance struct {
	IncomeSourceID  string  `json:"incomeSourceId"`
	ExpectedMonthly float64 `json:"expectedMonthly"`
	Actual          float64 `json:"actual"`       // sum of matched deposit amounts (negative = credit)
	Variance        float64 `json:"variance"`     // actual - expected (positive = more than expected)
	MatchedCount    int     `json:"matchedCount"` // number of transactions matched
}

// FixedCostVariance holds expected vs actual for one fixed cost for a given month.
type FixedCostVariance struct {
	FixedCostID     string  `json:"fixedCostId"`
	Name            string  `json:"name"`
	ExpectedMonthly float64 `json:"expectedMonthly"`
	Actual          float64 `json:"actual"`
	Variance        float64 `json:"variance"`
	MatchedCount    int     `json:"matchedCount"`
}

type varianceResponse struct {
	Month      string              `json:"month"` // YYYY-MM
	Income     []IncomeVariance    `json:"income"`
	FixedCosts []FixedCostVariance `json:"fixedCosts"`
}

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil {
		return *deny, nil
	}

	// ?month=YYYY-MM  (defaults to current month)
	month := req.QueryStringParameters["month"]
	if month == "" {
		month = time.Now().UTC().Format("2006-01")
	}
	startDate := month + "-01"
	t, err := time.Parse("2006-01", month)
	if err != nil {
		return errorResponse(http.StatusBadRequest, "invalid month format, use YYYY-MM"), nil
	}
	endDate := t.AddDate(0, 1, -1).Format("2006-01-02")

	dbClient, err := dbpkg.New(ctx)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}
	userID := plaidclient.UserID()

	// Load master budget for expected values — use the version effective on the queried month.
	mb, err := dbClient.GetEffectiveMasterBudget(ctx, userID, startDate)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}
	// Guard against no master budget being configured yet.
	if mb == nil {
		mb = &dbpkg.MasterBudget{}
	}

	// Load all accounts then fetch transactions for the month
	accounts, err := dbClient.GetAccounts(ctx, userID)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	var allTxns []dbpkg.Transaction
	for _, acct := range accounts {
		if !dbpkg.AccountEnabled(acct) {
			continue
		}
		txns, err := dbClient.GetTransactions(ctx, acct.AccountID, startDate, endDate)
		if err != nil {
			continue
		}
		allTxns = append(allTxns, txns...)
	}

	// ── Income variance ───────────────────────────────────────────────────────
	// Build a map: incomeSourceId -> sum of matched transaction amounts
	incomeActuals := make(map[string]struct {
		sum   float64
		count int
	})
	for _, txn := range allTxns {
		if strings.HasPrefix(txn.BudgetID, dbpkg.IncomeBudgetPrefix) {
			srcID := strings.TrimPrefix(txn.BudgetID, dbpkg.IncomeBudgetPrefix)
			e := incomeActuals[srcID]
			// Income deposits are negative amounts in Plaid (credits)
			e.sum += math.Abs(txn.Amount)
			e.count++
			incomeActuals[srcID] = e
		}
	}

	// Load income sources to get net pay
	incomeSources, err := dbClient.GetIncomeSources(ctx, userID)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}
	srcByID := make(map[string]dbpkg.IncomeSource, len(incomeSources))
	for _, s := range incomeSources {
		srcByID[s.IncomeSourceID] = s
	}

	incomeVariances := make([]IncomeVariance, 0)
	for _, mbi := range mb.IncomeSources {
		if !mbi.Enabled {
			continue
		}
		src, ok := srcByID[mbi.IncomeSourceID]
		if !ok {
			continue
		}
		// Expected monthly: override takes precedence, else computed net pay
		var expected float64
		if mbi.MonthlyOverride > 0 {
			expected = mbi.MonthlyOverride
		} else {
			netPerPeriod := src.GrossAmount
			if src.LastNetPay != nil {
				netPerPeriod = src.LastNetPay.NetPay
			}
			expected = monthlyAmount(netPerPeriod, src.Frequency)
		}

		actual := incomeActuals[mbi.IncomeSourceID]
		incomeVariances = append(incomeVariances, IncomeVariance{
			IncomeSourceID:  mbi.IncomeSourceID,
			ExpectedMonthly: expected,
			Actual:          actual.sum,
			Variance:        actual.sum - expected,
			MatchedCount:    actual.count,
		})
	}

	// ── Fixed cost variance ───────────────────────────────────────────────────
	// Collect transactions already assigned to __master_budget__
	var masterTxns []dbpkg.Transaction
	for _, txn := range allTxns {
		if txn.BudgetID == dbpkg.MasterBudgetID {
			masterTxns = append(masterTxns, txn)
		}
	}

	// Load rules so we can match via rule pattern when a fixed cost has a ruleId.
	rules, err := dbClient.GetRules(ctx, userID)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}
	ruleByID := make(map[string]dbpkg.Rule, len(rules))
	for _, r := range rules {
		ruleByID[r.RuleID] = r
	}

	fixedCostVariances := make([]FixedCostVariance, 0)
	for _, fc := range mb.FixedCosts {
		expected := monthlyAmount(fc.Amount, fc.Frequency)
		var actualSum float64
		var actualCount int

		for _, txn := range masterTxns {
			merchant := strings.ToLower(txn.MerchantName)
			if merchant == "" {
				merchant = strings.ToLower(txn.Name)
			}
			var matched bool
			if fc.RuleID != "" {
				if rule, ok := ruleByID[fc.RuleID]; ok {
					matched = strings.Contains(merchant, strings.ToLower(rule.Pattern))
					// Apply optional amount filter — mirrors ApplyRulesToTransactions
					if matched && rule.AmountMatch > 0 {
						diff := math.Abs(math.Abs(txn.Amount) - rule.AmountMatch)
						if diff > rule.AmountTolerance {
							matched = false
						}
					}
					// Apply optional day-of-month filter — mirrors ApplyRulesToTransactions
					if matched && rule.DayOfMonth > 0 {
						if t, err := time.Parse("2006-01-02", txn.Date); err == nil {
							day := t.Day()
							daysInMonth := time.Date(t.Year(), t.Month()+1, 0, 0, 0, 0, 0, time.UTC).Day()
							diff := day - rule.DayOfMonth
							if diff < 0 {
								diff = -diff
							}
							if diff > daysInMonth/2 {
								diff = daysInMonth - diff
							}
							if diff > rule.DayTolerance {
								matched = false
							}
						}
					}
				}
			} else {
				// Legacy fallback: match by fixed cost name substring
				matched = strings.Contains(merchant, strings.ToLower(fc.Name))
			}
			if matched {
				actualSum += math.Abs(txn.Amount)
				actualCount++
			}
		}

		fixedCostVariances = append(fixedCostVariances, FixedCostVariance{
			FixedCostID:     fc.ID,
			Name:            fc.Name,
			ExpectedMonthly: expected,
			Actual:          actualSum,
			Variance:        actualSum - expected,
			MatchedCount:    actualCount,
		})
	}

	out, _ := json.Marshal(varianceResponse{
		Month:      month,
		Income:     incomeVariances,
		FixedCosts: fixedCostVariances,
	})
	return response{StatusCode: http.StatusOK, Body: string(out), Headers: jsonHeaders()}, nil
}

// monthlyAmount converts an amount + frequency to a monthly equivalent.
func monthlyAmount(amount float64, frequency string) float64 {
	switch frequency {
	case "weekly":
		return amount * 52 / 12
	case "biweekly":
		return amount * 26 / 12
	case "semimonthly":
		return amount * 2
	case "monthly":
		return amount
	case "quarterly":
		return amount / 3
	case "semiannually":
		return amount / 6
	case "annually":
		return amount / 12
	default:
		return amount
	}
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

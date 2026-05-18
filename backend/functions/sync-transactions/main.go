package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"sort"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/google/uuid"
	auth "github.com/smcdermott/finance-app/internal/auth"
	dbpkg "github.com/smcdermott/finance-app/internal/db"
	plaidclient "github.com/smcdermott/finance-app/internal/plaid"
	plaid "github.com/plaid/plaid-go/v42/plaid"
)

// dualEvent is the raw Lambda event payload. We inspect it to decide whether
// it arrived from EventBridge Scheduler (no "requestContext") or API Gateway.
type dualEvent struct {
	// API Gateway V2 fields
	RequestContext *events.APIGatewayV2HTTPRequestContext `json:"requestContext,omitempty"`
	Headers        map[string]string                      `json:"headers,omitempty"`
	RawPath        string                                 `json:"rawPath,omitempty"`
	Body           string                                 `json:"body,omitempty"`
}

type syncResult struct {
	Added    int `json:"added"`
	Modified int `json:"modified"`
	Removed  int `json:"removed"`
	Errors   int `json:"errors"`
}

func handler(ctx context.Context, raw json.RawMessage) (interface{}, error) {
	var event dualEvent
	_ = json.Unmarshal(raw, &event)

	isHTTP := event.RequestContext != nil

	if isHTTP {
		// Reconstruct a proper APIGatewayV2HTTPRequest so auth.Check works
		var req events.APIGatewayV2HTTPRequest
		_ = json.Unmarshal(raw, &req)
		if deny := auth.Check(req); deny != nil {
			return deny, nil
		}
	}

	result, err := runSync(ctx)
	if err != nil {
		if isHTTP {
			body, _ := json.Marshal(map[string]string{"error": err.Error()})
			return events.APIGatewayV2HTTPResponse{
				StatusCode: http.StatusInternalServerError,
				Body:       string(body),
				Headers:    jsonHeaders(),
			}, nil
		}
		return nil, err
	}

	if isHTTP {
		body, _ := json.Marshal(result)
		return events.APIGatewayV2HTTPResponse{
			StatusCode: http.StatusOK,
			Body:       string(body),
			Headers:    jsonHeaders(),
		}, nil
	}
	return nil, nil
}

// runSync performs the Plaid /transactions/sync for all accounts.
func runSync(ctx context.Context) (*syncResult, error) {
	dbClient, err := dbpkg.New(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to create db client: %w", err)
	}

	plaidAPI, err := plaidclient.New()
	if err != nil {
		return nil, fmt.Errorf("failed to create plaid client: %w", err)
	}

	userID := plaidclient.UserID()
	accounts, err := dbClient.GetAccounts(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get accounts: %w", err)
	}

	// Group accounts by Plaid Item (one Item can have multiple accounts)
	type itemGroup struct {
		accessToken string
		accounts    []dbpkg.Account
	}
	itemMap := make(map[string]*itemGroup)
	for _, acct := range accounts {
		if _, ok := itemMap[acct.ItemID]; !ok {
			itemMap[acct.ItemID] = &itemGroup{accessToken: acct.AccessToken}
		}
		itemMap[acct.ItemID].accounts = append(itemMap[acct.ItemID].accounts, acct)
	}

	result := &syncResult{}

	// Collect all written transactions across all items so we can reconcile
	// closed periods once at the end.
	var allWritten []dbpkg.Transaction

	for itemID, group := range itemMap {
		log.Printf("syncing item %s (%d accounts)", itemID, len(group.accounts))

		cursor := group.accounts[0].SyncCursor

		var added, modified []plaid.Transaction
		var removed []plaid.RemovedTransaction
		hasMore := true

		for hasMore {
			syncReq := plaid.NewTransactionsSyncRequest(group.accessToken)
			if cursor != "" {
				syncReq.SetCursor(cursor)
			}
			resp, _, err := plaidAPI.PlaidApi.
				TransactionsSync(ctx).
				TransactionsSyncRequest(*syncReq).
				Execute()
			if err != nil {
				log.Printf("error syncing item %s: %v", itemID, plaidclient.HandlePlaidError(ctx, err))
				result.Errors++
				break
			}

			added = append(added, resp.GetAdded()...)
			modified = append(modified, resp.GetModified()...)
			removed = append(removed, resp.GetRemoved()...)
			cursor = resp.GetNextCursor()
			hasMore = resp.GetHasMore()
		}

		result.Added += len(added)
		result.Modified += len(modified)
		result.Removed += len(removed)

		log.Printf("item %s: +%d ~%d -%d", itemID, len(added), len(modified), len(removed))

		// Upsert added and modified transactions
		var toWrite []dbpkg.Transaction
		for _, t := range append(added, modified...) {
			txn := dbpkg.Transaction{
				AccountID:         t.GetAccountId(),
				DateTransactionID: fmt.Sprintf("%s#%s", t.GetDate(), t.GetTransactionId()),
				TransactionID:     t.GetTransactionId(),
				Date:              t.GetDate(),
				Name:              t.GetName(),
				Amount:            float64(t.GetAmount()),
				Category:          firstCategory(t.GetCategory()),
				Pending:           t.GetPending(),
				MerchantName:      t.GetMerchantName(),
				OriginalDescription: nullableStr(t.OriginalDescription),
				AuthorizedDate:      nullableStr(t.AuthorizedDate),
				PaymentChannel:      t.GetPaymentChannel(),
				LogoURL:             nullableStr(t.LogoUrl),
			}
			if pfc, ok := t.GetPersonalFinanceCategoryOk(); ok && pfc != nil {
				txn.PersonalFinancePrimary = pfc.GetPrimary()
				txn.PersonalFinanceDetailed = pfc.GetDetailed()
			}
			toWrite = append(toWrite, txn)
		}
		if len(toWrite) > 0 {
			if err := dbClient.PutTransactions(ctx, toWrite); err != nil {
				log.Printf("error writing transactions for item %s: %v", itemID, err)
				result.Errors++
			}

			// Apply auto-assignment rules to newly written transactions
			rules, err := dbClient.GetRules(ctx, userID)
			if err != nil {
				log.Printf("error fetching rules for item %s: %v", itemID, err)
			} else if len(rules) > 0 {
				updated := dbpkg.ApplyRulesToTransactions(rules, toWrite)
				if err := dbClient.PutTransactions(ctx, updated); err != nil {
					log.Printf("error writing rule-applied transactions for item %s: %v", itemID, err)
					result.Errors++
				}
				allWritten = append(allWritten, updated...)
			} else {
				allWritten = append(allWritten, toWrite...)
			}
		}

		// Update sync cursor on every account belonging to this Item
		for _, acct := range group.accounts {
			if err := dbClient.UpdateSyncCursor(ctx, userID, acct.AccountID, cursor); err != nil {
				log.Printf("error updating cursor for account %s: %v", acct.AccountID, err)
				result.Errors++
			}
		}
	}

	// Reconcile closed periods for any budget affected by the new transactions.
	if len(allWritten) > 0 {
		if err := reconcileClosedPeriods(ctx, dbClient, userID, accounts, allWritten); err != nil {
			log.Printf("error reconciling closed periods: %v", err)
		}
	}

	return result, nil
}

// reconcileClosedPeriods checks every budget for closed periods that received
// new transactions.  The most-recently-closed period is automatically re-closed;
// older affected periods get StaleWarning = true so the user can re-close them
// manually.
func reconcileClosedPeriods(
	ctx context.Context,
	dbClient *dbpkg.Client,
	userID string,
	accounts []dbpkg.Account,
	written []dbpkg.Transaction,
) error {
	budgets, err := dbClient.GetBudgets(ctx, userID)
	if err != nil {
		return err
	}

	for i := range budgets {
		budget := &budgets[i]

		// Collect the set of period start-dates that contain at least one of the
		// written transactions assigned to this budget.
		affected := map[string]bool{}
		for _, t := range written {
			if t.Pending || t.BudgetID != budget.BudgetID {
				continue
			}
			ref, err := time.Parse("2006-01-02", t.Date)
			if err != nil {
				continue
			}
			start, _ := dbpkg.PeriodDates(budget.Period, ref)
			affected[start] = true
		}
		if len(affected) == 0 {
			continue
		}

		// Fetch all periods for this budget.
		periods, err := dbClient.GetBudgetPeriods(ctx, budget.BudgetID)
		if err != nil {
			continue
		}

		// Separate closed periods into those that are affected.
		var closedAffected []dbpkg.BudgetPeriod
		for _, p := range periods {
			if p.Closed && affected[p.StartDate] {
				closedAffected = append(closedAffected, p)
			}
		}
		if len(closedAffected) == 0 {
			continue
		}

		// Sort by StartDate descending — most recent first.
		sort.Slice(closedAffected, func(i, j int) bool {
			return closedAffected[i].StartDate > closedAffected[j].StartDate
		})

		// The most-recently-closed affected period is re-closed automatically.
		latestPeriod := closedAffected[0]
		if err := reClosePeriod(ctx, dbClient, budget, &latestPeriod, periods); err != nil {
			log.Printf("auto re-close failed for budget %s period %s: %v",
				budget.BudgetID, latestPeriod.StartDate, err)
		} else {
			log.Printf("auto re-closed period %s for budget %s",
				latestPeriod.StartDate, budget.BudgetID)
		}

		// All older affected closed periods get StaleWarning = true.
		for _, p := range closedAffected[1:] {
			p.StaleWarning = true
			if err := dbClient.PutBudgetPeriod(ctx, p); err != nil {
				log.Printf("error setting stale warning on period %s: %v", p.StartDate, err)
			}
		}
	}
	return nil
}

// reClosePeriod recomputes the delta for a closed period and propagates the
// updated carry-in to the next period (same logic as close-budget-period with
// force=true).
func reClosePeriod(
	ctx context.Context,
	dbClient *dbpkg.Client,
	budget *dbpkg.Budget,
	period *dbpkg.BudgetPeriod,
	allPeriods []dbpkg.BudgetPeriod,
) error {
	accounts, err := dbClient.GetAccounts(ctx, plaidclient.UserID())
	if err != nil {
		return err
	}

	debits, credits := dbClient.ComputePeriodTotals(ctx, accounts, budget, period.StartDate, period.EndDate)

	var delta float64
	switch budget.BudgetType {
	case "goal":
		effectiveGoal := budget.GoalAmount + period.RolledOverAmount
		if budget.GoalDirection == "limit" {
			delta = effectiveGoal - debits
		} else {
			delta = debits - effectiveGoal
		}
	case "checkbook":
		delta = budget.OpeningBalance + period.RolledOverAmount + credits - debits
	}

	switch budget.SurplusHandling {
	case "rollover":
		if err := dbClient.PutBudgetPeriod(ctx, *period); err != nil {
			return err
		}
		nextStart, nextEnd := dbpkg.PeriodDates(budget.Period, nextPeriodRef(period.EndDate))
		nextLabel := dbpkg.FormatPeriodLabel(budget.Name, budget.PeriodFormat, nextStart)
		var nextPeriod *dbpkg.BudgetPeriod
		for i := range allPeriods {
			if allPeriods[i].StartDate == nextStart {
				nextPeriod = &allPeriods[i]
				break
			}
		}
		if nextPeriod == nil {
			nextPeriod = &dbpkg.BudgetPeriod{
				PeriodID:  uuid.NewString(),
				BudgetID:  budget.BudgetID,
				StartDate: nextStart,
				EndDate:   nextEnd,
				Label:     nextLabel,
			}
		}
		nextPeriod.RolledOverAmount = delta
		return dbClient.PutBudgetPeriod(ctx, *nextPeriod)

	case "transfer":
		amount := budget.TransferAmount
		if amount == 0 {
			amount = math.Abs(delta)
		}
		period.TransferredOut = amount
		if err := dbClient.PutBudgetPeriod(ctx, *period); err != nil {
			return err
		}
		if budget.TransferBudgetID != "" {
			destBudget, err := dbClient.GetBudget(ctx, plaidclient.UserID(), budget.TransferBudgetID)
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
		return nil

	default: // "ignore" or unset
		return dbClient.PutBudgetPeriod(ctx, *period)
	}
}

// nextPeriodRef returns a time that falls inside the period following endDate.
func nextPeriodRef(endDate string) time.Time {
	t, err := time.Parse("2006-01-02", endDate)
	if err != nil {
		return time.Now().AddDate(0, 1, 0)
	}
	return t.AddDate(0, 0, 1)
}

func nullableStr(ns plaid.NullableString) string {
	if v := ns.Get(); v != nil {
		return *v
	}
	return ""
}

func firstCategory(cats []string) string {
	if len(cats) > 0 {
		return cats[0]
	}
	return "Uncategorized"
}

func jsonHeaders() map[string]string {
	return map[string]string{
		"Content-Type":                "application/json",
		"Access-Control-Allow-Origin": "*",
	}
}

func main() {
	lambda.Start(handler)
}

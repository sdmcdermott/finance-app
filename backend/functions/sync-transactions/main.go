package main

import (
	"context"
	"fmt"
	"log"

	"github.com/aws/aws-lambda-go/lambda"
	plaid "github.com/plaid/plaid-go/v26/plaid"
	dbpkg "github.com/smcdermott/finance-app/internal/db"
	plaidclient "github.com/smcdermott/finance-app/internal/plaid"
)

// handler is triggered by EventBridge Scheduler once per day.
// It uses Plaid's /transactions/sync endpoint which is cursor-based —
// only new/modified/deleted transactions since the last sync are returned.
// This is more efficient than /transactions/get and doesn't cost extra.
func handler(ctx context.Context) error {
	dbClient, err := dbpkg.New(ctx)
	if err != nil {
		return fmt.Errorf("failed to create db client: %w", err)
	}

	plaidAPI, err := plaidclient.New()
	if err != nil {
		return fmt.Errorf("failed to create plaid client: %w", err)
	}

	userID := plaidclient.UserID()
	accounts, err := dbClient.GetAccounts(ctx, userID)
	if err != nil {
		return fmt.Errorf("failed to get accounts: %w", err)
	}

	// Group accounts by access token (one Item can have multiple accounts)
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

	for itemID, group := range itemMap {
		log.Printf("syncing item %s (%d accounts)", itemID, len(group.accounts))

		// Use cursor from the first account in the group (all share the same Item cursor)
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
				break
			}

			added = append(added, resp.GetAdded()...)
			modified = append(modified, resp.GetModified()...)
			removed = append(removed, resp.GetRemoved()...)
			cursor = resp.GetNextCursor()
			hasMore = resp.GetHasMore()
		}

		log.Printf("item %s: +%d ~%d -%d transactions", itemID, len(added), len(modified), len(removed))

		// Upsert added and modified transactions
		var toWrite []dbpkg.Transaction
		for _, t := range append(added, modified...) {
			toWrite = append(toWrite, dbpkg.Transaction{
				AccountID:         t.GetAccountId(),
				DateTransactionID: fmt.Sprintf("%s#%s", t.GetDate(), t.GetTransactionId()),
				TransactionID:     t.GetTransactionId(),
				Date:              t.GetDate(),
				Name:              t.GetName(),
				Amount:            float64(t.GetAmount()),
				Category:          firstCategory(t.GetCategory()),
				Pending:           t.GetPending(),
				MerchantName:      t.GetMerchantName(),
			})
		}
		if len(toWrite) > 0 {
			if err := dbClient.PutTransactions(ctx, toWrite); err != nil {
				log.Printf("error writing transactions for item %s: %v", itemID, err)
			}

			// Apply auto-assignment rules to newly written transactions
			rules, err := dbClient.GetRules(ctx, userID)
			if err != nil {
				log.Printf("error fetching rules for item %s: %v", itemID, err)
			} else if len(rules) > 0 {
				updated := dbpkg.ApplyRulesToTransactions(rules, toWrite)
				if err := dbClient.PutTransactions(ctx, updated); err != nil {
					log.Printf("error writing rule-applied transactions for item %s: %v", itemID, err)
				}
			}
		}

		// Delete removed transactions.
		// Plaid's /transactions/sync returns removed transactions with their
		// transaction_id but not the original date. Because our SK encodes the
		// date, we skip hard deletes here — removed transactions will naturally
		// age out, or a future enhancement can maintain a txnId→date index.
		for _, acct := range group.accounts {
			_ = acct // suppress unused warning; cursor update below
		}
		for _, acct := range group.accounts {
			// Update sync cursor on every account belonging to this Item
			if err := dbClient.UpdateSyncCursor(ctx, userID, acct.AccountID, cursor); err != nil {
				log.Printf("error updating cursor for account %s: %v", acct.AccountID, err)
			}
		}
	}

	return nil
}

func firstCategory(cats []string) string {
	if len(cats) > 0 {
		return cats[0]
	}
	return "Uncategorized"
}

func main() {
	lambda.Start(handler)
}

# Backend build Makefile — used by SAM (BuildMethod: makefile).
# SAM sets ARTIFACTS_DIR and calls the matching build-<FunctionName> target.
# All targets compile from the backend root where go.mod lives.

GOFLAGS ?= -trimpath
GOENV   = GOOS=linux CGO_ENABLED=0

build-CreateLinkTokenFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/create-link-token

build-ExchangeTokenFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/exchange-token

build-GetAccountsFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/get-accounts

build-DeleteAccountFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/delete-account

build-UpdateAccountFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/update-account

build-GetTransactionsFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/get-transactions

build-SyncTransactionsFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/sync-transactions

build-GetCategoriesFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/get-categories

build-PutCategoryFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/put-category

build-DeleteCategoryFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/delete-category

build-UpdateTransactionCategoryFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/update-transaction-category

build-UpdateTransactionReferenceFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/update-transaction-reference

build-UpdateTransactionBudgetFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/update-transaction-budget

build-ImportAmazonCsvFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/import-amazon-csv

build-ConfirmAmazonImportFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/confirm-amazon-import

build-GetRulesFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/get-rules

build-PutRuleFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/put-rule

build-DeleteRuleFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/delete-rule

build-ApplyRulesFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/apply-rules

build-GetIncomeSourcesFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/get-income-sources

build-PutIncomeSourceFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/put-income-source

build-DeleteIncomeSourceFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/delete-income-source

build-GetNetPayFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/get-net-pay

build-SuggestFixedCostsFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/suggest-fixed-costs

build-GetMasterBudgetFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/get-master-budget

build-PutMasterBudgetFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/put-master-budget

build-GetMasterBudgetVarianceFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/get-master-budget-variance

build-GetBudgetsFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/get-budgets

build-PutBudgetFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/put-budget

build-DeleteBudgetFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/delete-budget

build-GetBudgetPeriodFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/get-budget-period

build-CloseBudgetPeriodFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/close-budget-period

build-PutSplitsFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/put-splits

build-DeleteSplitsFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/delete-splits

build-PutTransactionFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/put-transaction

build-DeleteTransactionFunction:
	$(GOENV) go build $(GOFLAGS) -o $(ARTIFACTS_DIR)/bootstrap ./functions/delete-transaction

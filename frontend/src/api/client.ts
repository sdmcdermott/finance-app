import axios from 'axios';
import { AUTH_DISABLED, userPool } from '../auth/cognitoPool';

const api = axios.create({
  baseURL: process.env.REACT_APP_API_URL || undefined,
});

// Attach the current Cognito ID token to every request.
// If no session exists (local dev with AUTH_DISABLED, or not logged in),
// the header is simply omitted — the request goes through without it.
api.interceptors.request.use((config) => {
  if (AUTH_DISABLED || !userPool) return config;
  const cognitoUser = userPool.getCurrentUser();
  if (!cognitoUser) return config;
  return new Promise((resolve) => {
    cognitoUser.getSession((err: Error | null, session: any) => {
      if (!err && session?.isValid()) {
        config.headers = config.headers ?? {};
        config.headers['Authorization'] = `Bearer ${session.getIdToken().getJwtToken()}`;
      }
      resolve(config);
    });
  });
});

export interface Account {
  accountId: string;
  institution: string;
  name: string;
  type: string;
  subtype: string;
  lastSynced: string;
}

export interface Transaction {
  accountId: string;
  dateTransactionId: string;
  transactionId: string;
  date: string;
  name: string;
  amount: number;
  category: string;
  customCategory: string;
  budgetId: string;
  manualBudget: boolean;
  pending: boolean;
  merchantName: string;
  referenceUrl: string;
  referenceNote: string;
  // Plaid enrichment fields
  originalDescription?: string;
  authorizedDate?: string;
  paymentChannel?: string;
  personalFinancePrimary?: string;
  personalFinanceDetailed?: string;
  logoUrl?: string;
  splits?: TransactionSplit[];
}

export interface TransactionSplit {
  splitId: string;
  accountId: string;
  dateTransactionId: string;
  amount: number;
  customCategory: string;
  budgetId: string;
  note: string;
}

export interface Category {
  userId: string;
  categoryId: string;
  name: string;
  color: string;
}

export const createLinkToken = async (): Promise<string> => {
  const { data } = await api.post<{ linkToken: string }>('/plaid/link-token');
  return data.linkToken;
};

export const syncTransactions = async (): Promise<{ added: number; modified: number; removed: number; errors: number }> => {
  const { data } = await api.post('/plaid/sync');
  return data;
};

export const exchangeToken = async (
  publicToken: string,
  institutionName: string
): Promise<{ accounts: Account[]; itemId: string }> => {
  const { data } = await api.post('/plaid/exchange-token', { publicToken, institutionName });
  return data;
};

export const getAccounts = async (): Promise<Account[]> => {
  const { data } = await api.get<{ accounts: Account[] }>('/accounts');
  return data.accounts ?? [];
};

export const deleteAccount = async (accountId: string): Promise<void> => {
  await api.delete(`/accounts/${encodeURIComponent(accountId)}`);
};

export const getTransactions = async (params?: {
  accountId?: string;
  startDate?: string;
  endDate?: string;
}): Promise<Transaction[]> => {
  const { data } = await api.get<{ transactions: Transaction[] }>('/transactions', { params });
  return data.transactions ?? [];
};

export const putTransaction = async (txn: {
  accountId: string;
  date: string;
  name: string;
  amount: number;
  customCategory?: string;
  budgetId?: string;
  transactionId?: string;
}): Promise<Transaction> => {
  const { data } = await api.put<Transaction>('/transactions', txn);
  return data;
};

export const deleteTransaction = async (
  accountId: string,
  dateTransactionId: string
): Promise<void> => {
  await api.delete(`/transactions/${encodeURIComponent(accountId)}/${encodeURIComponent(dateTransactionId)}`);
};

export const updateTransactionCategory = async (
  accountId: string,
  dateTransactionId: string,
  customCategory: string
): Promise<void> => {
  await api.patch(
    `/transactions/${encodeURIComponent(accountId)}/${encodeURIComponent(dateTransactionId)}/category`,
    { customCategory }
  );
};

export const updateTransactionBudget = async (
  accountId: string,
  dateTransactionId: string,
  budgetId: string
): Promise<void> => {
  await api.patch(
    `/transactions/${encodeURIComponent(accountId)}/${encodeURIComponent(dateTransactionId)}/budget`,
    { budgetId }
  );
};

export const getCategories = async (): Promise<Category[]> => {
  const { data } = await api.get<{ categories: Category[] }>('/categories');
  return data.categories ?? [];
};

export const putCategory = async (category: Omit<Category, 'userId'>): Promise<Category> => {
  const { data } = await api.post<Category>('/categories', category);
  return data;
};

export const deleteCategory = async (categoryId: string): Promise<void> => {
  await api.delete(`/categories/${categoryId}`);
};

// ── Rules ─────────────────────────────────────────────────────────────────────

export interface Rule {
  userId: string;
  ruleId: string;
  pattern: string;
  categoryId: string;
  budgetId: string;
  priority: number;
  amountMatch?: number;
  amountTolerance?: number;
  dayOfMonth?: number;
  dayTolerance?: number;
}

export const getRules = async (): Promise<Rule[]> => {
  const { data } = await api.get<{ rules: Rule[] }>('/rules');
  return data.rules ?? [];
};

export const putRule = async (rule: Omit<Rule, 'userId'>): Promise<Rule> => {
  const { data } = await api.post<Rule>('/rules', rule);
  return data;
};

export const deleteRule = async (ruleId: string): Promise<void> => {
  await api.delete(`/rules/${ruleId}`);
};

export const applyRules = async (month?: string): Promise<{ updated: number }> => {
  const { data } = await api.post<{ updated: number }>('/rules/apply', null, {
    params: month ? { month } : undefined,
  });
  return data;
};

// ── Budgets ───────────────────────────────────────────────────────────────────

export interface Budget {
  userId: string;
  budgetId: string;
  name: string;
  budgetType: 'goal' | 'checkbook';
  period: 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annually';
  periodFormat: string;
  goalAmount: number;
  goalDirection: 'limit' | 'target';
  surplusHandling: 'ignore' | 'rollover' | 'transfer';
  transferBudgetId: string;
  transferAmount: number;
  openingBalance: number;
}

export interface BudgetTxn {
  date: string;
  name: string;
  amount: number; // positive = debit, negative = credit
  accountId: string;
  dateTransactionId: string;
  isSplit?: boolean;
}

export interface BudgetPeriod {
  periodId: string;
  budgetId: string;
  startDate: string;
  endDate: string;
  label: string;
  rolledOverAmount: number;
  transferredOut: number;
  closed: boolean;
  staleWarning?: boolean;
  // computed by server (always live from transactions)
  debitTotal: number;
  creditTotal: number;
  effectiveGoal: number;
  balance: number;
  liveDelta: number;
  transactions: BudgetTxn[];
}

export const getBudgets = async (): Promise<Budget[]> => {
  const { data } = await api.get<{ budgets: Budget[] }>('/budgets');
  return data.budgets ?? [];
};

export const putBudget = async (budget: Omit<Budget, 'userId'>): Promise<Budget> => {
  const { data } = await api.post<Budget>('/budgets', budget);
  return data;
};

export const deleteBudget = async (budgetId: string): Promise<void> => {
  await api.delete(`/budgets/${budgetId}`);
};

export interface BudgetPeriodResponse {
  budget: Budget;
  periods: BudgetPeriod[];
}

export const getBudgetPeriods = async (budgetId: string): Promise<BudgetPeriodResponse> => {
  const { data } = await api.get<BudgetPeriodResponse>(`/budgets/${budgetId}/periods`);
  return data;
};

export const closeBudgetPeriod = async (
  budgetId: string,
  startDate: string,
  force = false
): Promise<{ closed: boolean; delta: number; debits: number; credits: number }> => {
  const url = force
    ? `/budgets/${budgetId}/periods/${startDate}/close?force=true`
    : `/budgets/${budgetId}/periods/${startDate}/close`;
  const { data } = await api.post(url);
  return data;
};

// ── Transaction reference links ───────────────────────────────────────────────

export const updateTransactionReference = async (
  accountId: string,
  dateTransactionId: string,
  referenceUrl: string,
  referenceNote: string
): Promise<void> => {
  await api.patch(
    `/transactions/${encodeURIComponent(accountId)}/${encodeURIComponent(dateTransactionId)}/reference`,
    { referenceUrl, referenceNote }
  );
};

// ── Amazon CSV import ─────────────────────────────────────────────────────────

export interface AmazonOrder {
  orderId: string;
  orderDate: string;
  amount: number;
  titles: string[];
  orderUrl: string;
}

export type MatchStatus = 'confident' | 'ambiguous' | 'unmatched';

export interface MatchResult {
  order: AmazonOrder;
  status: MatchStatus;
  candidates: Transaction[];
  note: string;
}

export interface ImportReport {
  results: MatchResult[];
  orderCount: number;
  txnPool: number;
}

export const importAmazonCsv = async (csvText: string): Promise<ImportReport> => {
  const { data } = await api.post<ImportReport>('/import/amazon-csv', csvText, {
    headers: { 'Content-Type': 'text/plain' },
  });
  return data;
};

export interface ConfirmedMatch {
  accountId: string;
  dateTransactionId: string;
  referenceUrl: string;
  referenceNote: string;
}

export const confirmAmazonImport = async (
  matches: ConfirmedMatch[]
): Promise<{ saved: number; errors: string[] }> => {
  const { data } = await api.post('/import/amazon-csv/confirm', { matches });
  return data;
};

// ── Transaction splits ────────────────────────────────────────────────────────

// putSplits saves a complete set of splits for a transaction.
// Pass an empty array to remove all splits.
export const putSplits = async (
  accountId: string,
  dateTransactionId: string,
  splits: Omit<TransactionSplit, 'accountId' | 'dateTransactionId'>[]
): Promise<TransactionSplit[]> => {
  const { data } = await api.put<{ splits: TransactionSplit[] }>(
    `/transactions/${encodeURIComponent(accountId)}/${encodeURIComponent(dateTransactionId)}/splits`,
    { splits }
  );
  return data.splits ?? [];
};

export const deleteSplits = async (
  accountId: string,
  dateTransactionId: string
): Promise<void> => {
  await api.delete(
    `/transactions/${encodeURIComponent(accountId)}/${encodeURIComponent(dateTransactionId)}/splits`
  );
};

// --- Income Sources ---------------------------------------------------

export interface NetPayResult {
  grossAmount: number;
  section125Deductions: number;
  retirementDeductions: number;
  ficaTaxableWages: number;
  incomeTaxableWages: number;
  deductionUsed: number;
  deductionWarning?: string;
  step4aOtherIncome?: number;
  step4bDeductions?: number;
  step3Credits?: number;
  withholdings: Record<string, number>;
  totalWithheld: number;
  additionalWithholding: number;
  netPay: number;
}

export interface DeductionItem {
  name: string;
  amount: number;
}

export interface IncomeSource {
  userId: string;
  incomeSourceId: string;
  name: string;
  frequency: 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';
  grossAmount: number;
  filingStatus: 'single' | 'married_jointly' | 'married_separately' | 'head_of_household';
  workState: string;
  section125Deductions: number;
  section125Items?: DeductionItem[];
  retirementDeductions: number;
  retirementItems?: DeductionItem[];
  preTaxDeductions: number; // legacy
  additionalWithholding: number;
  deductionType: 'standard' | 'itemized';
  itemizedDeductions: number;
  itemizedDeductionItems?: DeductionItem[];
  step3Credits: number;
  step4aOtherIncome: number;
  step4aItems?: DeductionItem[];
  step4bDeductions: number;
  step4bItems?: DeductionItem[];
  isActive: boolean;
  lastNetPay?: NetPayResult;
}

export const getIncomeSources = async (): Promise<IncomeSource[]> => {
  const { data } = await api.get<IncomeSource[]>('/income-sources');
  return data ?? [];
};

export const putIncomeSource = async (
  source: Omit<IncomeSource, 'userId'>
): Promise<IncomeSource> => {
  const { data } = await api.post<IncomeSource>('/income-sources', source);
  return data;
};

export const deleteIncomeSource = async (incomeSourceId: string): Promise<void> => {
  await api.delete(`/income-sources/${incomeSourceId}`);
};

export const getNetPay = async (
  incomeSourceId: string,
  ytdWages?: number
): Promise<NetPayResult> => {
  const params = ytdWages !== undefined ? `?ytdWages=${ytdWages}` : '';
  const { data } = await api.get<NetPayResult>(`/income-sources/${incomeSourceId}/net-pay${params}`);
  return data;
};

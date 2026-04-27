import axios from 'axios';
import { CognitoUserPool } from 'amazon-cognito-identity-js';

const userPool = new CognitoUserPool({
  UserPoolId: process.env.REACT_APP_COGNITO_USER_POOL_ID ?? '',
  ClientId: process.env.REACT_APP_COGNITO_CLIENT_ID ?? '',
});

const api = axios.create({
  baseURL: process.env.REACT_APP_API_URL,
});

// Attach the current Cognito ID token to every request.
// If no session exists (local dev with AUTH_DISABLED, or not logged in),
// the header is simply omitted — the request goes through without it.
api.interceptors.request.use((config) => {
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
  pending: boolean;
  merchantName: string;
  referenceUrl: string;
  referenceNote: string;
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

export const getTransactions = async (params?: {
  accountId?: string;
  startDate?: string;
  endDate?: string;
}): Promise<Transaction[]> => {
  const { data } = await api.get<{ transactions: Transaction[] }>('/transactions', { params });
  return data.transactions ?? [];
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
  priority: number;
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
  categoryIds: string[];
  goalAmount: number;
  goalDirection: 'limit' | 'target';
  surplusHandling: 'ignore' | 'rollover' | 'transfer';
  transferBudgetId: string;
  transferAmount: number;
  openingBalance: number;
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
  // computed by server
  debitTotal: number;
  creditTotal: number;
  effectiveGoal: number;
  balance: number;
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
  startDate: string
): Promise<{ closed: boolean; delta: number; debits: number; credits: number }> => {
  const { data } = await api.post(`/budgets/${budgetId}/periods/${startDate}/close`);
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

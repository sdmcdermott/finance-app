import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  Account, Budget, Category, Rule, IncomeSource,
  getAccounts, getBudgets, getCategories, getRules, getIncomeSources,
} from '../api/client';
import { useAuth } from './AuthContext';

export type TxnRangeKey = 'last30' | 'last60' | 'last90' | 'currentMonth' | 'currentYear';
export type TxnSortKey = 'date' | 'merchant' | 'amount';
export type TxnSortDir = 'asc' | 'desc';

interface DataState {
  accounts: Account[];
  categories: Category[];
  budgets: Budget[];
  rules: Rule[];
  incomeSources: IncomeSource[];
  loading: boolean;

  // Persisted UI preferences
  txnRange: TxnRangeKey;
  setTxnRange: React.Dispatch<React.SetStateAction<TxnRangeKey>>;
  txnSortKey: TxnSortKey;
  setTxnSortKey: React.Dispatch<React.SetStateAction<TxnSortKey>>;
  txnSortDir: TxnSortDir;
  setTxnSortDir: React.Dispatch<React.SetStateAction<TxnSortDir>>;

  // Mutators — call after a successful API write to keep the cache in sync.
  setAccounts: React.Dispatch<React.SetStateAction<Account[]>>;
  setCategories: React.Dispatch<React.SetStateAction<Category[]>>;
  setBudgets: React.Dispatch<React.SetStateAction<Budget[]>>;
  setRules: React.Dispatch<React.SetStateAction<Rule[]>>;
  setIncomeSources: React.Dispatch<React.SetStateAction<IncomeSource[]>>;

  // Force a full refresh of one or all collections (escape hatch).
  refreshAll: () => Promise<void>;
}

const DataContext = createContext<DataState | null>(null);

export const DataProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { idToken } = useAuth();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [incomeSources, setIncomeSources] = useState<IncomeSource[]>([]);
  const [loading, setLoading] = useState(false);
  const [txnRange, setTxnRange] = useState<TxnRangeKey>('currentMonth');
  const [txnSortKey, setTxnSortKey] = useState<TxnSortKey>('date');
  const [txnSortDir, setTxnSortDir] = useState<TxnSortDir>('desc');

  const refreshAll = useCallback(async () => {
    if (!idToken) return;
    setLoading(true);
    try {
      const [a, c, b, r, inc] = await Promise.all([
        getAccounts(),
        getCategories(),
        getBudgets(),
        getRules(),
        getIncomeSources(),
      ]);
      setAccounts(a);
      setCategories(c);
      setBudgets(b);
      setRules(r);
      setIncomeSources(inc);
    } finally {
      setLoading(false);
    }
  }, [idToken]);

  // Load once when the user is authenticated.
  useEffect(() => {
    if (idToken) refreshAll();
  }, [idToken, refreshAll]);

  return (
    <DataContext.Provider value={{
      accounts, categories, budgets, rules, incomeSources, loading,
      txnRange, setTxnRange,
      txnSortKey, setTxnSortKey,
      txnSortDir, setTxnSortDir,
      setAccounts, setCategories, setBudgets, setRules, setIncomeSources,
      refreshAll,
    }}>
      {children}
    </DataContext.Provider>
  );
};

export const useData = (): DataState => {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData must be used inside DataProvider');
  return ctx;
};

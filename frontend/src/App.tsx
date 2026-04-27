import React, { useEffect, useState, useCallback } from 'react';
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import {
  Account, Category, Transaction,
  getAccounts, getCategories, getTransactions,
  updateTransactionCategory, updateTransactionReference, applyRules,
} from './api/client';
import { usePlaidConnect } from './hooks/usePlaidConnect';
import { AuthProvider, useAuth } from './auth/AuthContext';
import SplitEditor from './components/SplitEditor';
import CategoriesPage from './pages/CategoriesPage';
import BudgetsPage from './pages/BudgetsPage';
import BudgetPeriodPage from './pages/BudgetPeriodPage';
import RulesPage from './pages/RulesPage';
import ImportPage from './pages/ImportPage';
import LoginPage from './pages/LoginPage';

// ── Nav ───────────────────────────────────────────────────────────────────────
const Nav: React.FC<{ onConnect: () => void; connecting: boolean }> = ({ onConnect, connecting }) => {
  const { logout } = useAuth();
  const location = useLocation();
  const [open, setOpen] = useState(false);

  // Close drawer on navigation
  useEffect(() => { setOpen(false); }, [location.pathname]);

  const links = [
    { to: '/', label: 'Transactions' },
    { to: '/categories', label: 'Categories' },
    { to: '/budgets', label: 'Budgets' },
    { to: '/rules', label: 'Rules' },
    { to: '/import', label: 'Import' },
  ];

  return (
    <>
      <nav className="nav">
        <span className="nav-brand">Finance Tracker</span>
        {/* Desktop links */}
        <div className="nav-links">
          {links.map(l => (
            <Link key={l.to} className="nav-link" to={l.to}>{l.label}</Link>
          ))}
        </div>
        {/* Desktop actions */}
        <div className="nav-actions">
          <button style={inlineStyles.btn} onClick={onConnect} disabled={connecting}>
            {connecting ? 'Connecting...' : '+ Connect Account'}
          </button>
          <button style={inlineStyles.logoutBtn} onClick={logout}>Sign out</button>
        </div>
        {/* Mobile hamburger */}
        <button
          className="nav-hamburger"
          aria-label={open ? 'Close menu' : 'Open menu'}
          onClick={() => setOpen(o => !o)}
        >
          {open ? '✕' : '☰'}
        </button>
      </nav>
      {/* Mobile drawer */}
      <div className={`nav-drawer${open ? ' open' : ''}`}>
        {links.map(l => (
          <Link key={l.to} className="nav-link" to={l.to}>{l.label}</Link>
        ))}
        <div className="nav-drawer-actions">
          <button style={{ ...inlineStyles.btn, width: '100%' }} onClick={() => { setOpen(false); onConnect(); }} disabled={connecting}>
            {connecting ? 'Connecting...' : '+ Connect Account'}
          </button>
          <button style={{ ...inlineStyles.logoutBtn, width: '100%' }} onClick={logout}>Sign out</button>
        </div>
      </div>
    </>
  );
};

// ── Shared transaction row helpers ────────────────────────────────────────────
const CatSelect: React.FC<{
  txn: Transaction; categories: Category[];
  assigningId: string | null;
  onAssign: (txn: Transaction, catId: string) => void;
}> = ({ txn, categories, assigningId, onAssign }) => (
  <select
    value={txn.customCategory || ''}
    disabled={assigningId === txn.dateTransactionId}
    onChange={e => onAssign(txn, e.target.value)}
    style={inlineStyles.catSelect}
  >
    <option value="">— Uncategorized —</option>
    {categories.map(c => <option key={c.categoryId} value={c.categoryId}>{c.name}</option>)}
  </select>
);

const CatBadge: React.FC<{ catId: string; categories: Category[] }> = ({ catId, categories }) => {
  const cat = categories.find(c => c.categoryId === catId);
  if (!cat) return null;
  return (
    <span style={{ ...inlineStyles.catBadge, background: cat.color }}>{cat.name}</span>
  );
};

// ── Transactions page ─────────────────────────────────────────────────────────
const TransactionsPage: React.FC<{ accounts: Account[]; categories: Category[] }> = ({
  accounts, categories,
}) => {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [selectedAccount, setSelectedAccount] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [showUncategorizedOnly, setShowUncategorizedOnly] = useState(false);
  const [applyingRules, setApplyingRules] = useState(false);
  const [applyMsg, setApplyMsg] = useState<string | null>(null);
  const [editingRefId, setEditingRefId] = useState<string | null>(null);
  const [refUrl, setRefUrl] = useState('');
  const [refNote, setRefNote] = useState('');
  const [savingRef, setSavingRef] = useState(false);
  const [splitEditorId, setSplitEditorId] = useState<string | null>(null);

  const now = new Date();
  const [month, setMonth] = useState(
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  );

  const startDate = `${month}-01`;
  const endDate = (() => {
    const [y, m] = month.split('-').map(Number);
    return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
  })();

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      setTransactions(await getTransactions({ accountId: selectedAccount || undefined, startDate, endDate }));
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [selectedAccount, startDate, endDate]);

  useEffect(() => { load(); }, [load]);

  const assignCategory = async (txn: Transaction, categoryId: string) => {
    setAssigningId(txn.dateTransactionId);
    try {
      await updateTransactionCategory(txn.accountId, txn.dateTransactionId, categoryId);
      setTransactions(prev => prev.map(t =>
        t.dateTransactionId === txn.dateTransactionId ? { ...t, customCategory: categoryId } : t
      ));
    } catch (e: any) { setError(e.message); }
    finally { setAssigningId(null); }
  };

  const handleApplyRules = async () => {
    setApplyingRules(true); setApplyMsg(null); setError(null);
    try {
      const result = await applyRules(month);
      setApplyMsg(`Rules applied: ${result.updated} transaction(s) updated.`);
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setApplyingRules(false); }
  };

  const openRefEditor = (txn: Transaction) => {
    setEditingRefId(txn.dateTransactionId);
    setRefUrl(txn.referenceUrl || '');
    setRefNote(txn.referenceNote || '');
  };

  const saveRef = async (txn: Transaction) => {
    setSavingRef(true);
    try {
      await updateTransactionReference(txn.accountId, txn.dateTransactionId, refUrl, refNote);
      setTransactions(prev => prev.map(t =>
        t.dateTransactionId === txn.dateTransactionId ? { ...t, referenceUrl: refUrl, referenceNote: refNote } : t
      ));
      setEditingRefId(null);
    } catch (e: any) { setError(e.message); }
    finally { setSavingRef(false); }
  };

  const handleSplitSaved = (updated: Transaction) => {
    setTransactions(prev => prev.map(t =>
      t.dateTransactionId === updated.dateTransactionId ? updated : t
    ));
    setSplitEditorId(null);
  };

  const amtColor = (txn: Transaction) => txn.amount > 0 ? '#e53e3e' : '#38a169';
  const amtStr = (txn: Transaction) => `${txn.amount > 0 ? '-' : '+'}$${Math.abs(txn.amount).toFixed(2)}`;

  const visible = showUncategorizedOnly ? transactions.filter(t => !t.customCategory) : transactions;

  return (
    <div className="page">
      {error && <div style={inlineStyles.error}>{error}</div>}
      {applyMsg && <div style={inlineStyles.success}>{applyMsg}</div>}

      {/* Filters */}
      <div className="filters">
        <div style={inlineStyles.accountChips}>
          <button style={selectedAccount === '' ? inlineStyles.chipActive : inlineStyles.chip} onClick={() => setSelectedAccount('')}>All</button>
          {accounts.map(a => (
            <button key={a.accountId}
              style={a.accountId === selectedAccount ? inlineStyles.chipActive : inlineStyles.chip}
              onClick={() => setSelectedAccount(a.accountId)}>
              {a.institution} — {a.name}
            </button>
          ))}
        </div>
        <div className="filter-right">
          <label style={inlineStyles.checkLabel}>
            <input type="checkbox" checked={showUncategorizedOnly}
              onChange={e => setShowUncategorizedOnly(e.target.checked)} style={{ marginRight: 4 }} />
            Uncategorized only
          </label>
          <input type="month" value={month} onChange={e => setMonth(e.target.value)} style={inlineStyles.monthPicker} />
          <button style={inlineStyles.applyBtn} onClick={handleApplyRules} disabled={applyingRules}
            title="Re-run all auto-assignment rules on this month's transactions">
            {applyingRules ? 'Applying...' : 'Re-apply Rules'}
          </button>
        </div>
      </div>

      {accounts.length === 0 && !loading && (
        <div style={inlineStyles.empty}>
          <p>No accounts connected yet.</p>
          <p>Use "+ Connect Account" to link your bank or credit card via Plaid.</p>
        </div>
      )}
      {loading && <div style={inlineStyles.empty}>Loading...</div>}

      {!loading && visible.length > 0 && (
        <>
          {/* ── Desktop table ── */}
          <table className="txn-table">
            <thead>
              <tr>
                <th>Date</th><th>Merchant</th><th>Category</th>
                <th style={{ textAlign: 'right' }}>Amount</th><th>Status</th><th>Ref</th><th>Split</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(txn => (
                <React.Fragment key={txn.dateTransactionId}>
                  <tr>
                    <td>{txn.date}</td>
                    <td>{txn.merchantName || txn.name}</td>
                    <td>
                      <div style={inlineStyles.catCell}>
                        {txn.splits && txn.splits.length > 0 ? (
                          <span style={{ fontSize: '0.8rem', color: '#718096', fontStyle: 'italic' }}>
                            {txn.splits.length} splits
                          </span>
                        ) : (
                          <>
                            <CatSelect txn={txn} categories={categories} assigningId={assigningId} onAssign={assignCategory} />
                            {txn.customCategory && <CatBadge catId={txn.customCategory} categories={categories} />}
                          </>
                        )}
                      </div>
                    </td>
                    <td style={{ textAlign: 'right', color: amtColor(txn) }}>{amtStr(txn)}</td>
                    <td>{txn.pending ? 'Pending' : 'Posted'}</td>
                    <td>
                      {editingRefId === txn.dateTransactionId ? (
                        <div style={inlineStyles.refEditor}>
                          <input type="url" placeholder="URL" value={refUrl} onChange={e => setRefUrl(e.target.value)} style={inlineStyles.refInput} />
                          <input type="text" placeholder="Note" value={refNote} onChange={e => setRefNote(e.target.value)} style={inlineStyles.refInput} />
                          <button style={inlineStyles.refSaveBtn} onClick={() => saveRef(txn)} disabled={savingRef}>{savingRef ? '...' : 'Save'}</button>
                          <button style={inlineStyles.refCancelBtn} onClick={() => setEditingRefId(null)}>✕</button>
                        </div>
                      ) : (
                        <div style={inlineStyles.refView}>
                          {txn.referenceUrl && (
                            <a href={txn.referenceUrl} target="_blank" rel="noreferrer" style={inlineStyles.refLink} title={txn.referenceNote || txn.referenceUrl}>🔗</a>
                          )}
                          <button style={inlineStyles.refEditBtn} onClick={() => openRefEditor(txn)} title="Edit reference">
                            {txn.referenceUrl ? '✎' : '+'}
                          </button>
                        </div>
                      )}
                    </td>
                    <td>
                      <button
                        className="split-badge"
                        onClick={() => setSplitEditorId(
                          splitEditorId === txn.dateTransactionId ? null : txn.dateTransactionId
                        )}
                        title={txn.splits && txn.splits.length > 0 ? 'Edit splits' : 'Split transaction'}
                      >
                        {txn.splits && txn.splits.length > 0 ? `⅔ ${txn.splits.length}` : '⅔ Split'}
                      </button>
                    </td>
                  </tr>
                  {splitEditorId === txn.dateTransactionId && (
                    <tr>
                      <td colSpan={7} style={{ padding: '0 0.75rem 0.75rem' }}>
                        <SplitEditor
                          txn={txn}
                          categories={categories}
                          onClose={() => setSplitEditorId(null)}
                          onSaved={handleSplitSaved}
                        />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>

          {/* ── Mobile cards ── */}
          <div className="txn-cards">
            {visible.map(txn => (
              <div key={txn.dateTransactionId} className="txn-card">
                <div className="txn-card-row">
                  <span className="txn-card-merchant">{txn.merchantName || txn.name}</span>
                  <span className="txn-card-amount" style={{ color: amtColor(txn) }}>{amtStr(txn)}</span>
                </div>
                <div className="txn-card-meta">
                  <span className="txn-card-date">{txn.date}</span>
                  <span className="txn-card-status">{txn.pending ? 'Pending' : 'Posted'}</span>
                  {txn.referenceUrl && (
                    <a href={txn.referenceUrl} target="_blank" rel="noreferrer" style={inlineStyles.refLink} title={txn.referenceNote || txn.referenceUrl}>🔗</a>
                  )}
                </div>
                <div className="txn-card-cat">
                  {txn.splits && txn.splits.length > 0 ? (
                    <div className="split-summary-list">
                      {txn.splits.map((sp, i) => {
                        const cat = categories.find(c => c.categoryId === sp.customCategory);
                        return (
                          <div key={i} className="split-summary-item">
                            <span>{cat ? cat.name : 'Uncategorized'}{sp.note ? ` — ${sp.note}` : ''}</span>
                            <span style={{ color: amtColor(txn) }}>${sp.amount.toFixed(2)}</span>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <>
                      <CatSelect txn={txn} categories={categories} assigningId={assigningId} onAssign={assignCategory} />
                      {txn.customCategory && <CatBadge catId={txn.customCategory} categories={categories} />}
                    </>
                  )}
                </div>
                {/* Split button on mobile */}
                <div style={{ marginTop: '0.4rem' }}>
                  <button
                    className="split-badge"
                    onClick={() => setSplitEditorId(
                      splitEditorId === txn.dateTransactionId ? null : txn.dateTransactionId
                    )}
                  >
                    {txn.splits && txn.splits.length > 0 ? `⅔ Edit splits (${txn.splits.length})` : '⅔ Split'}
                  </button>
                </div>
                {splitEditorId === txn.dateTransactionId && (
                  <SplitEditor
                    txn={txn}
                    categories={categories}
                    onClose={() => setSplitEditorId(null)}
                    onSaved={handleSplitSaved}
                  />
                )}
                {/* Ref editor on mobile */}
                <div className="txn-card-ref">
                  {editingRefId === txn.dateTransactionId ? (
                    <div className="ref-editor-mobile">
                      <input type="url" placeholder="URL" value={refUrl} onChange={e => setRefUrl(e.target.value)} />
                      <input type="text" placeholder="Note" value={refNote} onChange={e => setRefNote(e.target.value)} />
                      <div className="ref-editor-mobile-btns">
                        <button style={{ ...inlineStyles.refSaveBtn, flex: 1 }} onClick={() => saveRef(txn)} disabled={savingRef}>{savingRef ? '...' : 'Save'}</button>
                        <button style={inlineStyles.refCancelBtn} onClick={() => setEditingRefId(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <button style={{ ...inlineStyles.refEditBtn, fontSize: '0.8rem' }} onClick={() => openRefEditor(txn)}>
                      {txn.referenceUrl ? '✎ Edit reference' : '+ Add reference'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {!loading && visible.length === 0 && accounts.length > 0 && (
        <div style={inlineStyles.empty}>
          {showUncategorizedOnly ? 'No uncategorized transactions for this period.' : 'No transactions found for this period.'}
        </div>
      )}
    </div>
  );
};

// ── App root ──────────────────────────────────────────────────────────────────
const AppInner: React.FC = () => {
  const { idToken, loading: authLoading } = useAuth();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);

  useEffect(() => {
    if (!idToken) return;
    getAccounts().then(setAccounts).catch(console.error);
    getCategories().then(setCategories).catch(console.error);
  }, [idToken]);

  const { fetchLinkToken, open, ready, loading: linkLoading } = usePlaidConnect({
    onSuccess: async (newAccounts) => { setAccounts(prev => [...prev, ...newAccounts]); },
  });

  useEffect(() => { if (ready) open(); }, [ready, open]);

  if (authLoading) return <div style={{ textAlign: 'center', marginTop: '4rem', color: '#718096' }}>Loading...</div>;
  if (!idToken) return <LoginPage />;

  return (
    <>
      <Nav onConnect={() => fetchLinkToken()} connecting={linkLoading} />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<TransactionsPage accounts={accounts} categories={categories} />} />
          <Route path="/categories" element={<CategoriesPage />} />
          <Route path="/budgets" element={<BudgetsPage />} />
          <Route path="/budgets/:budgetId" element={<BudgetPeriodPage />} />
          <Route path="/rules" element={<RulesPage />} />
          <Route path="/import" element={<ImportPage />} />
        </Routes>
      </main>
    </>
  );
};

const App: React.FC = () => (
  <BrowserRouter>
    <AuthProvider>
      <AppInner />
    </AuthProvider>
  </BrowserRouter>
);

export default App;

// ── Inline styles (non-responsive, color/sizing only) ─────────────────────────
const inlineStyles: Record<string, React.CSSProperties> = {
  btn: { background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 6, padding: '0.45rem 1rem', cursor: 'pointer', fontSize: '0.875rem', whiteSpace: 'nowrap' },
  logoutBtn: { background: 'none', color: '#718096', border: '1px solid #e2e8f0', borderRadius: 6, padding: '0.45rem 0.75rem', cursor: 'pointer', fontSize: '0.8rem', whiteSpace: 'nowrap' },
  accountChips: { display: 'flex', gap: '0.4rem', flexWrap: 'wrap' },
  chip: { background: '#edf2f7', border: 'none', borderRadius: 20, padding: '0.4rem 0.85rem', cursor: 'pointer', fontSize: '0.8rem', minHeight: 36 },
  chipActive: { background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 20, padding: '0.4rem 0.85rem', cursor: 'pointer', fontSize: '0.8rem', minHeight: 36 },
  checkLabel: { fontSize: '0.8rem', color: '#4a5568', display: 'flex', alignItems: 'center', cursor: 'pointer', whiteSpace: 'nowrap' },
  monthPicker: { border: '1px solid #cbd5e0', borderRadius: 6, padding: '0.3rem 0.6rem', fontSize: '0.875rem' },
  applyBtn: { background: '#edf2f7', color: '#2d3748', border: '1px solid #cbd5e0', borderRadius: 6, padding: '0.3rem 0.75rem', cursor: 'pointer', fontSize: '0.8rem', whiteSpace: 'nowrap' },
  catCell: { display: 'flex', alignItems: 'center', gap: '0.5rem' },
  catSelect: { border: '1px solid #cbd5e0', borderRadius: 4, padding: '0.3rem 0.4rem', fontSize: '0.8rem', maxWidth: 160, minHeight: 36 },
  catBadge: { color: '#fff', borderRadius: 12, padding: '0.15rem 0.6rem', fontSize: '0.75rem', whiteSpace: 'nowrap' },
  empty: { textAlign: 'center', color: '#718096', marginTop: '3rem' },
  error: { background: '#fff5f5', color: '#c53030', border: '1px solid #feb2b2', borderRadius: 6, padding: '0.75rem 1rem', marginBottom: '1rem' },
  success: { background: '#f0fff4', color: '#276749', border: '1px solid #9ae6b4', borderRadius: 6, padding: '0.75rem 1rem', marginBottom: '1rem' },
  refView: { display: 'flex', alignItems: 'center', gap: '0.3rem' },
  refLink: { textDecoration: 'none', fontSize: '0.9rem' },
  refEditBtn: { background: 'none', border: 'none', cursor: 'pointer', color: '#718096', fontSize: '0.85rem', padding: '0 0.2rem' },
  refEditor: { display: 'flex', alignItems: 'center', gap: '0.3rem', flexWrap: 'wrap' },
  refInput: { border: '1px solid #cbd5e0', borderRadius: 4, padding: '0.2rem 0.4rem', fontSize: '0.75rem', width: 130 },
  refSaveBtn: { background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 4, padding: '0.35rem 0.6rem', cursor: 'pointer', fontSize: '0.8rem' },
  refCancelBtn: { background: 'none', border: 'none', cursor: 'pointer', color: '#718096', fontSize: '0.85rem' },
};

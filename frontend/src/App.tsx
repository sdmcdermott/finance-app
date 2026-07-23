import React, { useEffect, useState, useCallback } from 'react';
import { BrowserRouter, Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom';
import { DirtyGuardProvider, useDirtyGuard } from './auth/DirtyGuardContext';
import {
  Account, Category, Rule, Transaction, Budget, IncomeSource,
  getTransactions, putTransaction, deleteTransaction,
  updateTransactionCategory, updateTransactionBudget, updateTransactionReference, updateTransactionName, updateTransactionNote, updateTransactionIgnored, applyRules, syncTransactions,
  putCategory, putRule,
  findRefunds, confirmRefunds, FindRefundsResponse, RefundMatch, RefundCandidate, RefundPair,
} from './api/client';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { DataProvider, useData } from './auth/DataContext';
import SplitEditor from './components/SplitEditor';
import AccountsPage from './pages/AccountsPage';
import CategoriesPage from './pages/CategoriesPage';
import BudgetsPage from './pages/BudgetsPage';
import BudgetPeriodPage from './pages/BudgetPeriodPage';
import RulesPage from './pages/RulesPage';
import ImportPage from './pages/ImportPage';
import LoginPage from './pages/LoginPage';
import { IncomePage } from './pages/IncomePage';
import MasterBudgetPage from './pages/MasterBudgetPage';
import { IncomeSourceModal } from './components/IncomeSourceModal';
import { fmtDate } from './utils/dates';
import { fmtCurrency } from './utils/dates';
import { INCOME_CATEGORY_ID, MASTER_BUDGET_ID } from './api/client';

// ── Nav ───────────────────────────────────────────────────────────────────────
const Nav: React.FC = () => {
  const { logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const dirtyGuard = useDirtyGuard();
  const [open, setOpen] = useState(false);
  const [blockTarget, setBlockTarget] = useState<string | null>(null);

  // Close drawer on navigation
  useEffect(() => { setOpen(false); }, [location.pathname]);

  const links = [
    { to: '/accounts', label: 'Accounts' },
    { to: '/', label: 'Transactions' },
    { to: '/categories', label: 'Categories' },
    { to: '/budgets', label: 'Budgets' },
    { to: '/master-budget', label: 'Master Budget' },
    { to: '/rules', label: 'Rules' },
    { to: '/income', label: 'Income' },
    { to: '/import', label: 'Import' },
  ];

  const handleNavClick = (to: string, e: React.MouseEvent) => {
    if (location.pathname === to) return; // already here
    if (dirtyGuard.isDirty()) {
      e.preventDefault();
      setBlockTarget(to);
    }
  };

  const renderLink = (l: { to: string; label: string }) => {
    const active = l.to === '/' ? location.pathname === '/' : location.pathname.startsWith(l.to);
    return (
      <Link
        key={l.to}
        className={`nav-link${active ? ' nav-link-active' : ''}`}
        to={l.to}
        onClick={e => handleNavClick(l.to, e)}
      >
        {l.label}
      </Link>
    );
  };

  return (
    <>
      <nav className="nav">
        <span className="nav-brand">Finance Tracker</span>
        <div className="nav-links">{links.map(renderLink)}</div>
        <div className="nav-actions">
          <button style={inlineStyles.logoutBtn} onClick={logout}>Sign out</button>
        </div>
        <button
          className="nav-hamburger"
          aria-label={open ? 'Close menu' : 'Open menu'}
          onClick={() => setOpen(o => !o)}
        >
          {open ? '✕' : '☰'}
        </button>
      </nav>
      <div className={`nav-drawer${open ? ' open' : ''}`}>
        {links.map(renderLink)}
        <div className="nav-drawer-actions">
          <button style={{ ...inlineStyles.logoutBtn, width: '100%' }} onClick={logout}>Sign out</button>
        </div>
      </div>

      {/* Unsaved-changes guard dialog */}
      {blockTarget && (
        <div style={navBlockStyles.overlay}>
          <div style={navBlockStyles.dialog}>
            <h3 style={navBlockStyles.title}>Unsaved Changes</h3>
            <p style={navBlockStyles.body}>
              You have unsaved changes. Do you want to discard them and leave, or stay and keep editing?
            </p>
            <div style={navBlockStyles.footer}>
              <button
                style={navBlockStyles.discardBtn}
                onClick={() => { setBlockTarget(null); navigate(blockTarget); }}
              >
                Discard &amp; leave
              </button>
              <button
                style={navBlockStyles.stayBtn}
                onClick={() => setBlockTarget(null)}
              >
                Keep editing
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

// ── Shared transaction row helpers ────────────────────────────────────────────
const CatSelect: React.FC<{
   txn: Transaction; categories: Category[];
   assigningId: string | null;
   onAssign: (txn: Transaction, catId: string) => void;
}> = ({ txn, categories, assigningId, onAssign }) => {
  const [editing, setEditing] = useState(false);
  const wasAssigning = React.useRef(false);
  const cat = categories.find(c => c.categoryId === txn.customCategory);

  // Close the dropdown once the async assignment finishes
  useEffect(() => {
    if (assigningId === txn.dateTransactionId) {
      wasAssigning.current = true;
    } else if (wasAssigning.current) {
      wasAssigning.current = false;
      setEditing(false);
    }
  }, [assigningId, txn.dateTransactionId]);

  if (cat && !editing) {
    return (
      <span
        title="Click to change category"
        style={{ ...inlineStyles.catBadge, background: cat.color, cursor: 'pointer' }}
        onClick={() => setEditing(true)}
      >
        {cat.name}
      </span>
    );
  }

  return (
    <select
      autoFocus={editing}
      value={txn.customCategory || ''}
      disabled={assigningId === txn.dateTransactionId}
      onChange={e => { onAssign(txn, e.target.value); }}
      onBlur={() => setTimeout(() => { if (!wasAssigning.current) setEditing(false); }, 150)}

      style={inlineStyles.catSelect}
    >
      <option value="">— Uncategorized —</option>
      {categories.map(c => <option key={c.categoryId} value={c.categoryId}>{c.name}</option>)}
    </select>
  );
};

const CatBadge: React.FC<{ catId: string; categories: Category[] }> = ({ catId, categories }) => {
  const cat = categories.find(c => c.categoryId === catId);
  if (!cat) return null;
  return (
    <span style={{ ...inlineStyles.catBadge, background: cat.color }}>{cat.name}</span>
  );
};

const BudgetSelect: React.FC<{
  txn: Transaction; budgets: Budget[]; incomeSources: IncomeSource[];
  assigningId: string | null;
  onAssign: (txn: Transaction, budgetId: string) => void;
}> = ({ txn, budgets, incomeSources, assigningId, onAssign }) => {
  // Income sentinel budgetIds are managed via IncomeSourceModal, not the dropdown
  const isIncomeSentinel = txn.budgetId?.startsWith('__income__');

  return (
    <select
      value={isIncomeSentinel ? '__master_budget__' : (txn.budgetId || '')}
      disabled={assigningId === txn.dateTransactionId}
      onChange={e => onAssign(txn, e.target.value)}
      style={inlineStyles.catSelect}
    >
      <option value="">— No budget —</option>
      <option value="__master_budget__">⬡ Master Budget</option>
      {budgets.map(b => <option key={b.budgetId} value={b.budgetId}>{b.name}</option>)}
    </select>
  );
};

// ── PFC → Category modal ──────────────────────────────────────────────────────
const PFC_COLORS = [
  '#6366f1', '#f59e0b', '#10b981', '#ef4444',
  '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6',
  '#f97316', '#84cc16',
];

interface PfcModalProps {
  pfcLabel: string;           // the clicked PFC label (already human-formatted)
  txn: Transaction;
  categories: Category[];
  budgets: Budget[];
  rules: Rule[];
  onClose: () => void;
  onDone: (updatedTxn: Transaction, newCategory?: Category, newRule?: Rule) => void;
}

const PfcCategoryModal: React.FC<PfcModalProps> = ({
  pfcLabel, txn, categories, budgets, rules, onClose, onDone,
}) => {
  // Find existing category whose name matches (case-insensitive)
  const existing = categories.find(
    c => c.name.toLowerCase() === pfcLabel.toLowerCase()
  );

  const merchantName = txn.customName || txn.merchantName || txn.name;

  // Find first rule (by priority) whose pattern matches the merchant name
  const matchingRule = existing
    ? [...rules]
        .sort((a, b) => a.priority - b.priority)
        .find(r => merchantName.toLowerCase().includes(r.pattern.toLowerCase()))
    : undefined;

  const [assignTxn, setAssignTxn]       = useState(true);
  const [createCat, setCreateCat]       = useState(!existing);
  const [catName, setCatName]           = useState(pfcLabel);
  const [catColor, setCatColor]         = useState(PFC_COLORS[0]);
  // Default createRule to false when a matching rule already exists
  const [createRule, setCreateRule]     = useState(!matchingRule);
  const [rulePriority, setRulePriority] = useState(10);
  const [ruleBudgetId, setRuleBudgetId] = useState('');

  // Amount filter — default to transaction amount, unchecked
  const txnAbsAmount = Math.abs(txn.amount);
  const [ruleUseAmount, setRuleUseAmount]     = useState(false);
  const [ruleAmount, setRuleAmount]           = useState(String(txnAbsAmount.toFixed(2)));
  const [ruleAmountTol, setRuleAmountTol]     = useState('0');

  // Day filter — default to transaction day, unchecked
  const txnDay = txn.date ? parseInt(txn.date.slice(8, 10), 10) : 1;
  const [ruleUseDay, setRuleUseDay]           = useState(false);
  const [ruleDay, setRuleDay]                 = useState(String(txnDay));
  const [ruleDayTol, setRuleDayTol]           = useState('0');

  const [saving, setSaving]             = useState(false);
  const [error, setError]               = useState<string | null>(null);

  // Custom color picker state
  const [customOpen, setCustomOpen]     = useState(false);
  const [hexInput, setHexInput]         = useState(PFC_COLORS[0].replace('#', ''));
  const [rgbInput, setRgbInput]         = useState({ r: '', g: '', b: '' });
  const isPfcPreset                     = PFC_COLORS.includes(catColor);

  useEffect(() => {
    setHexInput(catColor.replace('#', ''));
    const r = parseInt(catColor.slice(1, 3), 16);
    const g = parseInt(catColor.slice(3, 5), 16);
    const b = parseInt(catColor.slice(5, 7), 16);
    if (!isNaN(r) && !isNaN(g) && !isNaN(b)) setRgbInput({ r: String(r), g: String(g), b: String(b) });
  }, [catColor]);

  const applyHex = (raw: string) => {
    const h = raw.replace('#', '');
    if (/^[0-9a-fA-F]{6}$/.test(h)) setCatColor('#' + h.toLowerCase());
  };

  const applyRgb = (r: string, g: string, b: string) => {
    const ri = parseInt(r), gi = parseInt(g), bi = parseInt(b);
    if ([ri, gi, bi].every(v => !isNaN(v) && v >= 0 && v <= 255))
      setCatColor('#' + [ri, gi, bi].map(v => v.toString(16).padStart(2, '0')).join(''));
  };

  // The category that will be used — existing or freshly created
  const targetCategory = existing && !createCat ? existing : null;
  const displayName    = targetCategory ? targetCategory.name : catName;

  // Rule section is only available when the category exists or createCat is checked
  const catReady = !!existing || createCat;

  const handleConfirm = async () => {
    if (!assignTxn && !createCat && !createRule) { onClose(); return; }
    setSaving(true);
    setError(null);
    try {
      let category: Category | undefined = existing && !createCat ? existing : undefined;

      // 1. Create category if needed
      if (createCat) {
        category = await putCategory({
          categoryId: '',
          name: catName.trim(),
          color: catColor,
        });
      }

      // 2. Assign transaction
      let updatedTxn = txn;
      if (assignTxn && category) {
        await updateTransactionCategory(txn.accountId, txn.dateTransactionId, category.categoryId);
        updatedTxn = { ...txn, customCategory: category.categoryId };
      }

      // 3. Create rule
      let newRule: Rule | undefined;
      if (createRule && catReady && category) {
        newRule = await putRule({
          ruleId: '',
          pattern: merchantName,
          categoryId: category.categoryId,
          budgetId: ruleBudgetId,
          priority: rulePriority,
          ...(ruleUseAmount && ruleAmount ? {
            amountMatch: parseFloat(ruleAmount),
            amountTolerance: parseFloat(ruleAmountTol) || 0,
          } : {}),
          ...(ruleUseDay && ruleDay ? {
            dayOfMonth: parseInt(ruleDay, 10),
            dayTolerance: parseInt(ruleDayTol, 10) || 0,
          } : {}),
        });
      }

      onDone(updatedTxn, createCat ? category : undefined, newRule);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const ruleDisabled = !catReady;

  return (
    <div style={modalStyles.overlay}>
      <div style={modalStyles.box}>
        <div style={modalStyles.header}>
          <span style={modalStyles.title}>Assign Category?</span>
          <button style={modalStyles.closeBtn} onClick={onClose}>✕</button>
        </div>
        <div style={modalStyles.pfcLabel}>"{pfcLabel}"</div>

        {error && <div style={modalStyles.error}>{error}</div>}

        {/* ── Assign transaction ── */}
        <label style={modalStyles.checkRow}>
          <input type="checkbox" checked={assignTxn} onChange={e => setAssignTxn(e.target.checked)} />
          <span>Assign <strong>{merchantName}</strong> to category <strong>{displayName}</strong></span>
        </label>

        <div style={modalStyles.divider} />

        {/* ── Category ── */}
        {existing && !createCat ? (
          <div style={modalStyles.section}>
            <div style={modalStyles.sectionLabel}>Category</div>
            <div style={modalStyles.existingCat}>
              <span style={{ ...modalStyles.colorDot, background: existing.color }} />
              <span>{existing.name}</span>
              <button style={modalStyles.switchBtn} onClick={() => setCreateCat(true)}>
                Create new instead
              </button>
            </div>
          </div>
        ) : (
          <div style={modalStyles.section}>
            <div style={modalStyles.sectionLabel}>
              {existing ? 'New category' : 'Category doesn\'t exist yet — create it'}
            </div>
            <div style={modalStyles.fieldRow}>
              <input
                style={modalStyles.input}
                value={catName}
                onChange={e => setCatName(e.target.value)}
                placeholder="Category name"
              />
            </div>
            <div style={modalStyles.colorRow}>
              {PFC_COLORS.map(c => (
                <button
                  key={c}
                  style={{ ...modalStyles.colorSwatch, background: c, outline: catColor === c && !customOpen ? '2px solid #2d3748' : 'none' }}
                  onClick={() => { setCatColor(c); setCustomOpen(false); }}
                />
              ))}
              {/* Custom color button */}
              <button
                title="Custom color"
                style={{
                  ...modalStyles.colorSwatch,
                  background: !isPfcPreset ? catColor : 'conic-gradient(red, yellow, lime, aqua, blue, magenta, red)',
                  outline: customOpen || !isPfcPreset ? '2px solid #2d3748' : 'none',
                  outlineOffset: 2,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
                onClick={() => setCustomOpen(o => !o)}
              >
                {isPfcPreset && <span style={{ fontSize: '0.9rem', lineHeight: 1, pointerEvents: 'none' }}>+</span>}
              </button>
            </div>
            {customOpen && (
              <div style={modalStyles.customPanel}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                  <input
                    type="color"
                    value={catColor}
                    onChange={e => setCatColor(e.target.value)}
                    style={{ width: 40, height: 40, border: 'none', borderRadius: 6, cursor: 'pointer', padding: 2, background: 'none' }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                    <span style={modalStyles.inputLabel}>#</span>
                    <input
                      style={{ ...modalStyles.shortInput, width: 72 }}
                      maxLength={6}
                      value={hexInput}
                      onChange={e => { setHexInput(e.target.value); applyHex(e.target.value); }}
                      placeholder="e.g. ff6600"
                    />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                    <span style={modalStyles.inputLabel}>R</span>
                    <input style={modalStyles.shortInput} type="number" min={0} max={255} value={rgbInput.r}
                      onChange={e => { const v = { ...rgbInput, r: e.target.value }; setRgbInput(v); applyRgb(v.r, v.g, v.b); }} />
                    <span style={modalStyles.inputLabel}>G</span>
                    <input style={modalStyles.shortInput} type="number" min={0} max={255} value={rgbInput.g}
                      onChange={e => { const v = { ...rgbInput, g: e.target.value }; setRgbInput(v); applyRgb(v.r, v.g, v.b); }} />
                    <span style={modalStyles.inputLabel}>B</span>
                    <input style={modalStyles.shortInput} type="number" min={0} max={255} value={rgbInput.b}
                      onChange={e => { const v = { ...rgbInput, b: e.target.value }; setRgbInput(v); applyRgb(v.r, v.g, v.b); }} />
                  </div>
                  <div style={{ width: 28, height: 28, borderRadius: '50%', background: catColor, border: '1px solid #cbd5e0', flexShrink: 0 }} />
                </div>
              </div>
            )}
            {existing && (
              <button style={modalStyles.switchBtn} onClick={() => setCreateCat(false)}>
                Use existing "{existing.name}" instead
              </button>
            )}
          </div>
        )}

        <div style={modalStyles.divider} />

        {/* ── Rule ── */}
        <div style={{ opacity: ruleDisabled ? 0.4 : 1, pointerEvents: ruleDisabled ? 'none' : undefined }}>
          {matchingRule && !createRule ? (
            <div style={modalStyles.ruleMatchNote}>
              <span>Matched by existing rule: <strong>"{matchingRule.pattern}"</strong> (priority {matchingRule.priority})</span>
              <button style={modalStyles.switchBtn} onClick={() => setCreateRule(true)}>Create new anyhow</button>
            </div>
          ) : (
            <label style={modalStyles.checkRow}>
              <input type="checkbox" checked={createRule} disabled={ruleDisabled} onChange={e => setCreateRule(e.target.checked)} />
              <span>Create rule: <strong>{merchantName}</strong> → <strong>{displayName}</strong></span>
            </label>
          )}
          {createRule && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.4rem', paddingLeft: '1.4rem' }}>
              <div style={modalStyles.fieldRow}>
                <label style={modalStyles.inlineLabel}>Priority</label>
                <input
                  type="number"
                  style={{ ...modalStyles.input, width: 70 }}
                  value={rulePriority}
                  min={1}
                  onChange={e => setRulePriority(Number(e.target.value))}
                />
                <span style={modalStyles.hint}>(lower runs first)</span>
              </div>
              <div style={modalStyles.fieldRow}>
                <label style={modalStyles.inlineLabel}>Budget</label>
                <select style={{ ...modalStyles.input, flex: 1 }} value={ruleBudgetId} onChange={e => setRuleBudgetId(e.target.value)}>
                  <option value="">— None —</option>
                  <option value={MASTER_BUDGET_ID}>⬡ Master Budget</option>
                  {budgets.map(b => <option key={b.budgetId} value={b.budgetId}>{b.name}</option>)}
                </select>
              </div>
              <label style={modalStyles.checkRow}>
                <input type="checkbox" checked={ruleUseAmount} onChange={e => setRuleUseAmount(e.target.checked)} />
                <span style={{ fontSize: '0.82rem' }}>Match amount</span>
              </label>
              {ruleUseAmount && (
                <div style={{ ...modalStyles.fieldRow, paddingLeft: '1.4rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    <label style={modalStyles.inlineLabel}>Amount ($)</label>
                    <input type="number" min="0.01" step="0.01" style={{ ...modalStyles.input, width: 90 }} value={ruleAmount} onChange={e => setRuleAmount(e.target.value)} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    <label style={modalStyles.inlineLabel}>±$</label>
                    <input type="number" min="0" step="0.01" style={{ ...modalStyles.input, width: 70 }} value={ruleAmountTol} onChange={e => setRuleAmountTol(e.target.value)} />
                  </div>
                </div>
              )}
              <label style={modalStyles.checkRow}>
                <input type="checkbox" checked={ruleUseDay} onChange={e => setRuleUseDay(e.target.checked)} />
                <span style={{ fontSize: '0.82rem' }}>Match day of month</span>
              </label>
              {ruleUseDay && (
                <div style={{ ...modalStyles.fieldRow, paddingLeft: '1.4rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    <label style={modalStyles.inlineLabel}>Day (1–31)</label>
                    <input type="number" min="1" max="31" style={{ ...modalStyles.input, width: 70 }} value={ruleDay} onChange={e => setRuleDay(e.target.value)} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    <label style={modalStyles.inlineLabel}>±days</label>
                    <input type="number" min="0" max="15" style={{ ...modalStyles.input, width: 60 }} value={ruleDayTol} onChange={e => setRuleDayTol(e.target.value)} />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div style={modalStyles.actions}>
          <button style={modalStyles.cancelBtn} onClick={onClose} disabled={saving}>Cancel</button>
          <button style={modalStyles.confirmBtn} onClick={handleConfirm} disabled={saving || (createCat && !catName.trim())}>
            {saving ? 'Saving…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── MbRuleModal ───────────────────────────────────────────────────────────────
interface MbRuleModalProps {
  txn: Transaction;
  rules: Rule[];
  onClose: () => void;
  onDone: (txn: Transaction, newRule?: Rule) => void;
}

const MbRuleModal: React.FC<MbRuleModalProps> = ({ txn, rules, onClose, onDone }) => {
  const merchantName  = txn.customName || txn.merchantName || txn.name;
  const txnAbsAmount  = Math.abs(txn.amount);
  const txnDay        = txn.date ? parseInt(txn.date.slice(8, 10), 10) : 1;

  // Check if there's already a master-budget rule whose pattern matches this merchant
  const existingRule = [...rules]
    .sort((a, b) => a.priority - b.priority)
    .find(r => r.budgetId === MASTER_BUDGET_ID && merchantName.toLowerCase().includes(r.pattern.toLowerCase()));

  const [createRule,   setCreateRule]   = useState(!existingRule);
  const [pattern,      setPattern]      = useState(merchantName);
  const [useAmount,    setUseAmount]    = useState(false);
  const [amountMatch,  setAmountMatch]  = useState(String(txnAbsAmount.toFixed(2)));
  const [amountTol,    setAmountTol]    = useState('5');
  const [useDay,       setUseDay]       = useState(false);
  const [dayOfMonth,   setDayOfMonth]   = useState(String(txnDay));
  const [dayTol,       setDayTol]       = useState('3');
  const [saving,       setSaving]       = useState(false);
  const [error,        setError]        = useState<string | null>(null);

  const handleConfirm = async () => {
    setSaving(true); setError(null);
    try {
      await updateTransactionBudget(txn.accountId, txn.dateTransactionId, MASTER_BUDGET_ID);
      const updatedTxn = { ...txn, budgetId: MASTER_BUDGET_ID, manualBudget: true };
      let newRule: Rule | undefined;
      if (createRule && pattern.trim()) {
        newRule = await putRule({
          ruleId:     '',
          pattern:    pattern.trim(),
          categoryId: '',
          budgetId:   MASTER_BUDGET_ID,
          priority:   50,
          ...(useAmount && amountMatch ? {
            amountMatch:     parseFloat(amountMatch),
            amountTolerance: parseFloat(amountTol) || 0,
          } : {}),
          ...(useDay && dayOfMonth ? {
            dayOfMonth:   parseInt(dayOfMonth, 10),
            dayTolerance: parseInt(dayTol, 10) || 0,
          } : {}),
        });
      }
      onDone(updatedTxn, newRule);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={modalStyles.overlay}>
      <div style={modalStyles.box}>
        <div style={modalStyles.header}>
          <span style={modalStyles.title}>Assign to Master Budget</span>
          <button style={modalStyles.closeBtn} onClick={onClose}>✕</button>
        </div>
        <div style={{ fontSize: '0.875rem', color: '#4a5568' }}>
          <strong>{merchantName}</strong> — {fmtDate(txn.date)}
        </div>

        {error && <div style={modalStyles.error}>{error}</div>}

        {existingRule && (
          <div style={modalStyles.ruleMatchNote}>
            <span>Rule already exists:</span>
            <strong>"{existingRule.pattern}"</strong>
          </div>
        )}

        <div style={modalStyles.divider} />

        <label style={modalStyles.checkRow}>
          <input type="checkbox" checked={createRule} onChange={e => setCreateRule(e.target.checked)} />
          <span>Create a rule for future transactions like this</span>
        </label>

        {createRule && (
          <div style={{ ...modalStyles.section, paddingLeft: '1.4rem', gap: '0.5rem' }}>
            <div style={modalStyles.fieldRow}>
              <label style={modalStyles.inlineLabel}>Description contains</label>
              <input
                style={{ ...modalStyles.input, flex: 1 }}
                value={pattern}
                onChange={e => setPattern(e.target.value)}
                placeholder="e.g. netflix"
              />
            </div>
            <label style={modalStyles.checkRow}>
              <input type="checkbox" checked={useAmount} onChange={e => setUseAmount(e.target.checked)} />
              <span style={{ fontSize: '0.82rem' }}>Match amount</span>
            </label>
            {useAmount && (
              <div style={{ ...modalStyles.fieldRow, paddingLeft: '1.4rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  <label style={modalStyles.inlineLabel}>Amount ($)</label>
                  <input type="number" min="0.01" step="0.01" style={{ ...modalStyles.input, width: 90 }} value={amountMatch} onChange={e => setAmountMatch(e.target.value)} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  <label style={modalStyles.inlineLabel}>±$</label>
                  <input type="number" min="0" step="0.01" style={{ ...modalStyles.input, width: 70 }} value={amountTol} onChange={e => setAmountTol(e.target.value)} />
                </div>
              </div>
            )}
            <label style={modalStyles.checkRow}>
              <input type="checkbox" checked={useDay} onChange={e => setUseDay(e.target.checked)} />
              <span style={{ fontSize: '0.82rem' }}>Match day of month</span>
            </label>
            {useDay && (
              <div style={{ ...modalStyles.fieldRow, paddingLeft: '1.4rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  <label style={modalStyles.inlineLabel}>Day (1–31)</label>
                  <input type="number" min="1" max="31" style={{ ...modalStyles.input, width: 70 }} value={dayOfMonth} onChange={e => setDayOfMonth(e.target.value)} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  <label style={modalStyles.inlineLabel}>±days</label>
                  <input type="number" min="0" max="15" style={{ ...modalStyles.input, width: 60 }} value={dayTol} onChange={e => setDayTol(e.target.value)} />
                </div>
              </div>
            )}
            <p style={{ ...modalStyles.hint, marginTop: '0.2rem' }}>
              Matching transactions will automatically be assigned to Master Budget.
            </p>
          </div>
        )}

        <div style={modalStyles.actions}>
          <button style={modalStyles.cancelBtn} onClick={onClose} disabled={saving}>Skip</button>
          <button style={modalStyles.confirmBtn} onClick={handleConfirm} disabled={saving}>
            {saving ? 'Saving…' : createRule ? 'Assign + Create Rule' : 'Assign'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Refund candidate picker modal ─────────────────────────────────────────────

const RefundCandidateModal: React.FC<{
  credit: Transaction;
  candidates: RefundCandidate[];
  selected?: string;
  match?: RefundMatch;
  onSelect: (id: string) => void;
  onClose: () => void;
}> = ({ credit, candidates, selected, match, onSelect, onClose }) => {
  const [filter, setFilter] = React.useState('');
  // Local selection: start from explicit prop, then fall back to first candidate (best match).
  const [localSelected, setLocalSelected] = React.useState<string | undefined>(
    selected ?? candidates[0]?.dateTransactionId
  );

  const sorted = [...candidates].sort((a, b) => {
    const dateCmp = b.date.localeCompare(a.date);
    if (dateCmp !== 0) return dateCmp;
    return b.amount - a.amount;
  });

  const filterLower = filter.toLowerCase();
  const visible = filter
    ? sorted.filter(c =>
        c.note?.toLowerCase().includes(filterLower) ||
        c.merchantName?.toLowerCase().includes(filterLower) ||
        c.name?.toLowerCase().includes(filterLower) ||
        c.amount.toFixed(2).includes(filterLower)
      )
    : sorted;

  const handleConfirm = () => {
    if (localSelected) { onSelect(localSelected); onClose(); }
  };

  return (
    <div style={modalStyles.overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ ...modalStyles.box, maxWidth: 640, maxHeight: '80vh', display: 'flex', flexDirection: 'column', gap: 0 }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: '1rem', color: '#2d3748' }}>Pick Original Charge</div>
            <div style={{ fontSize: '0.8rem', color: '#718096', marginTop: '0.2rem' }}>
              Refund {fmtDate(credit.date)} &mdash; {fmtCurrency(Math.abs(credit.amount))} &mdash; {credit.customName || credit.merchantName || credit.name}
            </div>
            {match && (() => {
              const s = match.status;
              const bg = s === 'confident' ? '#c6f6d5' : s === 'ambiguous' ? '#fef3c7' : s === 'partial' ? '#feebcb' : '#e9d8fd';
              const fg = s === 'confident' ? '#276749' : s === 'ambiguous' ? '#92400e' : s === 'partial' ? '#7b341e' : '#553c9a';
              return (
                <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  <span style={{ display: 'inline-block', background: bg, color: fg, borderRadius: 10, padding: '0.15rem 0.6rem', fontSize: '0.75rem', fontWeight: 600, textTransform: 'capitalize', alignSelf: 'flex-start' }}>
                    {s}
                  </span>
                  {match.note && (
                    <span style={{ fontSize: '0.78rem', color: '#4a5568' }}>{match.note}</span>
                  )}
                </div>
              );
            })()}
          </div>
          <button style={modalStyles.closeBtn} onClick={onClose}>✕</button>
        </div>

        {/* Filter */}
        <div style={{ marginBottom: '0.6rem' }}>
          <input
            autoFocus
            type="text"
            placeholder="Filter by merchant, item title, or amount…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #cbd5e0', borderRadius: 5, padding: '0.3rem 0.5rem', fontSize: '0.85rem' }}
          />
        </div>

        {/* Candidate list — click to select, Confirm button to commit */}
        <div style={{ overflowY: 'auto', flex: 1, border: '1px solid #e2e8f0', borderRadius: 6 }}>
          {visible.length === 0 && (
            <div style={{ padding: '1rem', textAlign: 'center', color: '#a0aec0', fontSize: '0.85rem' }}>No matches</div>
          )}
          {visible.map(c => {
            const isSelected = c.dateTransactionId === localSelected;
            return (
              <div
                key={c.dateTransactionId}
                onClick={() => setLocalSelected(c.dateTransactionId)}
                style={{
                  padding: '0.55rem 0.75rem',
                  borderBottom: '1px solid #edf2f7',
                  cursor: 'pointer',
                  background: isSelected ? '#ebf8ff' : '#fff',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.15rem',
                }}
                onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = '#f7fafc'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = isSelected ? '#ebf8ff' : '#fff'; }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.5rem' }}>
                  <span style={{ fontWeight: isSelected ? 600 : 400, fontSize: '0.85rem', color: '#2d3748' }}>
                    {fmtDate(c.date)} &mdash; {c.merchantName || c.name}
                  </span>
                  <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#2b6cb0', whiteSpace: 'nowrap' }}>
                    {fmtCurrency(c.amount)}
                  </span>
                </div>
                {c.note && (
                  <div style={{ fontSize: '0.75rem', color: '#718096' }}>{c.note}</div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{ marginTop: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '0.75rem', color: '#a0aec0' }}>
            {visible.length} of {candidates.length} shown
          </span>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={onClose}
              style={{ background: 'none', border: '1px solid #cbd5e0', borderRadius: 6, padding: '0.35rem 0.85rem', cursor: 'pointer', fontSize: '0.85rem', color: '#4a5568' }}
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={!localSelected}
              style={{ background: localSelected ? '#2b6cb0' : '#a0aec0', border: 'none', borderRadius: 6, padding: '0.35rem 0.85rem', cursor: localSelected ? 'pointer' : 'default', fontSize: '0.85rem', color: '#fff', fontWeight: 600 }}
            >
              Confirm
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

const modalStyles: Record<string, React.CSSProperties> = {
  overlay:    { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' },
  box:        { background: '#fff', borderRadius: 10, padding: '1.25rem 1.5rem', width: '100%', maxWidth: 460, boxShadow: '0 8px 32px rgba(0,0,0,0.18)', display: 'flex', flexDirection: 'column', gap: '0.75rem' },
  header:     { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  title:      { fontWeight: 700, fontSize: '1rem', color: '#2d3748' },
  closeBtn:   { background: 'none', border: 'none', cursor: 'pointer', color: '#718096', fontSize: '1rem', padding: 0 },
  pfcLabel:   { fontSize: '0.9rem', color: '#0d7a6b', fontWeight: 600 },
  error:      { background: '#fff5f5', color: '#c53030', border: '1px solid #feb2b2', borderRadius: 6, padding: '0.5rem 0.75rem', fontSize: '0.82rem' },
  checkRow:   { display: 'flex', alignItems: 'flex-start', gap: '0.5rem', fontSize: '0.875rem', color: '#2d3748', cursor: 'pointer' },
  divider:    { borderTop: '1px solid #e2e8f0' },
  section:    { display: 'flex', flexDirection: 'column', gap: '0.4rem' },
  sectionLabel: { fontSize: '0.78rem', color: '#718096', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' },
  existingCat:{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem' },
  colorDot:   { width: 12, height: 12, borderRadius: '50%', flexShrink: 0 },
  switchBtn:  { background: 'none', border: 'none', cursor: 'pointer', color: '#0d7a6b', fontSize: '0.78rem', padding: 0, textDecoration: 'underline' },
  ruleMatchNote: { display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', fontSize: '0.82rem', color: '#4a5568', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, padding: '0.45rem 0.65rem' },
  fieldRow:   { display: 'flex', alignItems: 'center', gap: '0.5rem' },
  input:      { border: '1px solid #cbd5e0', borderRadius: 5, padding: '0.3rem 0.5rem', fontSize: '0.875rem', flex: 1 },
  colorRow:   { display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' },
  colorSwatch:{ width: 22, height: 22, borderRadius: '50%', border: 'none', cursor: 'pointer', outlineOffset: 2 },
  customPanel:{ marginTop: '0.5rem', padding: '0.6rem 0.75rem', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8 },
  shortInput: { width: 48, border: '1px solid #cbd5e0', borderRadius: 6, padding: '0.25rem 0.35rem', fontSize: '0.8rem' },
  inputLabel: { fontSize: '0.75rem', fontWeight: 600, color: '#4a5568' },
  inlineLabel:{ fontSize: '0.8rem', color: '#4a5568', whiteSpace: 'nowrap' },
  hint:       { fontSize: '0.75rem', color: '#a0aec0' },
  actions:    { display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.25rem' },
  cancelBtn:  { background: 'none', border: '1px solid #0d7a6b', borderRadius: 6, padding: '0.4rem 0.9rem', cursor: 'pointer', fontSize: '0.875rem', color: '#0d7a6b' },
  confirmBtn: { background: '#0d7a6b', color: '#fff', border: 'none', borderRadius: 6, padding: '0.4rem 1rem', cursor: 'pointer', fontSize: '0.875rem', fontWeight: 600 },
};

// ── Transaction detail panel ──────────────────────────────────────────────────
const fmtChannel = (c?: string) => {
  if (!c) return '—';
  return toTitleCase(c.replace(/_/g, ' '));
};

// Book-style title case: lowercase minor words unless first or last
const MINOR = new Set(['a','an','the','and','but','or','nor','for','so','yet',
  'at','by','in','of','on','to','up','as','is','it']);

const toTitleCase = (s: string): string => {
  const words = s.toLowerCase().replace(/_/g, ' ').split(' ');
  return words.map((w, i) =>
    (i === 0 || i === words.length - 1 || !MINOR.has(w))
      ? w.charAt(0).toUpperCase() + w.slice(1)
      : w
  ).join(' ');
};

// "2024-03-07" → "03/07/24" — see src/utils/dates.ts

const TxnDetail: React.FC<{
  txn: Transaction;
  accounts: Account[];
  onPfcClick: (label: string) => void;
  editingNoteId: string | null;
  noteDraft: string;
  savingNote: boolean;
  onEditNote: (txn: Transaction) => void;
  onNoteChange: (v: string) => void;
  onSaveNote: (txn: Transaction, note: string) => void;
  onCancelNote: () => void;
  editingNameId: string | null;
  nameDraft: string;
  savingName: boolean;
  onEditName: (txn: Transaction) => void;
  onNameChange: (v: string) => void;
  onSaveName: (txn: Transaction) => void;
  onCancelName: () => void;
  onLinkRefund?: (txn: Transaction) => void;
  linkingRefund?: boolean;
  onIgnore?: (txn: Transaction, ignored: boolean) => void;
  ignoringId?: string | null;
}> = ({ txn, accounts, onPfcClick, editingNoteId, noteDraft, savingNote, onEditNote, onNoteChange, onSaveNote, onCancelNote, editingNameId, nameDraft, savingName, onEditName, onNameChange, onSaveName, onCancelName, onLinkRefund, linkingRefund, onIgnore, ignoringId }) => {
  const acct = accounts.find(a => a.accountId === txn.accountId);
  const acctLabel = acct ? `${acct.institution} — ${acct.nickName || acct.name}` : txn.accountId;

  const hasPrimary  = !!txn.personalFinancePrimary;
  const hasDetailed = !!txn.personalFinanceDetailed && txn.personalFinanceDetailed !== txn.personalFinancePrimary;
  const fmtPfcStr = (s: string) => toTitleCase(s);

  // Build location block for right-side display
  const locationBlock = (() => {
    const loc = txn.location;
    if (!loc) return null;
    const line1 = loc.address || '';
    const line2 = [loc.city, loc.region, loc.postalCode].filter(Boolean).join(', ');
    const parts = [line1, line2].filter(Boolean);
    if (parts.length === 0) return null;
    let href: string;
    if (loc.lat != null && loc.lon != null) {
      href = `https://www.google.com/maps?q=${loc.lat},${loc.lon}`;
    } else {
      href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(parts.join(', '))}`;
    }
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" style={detailStyles.locationLink}>
        {line1 && <span style={{ display: 'block' }}>{line1}</span>}
        {line2 && <span style={{ display: 'block' }}>{line2}</span>}
      </a>
    );
  })();

  return (
    <div style={detailStyles.wrap}>
      <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, ...detailStyles.grid }}>
          <DetailRow label="Account"              value={acctLabel} />
          <DetailRow label="Original Description" value={txn.originalDescription} />
          <DetailRow label="Authorized Date"      value={fmtDate(txn.authorizedDate)} />
          <DetailRow label="Payment Channel"      value={fmtChannel(txn.paymentChannel)} />

          {/* Friendly Name — user-editable display name */}
          {!txn.pending && (
            <div style={detailStyles.row}>
              <span style={detailStyles.label}>Friendly Name</span>
              <span style={detailStyles.value}>
                {editingNameId === txn.dateTransactionId ? (
                  <span style={{ display: 'inline-flex', gap: '0.35rem', alignItems: 'center' }}>
                    <input
                      autoFocus
                      type="text"
                      value={nameDraft}
                      placeholder={txn.merchantName || txn.name}
                      onChange={e => onNameChange(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') onSaveName(txn);
                        if (e.key === 'Escape') onCancelName();
                      }}
                      style={{ fontSize: '0.82rem', padding: '0.15rem 0.35rem', border: '1px solid #cbd5e0', borderRadius: 4, width: 240 }}
                    />
                    <button style={inlineStyles.refSaveBtn} onClick={() => onSaveName(txn)} disabled={savingName}>{savingName ? '...' : 'Save'}</button>
                    <button style={inlineStyles.refCancelBtn} onClick={onCancelName}>✕</button>
                  </span>
                ) : (
                  <span style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center' }}>
                    <span>{txn.customName || '—'}</span>
                    <button style={inlineStyles.nickBtn} onClick={() => onEditName(txn)} title="Edit friendly name">✎</button>
                  </span>
                )}
              </span>
            </div>
          )}

          {/* Note — user-editable free-text annotation */}
          <div style={detailStyles.row}>
            <span style={detailStyles.label}>Note</span>
            <span style={detailStyles.value}>
              {editingNoteId === txn.dateTransactionId ? (
                <span style={{ display: 'inline-flex', gap: '0.35rem', alignItems: 'center' }}>
                  <input
                    autoFocus
                    type="text"
                    value={noteDraft}
                    onChange={e => onNoteChange(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') onSaveNote(txn, noteDraft);
                      if (e.key === 'Escape') onCancelNote();
                    }}
                    style={{ fontSize: '0.82rem', padding: '0.15rem 0.35rem', border: '1px solid #cbd5e0', borderRadius: 4, width: 240 }}
                  />
                  <button style={inlineStyles.refSaveBtn} onClick={() => onSaveNote(txn, noteDraft)} disabled={savingNote}>{savingNote ? '...' : 'Save'}</button>
                  <button style={inlineStyles.refCancelBtn} onClick={onCancelNote}>✕</button>
                </span>
              ) : (
                <span style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center' }}>
                  <span>{txn.note || '—'}</span>
                  {!txn.pending && (
                    <button style={inlineStyles.nickBtn} onClick={() => onEditNote(txn)} title="Edit note">✎</button>
                  )}
                </span>
              )}
            </span>
          </div>

          {/* Link refund — shown for categorized+budgeted credits without an existing link */}
          {onLinkRefund && txn.amount < 0 && !txn.linkedOriginalId && !txn.pending && (
            <div style={detailStyles.row}>
              <span style={detailStyles.label}>Refund</span>
              <span style={detailStyles.value}>
                <button
                  style={inlineStyles.nickBtn}
                  disabled={linkingRefund}
                  onClick={() => onLinkRefund(txn)}
                >
                  {linkingRefund ? '…' : 'Link refund'}
                </button>
              </span>
            </div>
          )}

          {/* Personal Finance Category — clickable levels */}
          <div style={detailStyles.row}>
            <span style={detailStyles.label}>Personal Finance Category</span>
            <span style={detailStyles.value}>
              {!hasPrimary && '—'}
              {hasPrimary && (
                <button style={detailStyles.pfcBtn} onClick={() => onPfcClick(fmtPfcStr(txn.personalFinancePrimary!))}>
                  {fmtPfcStr(txn.personalFinancePrimary!)}
                </button>
              )}
              {hasPrimary && hasDetailed && (
                <>
                  <span style={{ color: '#a0aec0', margin: '0 4px' }}>›</span>
                  <button style={detailStyles.pfcBtn} onClick={() => onPfcClick(fmtPfcStr(txn.personalFinanceDetailed!))}>
                    {fmtPfcStr(txn.personalFinanceDetailed!)}
                  </button>
                </>
              )}
            </span>
          </div>

          {txn.logoUrl && (
            <div style={detailStyles.row}>
              <span style={detailStyles.label}>Merchant Logo</span>
              <img src={txn.logoUrl} alt="merchant logo" style={detailStyles.logo} />
            </div>
          )}
        </div>

        {locationBlock && (
          <div style={detailStyles.locationCol}>
            {locationBlock}
          </div>
        )}
      </div>

      {/* Ignore / Unignore — bottom-right of panel */}
      {onIgnore && !txn.pending && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
          <button
            style={{
              background: txn.ignored ? '#fff' : 'none',
              border: `1px solid ${txn.ignored ? '#0d7a6b' : '#cbd5e0'}`,
              borderRadius: 6,
              padding: '0.3rem 0.75rem',
              cursor: ignoringId === txn.dateTransactionId ? 'default' : 'pointer',
              fontSize: '0.8rem',
              color: txn.ignored ? '#0d7a6b' : '#718096',
              fontWeight: txn.ignored ? 600 : 400,
              opacity: ignoringId === txn.dateTransactionId ? 0.6 : 1,
            }}
            disabled={ignoringId === txn.dateTransactionId}
            onClick={() => onIgnore(txn, !txn.ignored)}
          >
            {ignoringId === txn.dateTransactionId ? '…' : txn.ignored ? 'Unignore' : 'Ignore'}
          </button>
        </div>
      )}
    </div>
  );
};

const DetailRow: React.FC<{ label: string; value?: string }> = ({ label, value }) => (
  <div style={detailStyles.row}>
    <span style={detailStyles.label}>{label}</span>
    <span style={detailStyles.value}>{value || '—'}</span>
  </div>
);

const detailStyles: Record<string, React.CSSProperties> = {
  wrap:        { background: '#f7f8fc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '0.75rem 1rem', marginTop: 2 },
  grid:        { display: 'flex', flexDirection: 'column', gap: '0.4rem' },
  row:         { display: 'flex', gap: '0.75rem', alignItems: 'baseline', fontSize: '0.82rem' },
  label:       { color: '#718096', minWidth: 180, flexShrink: 0, fontWeight: 500 },
  value:       { color: '#2d3748' },
  logo:        { height: 28, borderRadius: 4 },
  pfcBtn:      { background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#0d7a6b', fontSize: 'inherit', fontFamily: 'inherit', textDecoration: 'underline', textDecorationStyle: 'dotted' },
  locationCol:  { flexShrink: 0, textAlign: 'right' },
  locationLink: { color: '#0d7a6b', fontSize: '0.82rem', lineHeight: 1.6, textDecoration: 'none' },
};

// ── Account filter dropdown ───────────────────────────────────────────────────
const AccountFilterDropdown: React.FC<{
  accounts: Account[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
}> = ({ accounts, selected, onChange, isOpen, onOpen, onClose }) => {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Group accounts by institution
  const institutions = React.useMemo(() => {
    const map = new Map<string, Account[]>();
    for (const a of accounts) {
      const list = map.get(a.institution) ?? [];
      list.push(a);
      map.set(a.institution, list);
    }
    return map;
  }, [accounts]);

  const toggleAccount = (accountId: string) => {
    const next = new Set(selected);
    if (next.has(accountId)) next.delete(accountId); else next.add(accountId);
    onChange(next);
  };

  const toggleInstitution = (accts: Account[]) => {
    const ids = accts.map(a => a.accountId);
    const allSelected = ids.every(id => selected.has(id));
    const next = new Set(selected);
    if (allSelected) ids.forEach(id => next.delete(id));
    else ids.forEach(id => next.add(id));
    onChange(next);
  };

  const toggleCollapsed = (institution: string) => {
    const next = new Set(collapsed);
    if (next.has(institution)) next.delete(institution); else next.add(institution);
    setCollapsed(next);
  };

  // tri-state: 'all' | 'some' | 'none'
  const institutionState = (accts: Account[]): 'all' | 'some' | 'none' => {
    const ids = accts.map(a => a.accountId);
    const count = ids.filter(id => selected.has(id)).length;
    if (count === 0) return 'none';
    if (count === ids.length) return 'all';
    return 'some';
  };

  const totalSelected = selected.size;
  // Treat 0 selected (when accounts exist) as active/filtered — same teal styling
  const isFiltered = accounts.length > 0;

  return (
    <>
      <button
        style={{
          ...inlineStyles.applyBtn,
          fontWeight: isFiltered ? 600 : undefined,
        }}
        onClick={() => onOpen()}
      >
        Filter Accounts ({totalSelected})
      </button>
      {isOpen && (
        <div style={modalStyles.overlay}>
          <div style={{ ...modalStyles.box, maxWidth: 380 }}>
            <div style={modalStyles.header}>
              <span style={modalStyles.title}>Filter Accounts ({totalSelected})</span>
              <button style={modalStyles.closeBtn} onClick={() => onClose()}>✕</button>
            </div>
            <div style={acctFilterStyles.clearRow}>
              <button style={acctFilterStyles.clearBtn} onClick={() => onChange(new Set())}>Clear all</button>
              <button style={acctFilterStyles.clearBtn} onClick={() => onChange(new Set(accounts.map(a => a.accountId)))}>Select all</button>
            </div>
            <div style={{ maxHeight: 360, overflowY: 'auto' }}>
              {Array.from(institutions.entries()).map(([institution, accts]) => {
                const state = institutionState(accts);
                const isCollapsed = collapsed.has(institution);
                return (
                  <div key={institution} style={acctFilterStyles.group}>
                    <div style={acctFilterStyles.branchRow}>
                      {/* Tri-state checkbox toggles selection */}
                      <span style={{ display: 'inline-flex' }} onClick={() => toggleInstitution(accts)}>
                        <TriStateCheckbox state={state} />
                      </span>
                      {/* Institution name + caret toggles collapse */}
                      <span style={acctFilterStyles.branchLabel} onClick={() => toggleCollapsed(institution)}>
                        <span style={acctFilterStyles.branchName}>{institution}</span>
                        <span style={{ ...acctFilterStyles.caret, transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▾</span>
                      </span>
                    </div>
                    {!isCollapsed && accts.map(a => (
                      <label key={a.accountId} style={acctFilterStyles.leafLabel} onClick={() => toggleAccount(a.accountId)}>
                        <LeafCheckbox checked={selected.has(a.accountId)} />
                        <span style={acctFilterStyles.leafName}>{a.nickName || a.name}</span>
                        <span style={acctFilterStyles.leafType}>{a.subtype || a.type}</span>
                      </label>
                    ))}
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.75rem' }}>
              <button style={modalStyles.confirmBtn} onClick={() => onClose()}>Done</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

// Custom tri-state checkbox: none=unchecked, some=gray bg + white check, all=teal bg + white check
const TriStateCheckbox: React.FC<{ state: 'all' | 'some' | 'none' }> = ({ state }) => {
  const bg   = state === 'all' ? '#0d7a6b' : state === 'some' ? '#a0aec0' : '#fff';
  const border = state === 'none' ? '2px solid #cbd5e0' : 'none';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 16, height: 16, borderRadius: 3, background: bg, border,
      flexShrink: 0, cursor: 'pointer',
    }}>
      {state !== 'none' && (
        <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
          <path d="M1 4l3 3 5-6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      )}
    </span>
  );
};

// Simple styled binary checkbox for leaves
const LeafCheckbox: React.FC<{ checked: boolean }> = ({ checked }) => (
  <span style={{
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 16, height: 16, borderRadius: 3, flexShrink: 0, cursor: 'pointer',
    background: checked ? '#0d7a6b' : '#fff',
    border: checked ? 'none' : '2px solid #cbd5e0',
  }}>
    {checked && (
      <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
        <path d="M1 4l3 3 5-6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    )}
  </span>
);

const acctFilterStyles: Record<string, React.CSSProperties> = {
  clearRow: { display: 'flex', gap: '1rem', padding: '0 0 0.5rem', borderBottom: '1px solid #e2e8f0', marginBottom: '0.25rem' },
  clearBtn: { background: 'none', border: 'none', color: '#0d7a6b', cursor: 'pointer', fontSize: '0.8rem', padding: 0 },
  group: { padding: '0.5rem 0 0.25rem' },
  branchRow: { display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.3rem' },
  branchLabel: { display: 'flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer', userSelect: 'none' as const, flex: 1 },
  branchName: { fontWeight: 600, fontSize: '0.875rem', color: '#2d3748' },
  caret: { fontSize: '0.7rem', color: '#718096', transition: 'transform 0.15s', display: 'inline-block' },
  leafLabel: { display: 'flex', alignItems: 'center', gap: '0.6rem', paddingLeft: '1.6rem', cursor: 'pointer', userSelect: 'none' as const, marginBottom: '0.2rem' },
  leafName: { fontSize: '0.85rem', color: '#2d3748', flex: 1 },
  leafType: { fontSize: '0.75rem', color: '#718096', background: '#f7fafc', borderRadius: 10, padding: '0.05rem 0.4rem', whiteSpace: 'nowrap' as const },
};

// ── Add / Edit manual transaction modal ───────────────────────────────────────
interface AddTxnModalProps {
  accounts: Account[];
  categories: Category[];
  budgets: Budget[];
  initial?: Transaction | null;
  onClose: () => void;
  onSave: (txn: Transaction) => void;
}

const AddTransactionModal: React.FC<AddTxnModalProps> = ({
  accounts, categories, budgets, initial, onClose, onSave,
}) => {
  const today = new Date().toISOString().slice(0, 10);
  const [accountId,  setAccountId]  = useState(initial?.accountId  ?? (accounts[0]?.accountId ?? ''));
  const [date,       setDate]       = useState(initial?.date        ?? today);
  const [name,       setName]       = useState(initial?.name        ?? '');
  const [amount,     setAmount]     = useState(initial ? String(initial.amount) : '');
  const [catId,      setCatId]      = useState(initial?.customCategory ?? '');
  const [budgetId,   setBudgetId]   = useState(initial?.budgetId    ?? '');
  const [saving,     setSaving]     = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  const handleSave = async () => {
    if (!accountId || !date || !name.trim()) { setError('Account, date, and name are required.'); return; }
    const amt = parseFloat(amount);
    if (isNaN(amt)) { setError('Amount must be a number.'); return; }
    setSaving(true);
    setError(null);
    try {
      const saved = await putTransaction({
        accountId,
        date,
        name: name.trim(),
        amount: amt,
        customCategory: catId || undefined,
        budgetId: budgetId || undefined,
        transactionId: initial?.transactionId,
      });
      onSave(saved);
    } catch (e: any) {
      setError(e.message ?? 'Save failed');
      setSaving(false);
    }
  };

  return (
    <div style={modalStyles.overlay}>
      <div style={{ ...modalStyles.box, maxWidth: 420 }}>
        <div style={modalStyles.header}>
          <span style={modalStyles.title}>{initial ? 'Edit Transaction' : 'Add Transaction'}</span>
          <button style={modalStyles.closeBtn} onClick={onClose}>✕</button>
        </div>
        {error && <div style={modalStyles.error}>{error}</div>}

        <div style={addTxnStyles.field}>
          <label style={addTxnStyles.label}>Account</label>
          <select style={addTxnStyles.input} value={accountId} onChange={e => setAccountId(e.target.value)}>
            {accounts.map(a => <option key={a.accountId} value={a.accountId}>{a.institution} — {a.nickName || a.name}</option>)}
          </select>
        </div>
        <div style={addTxnStyles.field}>
          <label style={addTxnStyles.label}>Date</label>
          <input style={addTxnStyles.input} type="date" value={date} onChange={e => setDate(e.target.value)} />
        </div>
        <div style={addTxnStyles.field}>
          <label style={addTxnStyles.label}>Description</label>
          <input style={addTxnStyles.input} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Grocery run" />
        </div>
        <div style={addTxnStyles.field}>
          <label style={addTxnStyles.label}>Amount</label>
          <input style={addTxnStyles.input} type="number" step="0.01" value={amount}
            onChange={e => setAmount(e.target.value)} placeholder="Positive = expense, negative = income" />
        </div>
        <div style={addTxnStyles.field}>
          <label style={addTxnStyles.label}>Category <span style={addTxnStyles.optional}>(optional)</span></label>
          <select style={addTxnStyles.input} value={catId} onChange={e => setCatId(e.target.value)}>
            <option value="">— Uncategorized —</option>
            {categories.map(c => <option key={c.categoryId} value={c.categoryId}>{c.name}</option>)}
          </select>
        </div>
        <div style={addTxnStyles.field}>
          <label style={addTxnStyles.label}>Budget <span style={addTxnStyles.optional}>(optional)</span></label>
          <select style={addTxnStyles.input} value={budgetId} onChange={e => setBudgetId(e.target.value)}>
            <option value="">— None —</option>
            {budgets.map(b => <option key={b.budgetId} value={b.budgetId}>{b.name}</option>)}
          </select>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
          <button style={modalStyles.cancelBtn} onClick={onClose} disabled={saving}>Cancel</button>
          <button style={modalStyles.confirmBtn} onClick={handleSave}
            disabled={saving || !accountId || !date || !name.trim() || amount === ''}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
};

const addTxnStyles: Record<string, React.CSSProperties> = {
  field:    { display: 'flex', flexDirection: 'column', gap: '0.2rem' },
  label:    { fontSize: '0.8rem', fontWeight: 600, color: '#4a5568' },
  optional: { fontWeight: 400, color: '#a0aec0' },
  input:    { border: '1px solid #cbd5e0', borderRadius: 6, padding: '0.4rem 0.6rem', fontSize: '0.875rem' },
};

// ── Transactions page ─────────────────────────────────────────────────────────
const TransactionsPage: React.FC = () => {
  const { accounts, categories, setCategories, budgets, rules, setRules, incomeSources,
          txnRange, setTxnRange, txnSortKey, setTxnSortKey, txnSortDir, setTxnSortDir,
          txnPage, setTxnPage, txnPageSize, setTxnPageSize } = useData();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [selectedAccounts, setSelectedAccounts] = useState<Set<string>>(new Set());
  const [filterAccountsOpen, setFilterAccountsOpen] = useState(false);

  // Initialize selectedAccounts to all accounts once loaded
  useEffect(() => {
    if (accounts.length > 0 && selectedAccounts.size === 0) {
      setSelectedAccounts(new Set(accounts.map(a => a.accountId)));
    }
  }, [accounts]); // eslint-disable-line react-hooks/exhaustive-deps
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [assigningBudgetId, setAssigningBudgetId] = useState<string | null>(null);
  const [showUncatUnbudgetedOnly, setShowUncatUnbudgetedOnly] = useState(false);
  const [applyingRules, setApplyingRules] = useState(false);
  const [applyMsg, setApplyMsg] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [editingRefId, setEditingRefId] = useState<string | null>(null);
  const [refUrl, setRefUrl] = useState('');
  const [refNote, setRefNote] = useState('');
  const [savingRef, setSavingRef] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [editingNameId, setEditingNameId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  const nameCancelRef = React.useRef(false);
  const [splitEditorId, setSplitEditorId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [pfcModal, setPfcModal] = useState<{ txn: Transaction; label: string } | null>(null);
  const [mbRuleModal, setMbRuleModal] = useState<Transaction | null>(null);
  const [addTxnModal, setAddTxnModal] = useState<{ txn?: Transaction } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [incomeModal, setIncomeModal] = useState<Transaction | null>(null);
  const [refundReport, setRefundReport] = useState<FindRefundsResponse | null>(null);
  const [findingRefunds, setFindingRefunds] = useState(false);
  const [confirmingRefunds, setConfirmingRefunds] = useState(false);
  const [refundSelections, setRefundSelections] = useState<Record<string, string>>({});
  const [refundChecked, setRefundChecked] = useState<Record<string, boolean>>({});
  const [refundCategoryOverrides, setRefundCategoryOverrides] = useState<Record<string, string>>({});
  const [candidateModalCreditId, setCandidateModalCreditId] = useState<string | null>(null);
  const [refundBudgetOverrides, setRefundBudgetOverrides] = useState<Record<string, string>>({});
  const [refundMsg, setRefundMsg] = useState<string | null>(null);
  const [refundStatusFilter, setRefundStatusFilter] = useState<Set<string>>(new Set(['confident', 'ambiguous', 'partial', 'multi']));
  // Inline "Link refund" flow — initiated directly from a credit transaction row.
  const [inlineCreditTxn, setInlineCreditTxn] = useState<Transaction | null>(null);
  const [inlineCandidates, setInlineCandidates] = useState<RefundCandidate[] | null>(null);
  const [inlineMatch, setInlineMatch] = useState<RefundMatch | null>(null);
  const [inlineLinking, setInlineLinking] = useState<string | null>(null); // dateTransactionId being linked
  const [linkedNavModal, setLinkedNavModal] = useState<{ dtids: string[]; direction: 'refund' | 'original'; allTxns: Transaction[]; selectedDtid: string; loading: boolean } | null>(null);

  // Show pending toggle — off by default, remembered across sessions
  const [showPending, setShowPending] = useState(
    () => localStorage.getItem('finance_show_pending') === 'true'
  );
  const toggleShowPending = (val: boolean) => {
    setShowPending(val);
    localStorage.setItem('finance_show_pending', String(val));
  };

  // Show ignored toggle — off by default, remembered across sessions
  const [showIgnored, setShowIgnored] = useState(
    () => localStorage.getItem('finance_show_ignored') === 'true'
  );
  const toggleShowIgnored = (val: boolean) => {
    setShowIgnored(val);
    localStorage.setItem('finance_show_ignored', String(val));
  };

  const [ignoringId, setIgnoringId] = useState<string | null>(null);

  // If a txn has category/budget, show a warning before ignoring
  const [pendingIgnoreTxn, setPendingIgnoreTxn] = useState<Transaction | null>(null);

  const handleToggleIgnored = async (txn: Transaction, ignored: boolean) => {
    // When ignoring: if the txn has a category or budget, show warning modal first
    if (ignored && (txn.customCategory || txn.budgetId)) {
      setPendingIgnoreTxn(txn);
      return;
    }
    await _doIgnore(txn, ignored);
  };

  const _doIgnore = async (txn: Transaction, ignored: boolean) => {
    setIgnoringId(txn.dateTransactionId);
    try {
      const promises: Promise<any>[] = [
        updateTransactionIgnored(txn.accountId, txn.dateTransactionId, ignored),
      ];
      if (ignored && txn.customCategory) {
        promises.push(updateTransactionCategory(txn.accountId, txn.dateTransactionId, ''));
      }
      if (ignored && txn.budgetId) {
        promises.push(updateTransactionBudget(txn.accountId, txn.dateTransactionId, ''));
      }
      await Promise.all(promises);
      setTransactions(prev => prev.map(t =>
        t.dateTransactionId === txn.dateTransactionId
          ? { ...t, ignored, ...(ignored ? { customCategory: undefined, budgetId: undefined } : {}) }
          : t
      ));
    } catch (e: any) { setError(e.message); }
    finally { setIgnoringId(null); }
  };

  const toggleDetail = (id: string) =>
    setDetailId(prev => prev === id ? null : id);

  const isoDate = (d: Date) => d.toISOString().slice(0, 10);

  const dateRange = (key: typeof txnRange): { startDate: string; endDate: string } => {
    const now = new Date();
    const today = isoDate(now);
    switch (key) {
      case 'last30':
        return { startDate: isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29)), endDate: today };
      case 'last60':
        return { startDate: isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 59)), endDate: today };
      case 'last90':
        return { startDate: isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 89)), endDate: today };
      case 'last6months':
        return { startDate: isoDate(new Date(now.getFullYear(), now.getMonth() - 6, now.getDate())), endDate: today };
      case 'currentMonth':
        return {
          startDate: isoDate(new Date(now.getFullYear(), now.getMonth(), 1)),
          endDate:   isoDate(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
        };
      case 'currentYear':
        return {
          startDate: `${now.getFullYear()}-01-01`,
          endDate:   `${now.getFullYear()}-12-31`,
        };
    }
  };

  const RANGE_OPTIONS: { value: typeof txnRange; label: string }[] = [
    { value: 'currentMonth', label: 'Current month' },
    { value: 'last30',       label: 'Last 30 days' },
    { value: 'last60',       label: 'Last 60 days' },
    { value: 'last90',       label: 'Last 90 days' },
    { value: 'last6months',  label: 'Last 6 months' },
    { value: 'currentYear',  label: 'Current year' },
  ];

  const { startDate, endDate } = dateRange(txnRange);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      setTransactions(await getTransactions({ startDate, endDate }));
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [startDate, endDate]);

  useEffect(() => { load(); }, [load]);

  const assignCategory = async (txn: Transaction, categoryId: string) => {
    // If the user picks the Income category, open the income source modal first
    if (categoryId === INCOME_CATEGORY_ID) {
      setAssigningId(null);
      setIncomeModal(txn);
      // Still set the category optimistically so the dropdown reflects it
      await updateTransactionCategory(txn.accountId, txn.dateTransactionId, categoryId);
      setTransactions(prev => prev.map(t =>
        t.dateTransactionId === txn.dateTransactionId ? { ...t, customCategory: categoryId } : t
      ));
      return;
    }
    setAssigningId(txn.dateTransactionId);
    try {
      await updateTransactionCategory(txn.accountId, txn.dateTransactionId, categoryId);
      setTransactions(prev => prev.map(t =>
        t.dateTransactionId === txn.dateTransactionId ? { ...t, customCategory: categoryId } : t
      ));
    } catch (e: any) { setError(e.message); }
    finally { setAssigningId(null); }
  };

  const assignBudget = async (txn: Transaction, budgetId: string) => {
    if (budgetId === MASTER_BUDGET_ID) {
      setMbRuleModal(txn);
      return;
    }
    setAssigningBudgetId(txn.dateTransactionId);
    try {
      await updateTransactionBudget(txn.accountId, txn.dateTransactionId, budgetId);
      setTransactions(prev => prev.map(t =>
        t.dateTransactionId === txn.dateTransactionId
          ? { ...t, budgetId, manualBudget: budgetId !== '' }
          : t
      ));
    } catch (e: any) { setError(e.message); }
    finally { setAssigningBudgetId(null); }
  };

  const handleApplyRules = async () => {
    setApplyingRules(true); setApplyMsg(null); setError(null);
    try {
      const result = await applyRules();  // apply across all transactions, not just current month view
      setApplyMsg(`Rules applied: ${result.updated} transaction(s) updated.`);
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setApplyingRules(false); }
  };

  const handleSync = async () => {
    setSyncing(true); setApplyMsg(null); setError(null);
    try {
      const result = await syncTransactions();
      setApplyMsg(`Sync complete: ${result.added} added, ${result.modified} updated${result.errors ? `, ${result.errors} error(s)` : ''}.`);
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setSyncing(false); }
  };

  // Show the linked transaction in a modal (works regardless of current page/date range).
  const navigateToLinked = async (dtids: string | string[], direction: 'refund' | 'original') => {
    const dtidList = Array.isArray(dtids) ? dtids : [dtids];
    setLinkedNavModal({ dtids: dtidList, direction, allTxns: [], selectedDtid: dtidList[0] ?? '', loading: true });
    try {
      const results = await Promise.all(dtidList.map(async dtid => {
        const date = dtid.split('#')[0] ?? '';
        const txns = await getTransactions({ startDate: date, endDate: date });
        return txns.find(t => t.dateTransactionId === dtid) ?? null;
      }));
      const allTxns = results.filter((t): t is Transaction => t !== null);
      setLinkedNavModal(prev => prev ? { ...prev, allTxns, selectedDtid: allTxns[0]?.dateTransactionId ?? dtidList[0] ?? '', loading: false } : null);
    } catch {
      setLinkedNavModal(prev => prev ? { ...prev, loading: false } : null);
    }
  };

  const handleFindRefunds = async () => {
    setFindingRefunds(true); setRefundMsg(null);
    try {
      const report = await findRefunds();
      setRefundReport(report);
      // Pre-select single candidates automatically
      const sel: Record<string, string> = {};
      const checked: Record<string, boolean> = {};
      report.matches.forEach((m: RefundMatch) => {
        // Pre-select the first candidate for all non-multi statuses
        // (backend always puts the best match first).
        if (m.status !== 'multi' && m.candidates.length > 0) {
          sel[m.credit.dateTransactionId] = m.candidates[0].dateTransactionId;
        }
        // Pre-check confident, ambiguous, and partial; leave multi unchecked until user picks
        if (m.status === 'confident' || m.status === 'ambiguous' || m.status === 'partial') {
          checked[m.credit.dateTransactionId] = true;
        }
      });
      setRefundSelections(sel);
      setRefundChecked(checked);
      setRefundCategoryOverrides({});
      setRefundBudgetOverrides({});
      setRefundStatusFilter(new Set(['confident', 'ambiguous', 'partial', 'multi']));
    } catch (e: any) { setRefundMsg('Error: ' + (e.message || String(e))); }
    finally { setFindingRefunds(false); }
  };

   const handleConfirmRefunds = async () => {
    if (!refundReport) return;
    const pairs: RefundPair[] = refundReport.matches
      .filter((m: RefundMatch) => refundStatusFilter.has(m.status) && refundChecked[m.credit.dateTransactionId] && refundSelections[m.credit.dateTransactionId])
      .map((m: RefundMatch) => ({
        creditDateTransactionId: m.credit.dateTransactionId,
        debitDateTransactionId: refundSelections[m.credit.dateTransactionId],
        categoryOverride: refundCategoryOverrides[m.credit.dateTransactionId] || undefined,
        budgetOverride: refundBudgetOverrides[m.credit.dateTransactionId] || undefined,
      }));
    if (pairs.length === 0) { setRefundMsg('No matches selected.'); return; }

    setConfirmingRefunds(true); setRefundMsg(null);
    try {
      const result = await confirmRefunds(pairs);
      setRefundMsg(`Saved ${result.confirmed} link${result.confirmed !== 1 ? 's' : ''}.`);
      setRefundReport(null);
      await load();
    } catch (e: any) { setRefundMsg('Error: ' + (e.message || String(e))); }
    finally { setConfirmingRefunds(false); }
  };

  const handleInlineLinkRefund = async (txn: Transaction) => {
    setInlineLinking(txn.dateTransactionId);
    try {
      const report = await findRefunds(txn.dateTransactionId);
      const match = report.matches.find(m => m.credit.dateTransactionId === txn.dateTransactionId);
      if (!match || match.candidates.length === 0) {
        alert('No matching charges found for this credit.');
        return;
      }
      // Always show the modal so the user can confirm, regardless of candidate count.
      setInlineCreditTxn(txn);
      setInlineCandidates(match.candidates);
      setInlineMatch(match);
    } catch (e: any) {
      alert('Error: ' + (e.message || String(e)));
    } finally {
      setInlineLinking(null);
    }
  };

  const handleInlineConfirm = async (debitDateTransactionId: string) => {
    if (!inlineCreditTxn) return;
    try {
      await confirmRefunds([{
        creditDateTransactionId: inlineCreditTxn.dateTransactionId,
        debitDateTransactionId,
      }]);
      setInlineCreditTxn(null);
      setInlineCandidates(null);
      setInlineMatch(null);
      await load();
    } catch (e: any) {
      alert('Error: ' + (e.message || String(e)));
    }
  };

  const handleSaveManualTxn = (saved: Transaction) => {
    setTransactions(prev => {
      const idx = prev.findIndex(t => t.dateTransactionId === saved.dateTransactionId);
      if (idx >= 0) { const next = [...prev]; next[idx] = saved; return next; }
      return [saved, ...prev];
    });
    setAddTxnModal(null);
  };

  const handleDeleteManualTxn = async (txn: Transaction) => {
    if (!window.confirm(`Delete "${txn.name}"? This cannot be undone.`)) return;
    setDeletingId(txn.dateTransactionId);
    try {
      await deleteTransaction(txn.accountId, txn.dateTransactionId);
      setTransactions(prev => prev.filter(t => t.dateTransactionId !== txn.dateTransactionId));
    } catch (e: any) { setError(e.message); }
    finally { setDeletingId(null); }
  };

  const handleDeletePendingTxn = async (txn: Transaction) => {
    if (!window.confirm(
      `Delete pending transaction "${txn.name}"?\n\n` +
      `Warning: if this transaction hasn't posted yet, it will reappear the next time you sync. ` +
      `Only delete it if you're sure it's a duplicate or was cancelled by the merchant.`
    )) return;
    setDeletingId(txn.dateTransactionId);
    try {
      await deleteTransaction(txn.accountId, txn.dateTransactionId);
      setTransactions(prev => prev.filter(t => t.dateTransactionId !== txn.dateTransactionId));
    } catch (e: any) { setError(e.message); }
    finally { setDeletingId(null); }
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

  const saveNote = async (txn: Transaction, note: string) => {
    setSavingNote(true);
    try {
      await updateTransactionNote(txn.accountId, txn.dateTransactionId, note);
      setTransactions(prev => prev.map(t =>
        t.dateTransactionId === txn.dateTransactionId ? { ...t, note: note || undefined } : t
      ));
      setEditingNoteId(null);
    } catch (e: any) { setError(e.message); }
    finally { setSavingNote(false); }
  };

  const openNameEditor = (txn: Transaction) => {
    setEditingNameId(txn.dateTransactionId);
    setNameDraft(txn.customName || '');
  };

  const saveName = async (txn: Transaction) => {
    if (nameCancelRef.current) { nameCancelRef.current = false; return; }
    const trimmed = nameDraft.trim();
    setEditingNameId(null);
    if (trimmed === (txn.customName || '')) return;
    setSavingName(true);
    try {
      await updateTransactionName(txn.accountId, txn.dateTransactionId, trimmed);
      const custom = trimmed || undefined;
      setTransactions(prev => prev.map(t =>
        t.dateTransactionId === txn.dateTransactionId ? { ...t, customName: custom } : t
      ));
    } catch (e: any) { setError(e.message); }
    finally { setSavingName(false); }
  };

  const handleSplitSaved = (updated: Transaction) => {
    setTransactions(prev => prev.map(t =>
      t.dateTransactionId === updated.dateTransactionId ? updated : t
    ));
    setSplitEditorId(null);
  };

  const handlePfcDone = (updatedTxn: Transaction, newCategory?: Category, newRule?: Rule) => {
    setTransactions(prev => prev.map(t =>
      t.dateTransactionId === updatedTxn.dateTransactionId ? updatedTxn : t
    ));
    if (newCategory) setCategories(prev => [...prev, newCategory]);
    if (newRule)     setRules(prev => [...prev, newRule]);
    setPfcModal(null);
  };

  const handleMbRuleDone = (updatedTxn: Transaction, newRule?: Rule) => {
    setTransactions(prev => prev.map(t =>
      t.dateTransactionId === updatedTxn.dateTransactionId ? updatedTxn : t
    ));
    if (newRule) setRules(prev => [...prev.filter(r => r.ruleId !== newRule.ruleId), newRule]);
    setMbRuleModal(null);
  };

  const amtColor = (txn: Transaction) => txn.ignored ? '#a0aec0' : txn.amount > 0 ? '#e53e3e' : '#38a169';
  const amtStr = (txn: Transaction) => `${txn.amount > 0 ? '-' : '+'}${fmtCurrency(txn.amount)}`;

  const toggleSort = (key: typeof txnSortKey) => {
    setTxnPage(1);
    if (txnSortKey === key) {
      setTxnSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setTxnSortKey(key);
      setTxnSortDir(key === 'date' ? 'desc' : 'asc');
    }
  };

  const sortArrow = (key: typeof txnSortKey) =>
    txnSortKey === key ? (txnSortDir === 'asc' ? ' ↑' : ' ↓') : '';

  const filtered = transactions
    .filter(t => selectedAccounts.has(t.accountId))
    .filter(t => {
      if (!showUncatUnbudgetedOnly) return true;
      // For split transactions, check whether any split is missing a category or budget.
      // Only show if at least one split is incomplete.
      if (t.splits && t.splits.length > 0) {
        return t.splits.some(s => !s.customCategory || !s.budgetId);
      }
      return !t.customCategory || !t.budgetId;
    })
    .filter(t => showPending || !t.pending)
    .filter(t => showIgnored || !t.ignored);
  const visible = [...filtered].sort((a, b) => {
    // Pending always floats above posted regardless of sort column
    if (a.pending !== b.pending) return a.pending ? -1 : 1;
    let cmp = 0;
    if (txnSortKey === 'date')     cmp = a.date.localeCompare(b.date);
    else if (txnSortKey === 'merchant') cmp = (a.customName || a.merchantName || a.name).localeCompare(b.customName || b.merchantName || b.name);
    else if (txnSortKey === 'amount')   cmp = a.amount - b.amount;
    return txnSortDir === 'asc' ? cmp : -cmp;
  });

  
  const totalPages = Math.max(1, Math.ceil(visible.length / txnPageSize));
  const effectivePage = Math.min(txnPage, totalPages);
  const paginated = visible.slice((effectivePage - 1) * txnPageSize, effectivePage * txnPageSize);

  return (
    <div className="page">
      {candidateModalCreditId && refundReport && (() => {
        const match = refundReport.matches.find(m => m.credit.dateTransactionId === candidateModalCreditId);
        if (!match) return null;
        return (
          <RefundCandidateModal
            credit={match.credit}
            candidates={match.candidates}
            selected={refundSelections[candidateModalCreditId]}
            match={match}
            onSelect={id => {
              setRefundSelections(prev => ({ ...prev, [candidateModalCreditId]: id }));
              setRefundChecked(prev => ({ ...prev, [candidateModalCreditId]: true }));
            }}
            onClose={() => setCandidateModalCreditId(null)}
          />
        );
      })()}
      {inlineCreditTxn && inlineCandidates && (
        <RefundCandidateModal
          credit={inlineCreditTxn}
          candidates={inlineCandidates}
          match={inlineMatch ?? undefined}
          onSelect={handleInlineConfirm}
          onClose={() => { setInlineCreditTxn(null); setInlineCandidates(null); setInlineMatch(null); }}
        />
      )}
      {pfcModal && (
        <PfcCategoryModal
          pfcLabel={pfcModal.label}
          txn={pfcModal.txn}
          categories={categories}
          budgets={budgets}
          rules={rules}
          onClose={() => setPfcModal(null)}
          onDone={handlePfcDone}
        />
      )}
      {mbRuleModal && (
        <MbRuleModal
          txn={mbRuleModal}
          rules={rules}
          onClose={() => setMbRuleModal(null)}
          onDone={handleMbRuleDone}
        />
      )}
      {pendingIgnoreTxn && (
        <div style={navBlockStyles.overlay}>
          <div style={navBlockStyles.dialog}>
            <p style={navBlockStyles.title}>Ignore transaction?</p>
            <p style={navBlockStyles.body}>
              This transaction has a category{pendingIgnoreTxn.budgetId ? ' and budget' : ''} assigned.
              Ignoring it will remove {pendingIgnoreTxn.budgetId ? 'them' : 'it'}.
            </p>
            <div style={navBlockStyles.footer}>
              <button style={navBlockStyles.discardBtn} onClick={() => setPendingIgnoreTxn(null)}>Cancel</button>
              <button style={navBlockStyles.stayBtn} onClick={() => { _doIgnore(pendingIgnoreTxn, true); setPendingIgnoreTxn(null); }}>Continue</button>
            </div>
          </div>
        </div>
      )}
      {addTxnModal && (
        <AddTransactionModal
          accounts={accounts}
          categories={categories}
          budgets={budgets}
          initial={addTxnModal.txn}
          onClose={() => setAddTxnModal(null)}
          onSave={handleSaveManualTxn}
        />
      )}
      {incomeModal && (() => {
        // Build map of incomeSourceId -> existing income rule for pre-population
        const incomeRulesBySourceId: Record<string, Rule> = {};
        for (const rule of rules) {
          if (rule.incomeSourceId) incomeRulesBySourceId[rule.incomeSourceId] = rule;
        }
        return (
          <IncomeSourceModal
            transaction={incomeModal}
            incomeSources={incomeSources}
            incomeRulesBySourceId={incomeRulesBySourceId}
            onClose={() => setIncomeModal(null)}
            onConfirm={(sourceId, budgetId, rule) => {
              if (budgetId) {
                setTransactions(prev => prev.map(t =>
                  t.dateTransactionId === incomeModal.dateTransactionId
                    ? { ...t, budgetId, manualBudget: true }
                    : t
                ));
              }
              if (rule) {
                setRules(prev => {
                  const without = prev.filter(r => r.ruleId !== rule.ruleId);
                  return [...without, rule];
                });
              }
              setIncomeModal(null);
            }}
          />
        );
      })()}
      {error && <div style={inlineStyles.error}>{error}</div>}
      {applyMsg && <div style={inlineStyles.success}>{applyMsg}</div>}

      {/* Filters */}
      <div className="filters">
        <div className="filter-left">
          <AccountFilterDropdown
            accounts={accounts}
            selected={selectedAccounts}
            onChange={v => { setSelectedAccounts(v); setTxnPage(1); }}
            isOpen={filterAccountsOpen}
            onOpen={() => setFilterAccountsOpen(true)}
            onClose={() => setFilterAccountsOpen(false)}
          />
          <select
            value={txnRange}
            onChange={e => { setTxnRange(e.target.value as typeof txnRange); setTxnPage(1); }}
            style={inlineStyles.monthPicker}
          >
            {RANGE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <label style={inlineStyles.checkLabel} onClick={() => { setShowUncatUnbudgetedOnly(v => !v); setTxnPage(1); }}>
            <span style={txnToggleStyles.track(showUncatUnbudgetedOnly)}>
              <span style={txnToggleStyles.thumb(showUncatUnbudgetedOnly)} />
            </span>
            Uncategorized &amp; unbudgeted only
          </label>
          <label style={inlineStyles.checkLabel} onClick={() => { toggleShowPending(!showPending); setTxnPage(1); }}>
            <span style={txnToggleStyles.track(showPending)}>
              <span style={txnToggleStyles.thumb(showPending)} />
            </span>
            Show pending
          </label>
          <label style={inlineStyles.checkLabel} onClick={() => { toggleShowIgnored(!showIgnored); setTxnPage(1); }}>
            <span style={txnToggleStyles.track(showIgnored)}>
              <span style={txnToggleStyles.thumb(showIgnored)} />
            </span>
            Show ignored
          </label>
        </div>
        <div className="filter-right">
          <button style={inlineStyles.applyBtn} onClick={handleApplyRules} disabled={applyingRules}
            title="Re-run all auto-assignment rules on this month's transactions">
            {applyingRules ? 'Applying...' : 'Re-apply Rules'}
          </button>
          <button style={inlineStyles.applyBtn} onClick={handleFindRefunds} disabled={findingRefunds}
            title="Find transactions that are likely refunds of earlier charges">
            {findingRefunds ? 'Scanning...' : 'Find Refunds'}
          </button>
          <button style={inlineStyles.syncBtn} onClick={handleSync} disabled={syncing}
            title="Pull latest transactions from Plaid">
            {syncing ? 'Syncing...' : '↻ Sync Now'}
          </button>
          <button style={inlineStyles.btn} onClick={() => setAddTxnModal({})}
            title="Add a manual transaction">
            + Add
          </button>
        </div>
      </div>

      {/* ── Refund matching panel ── */}
      {(refundReport || refundMsg) && (
        <div style={{ border: '1px solid #cbd5e0', borderRadius: '0.5rem', margin: '1rem 0', padding: '1rem', background: '#f7fafc' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <strong style={{ fontSize: '1rem' }}>
              {refundReport ? `Found ${refundReport.matches.length} possible refund${refundReport.matches.length !== 1 ? 's' : ''}` : 'Refunds'}
            </strong>
            <button style={inlineStyles.refCancelBtn} onClick={() => { setRefundReport(null); setRefundMsg(null); }}>✕ Close</button>
          </div>
          {refundMsg && <div style={{ color: refundMsg.startsWith('Error') ? '#e53e3e' : '#2f855a', marginBottom: '0.5rem', fontSize: '0.9rem' }}>{refundMsg}</div>}
          {refundReport && refundReport.matches.length > 0 && (
            <>
              {/* Status filter pills */}
              <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.6rem', flexWrap: 'wrap' }}>
                {(['confident', 'ambiguous', 'partial', 'multi'] as const).map(s => {
                  const count = refundReport.matches.filter(m => m.status === s).length;
                  if (count === 0) return null;
                  const active = refundStatusFilter.has(s);
                  const pillColor = s === 'confident' ? '#38a169' : s === 'ambiguous' ? '#d69e2e' : s === 'partial' ? '#dd6b20' : '#805ad5';
                  return (
                    <button
                      key={s}
                      onClick={() => setRefundStatusFilter(prev => {
                        const next = new Set(prev);
                        if (next.has(s)) { next.delete(s); } else { next.add(s); }
                        return next;
                      })}
                      style={{
                        borderRadius: 12, padding: '0.2rem 0.75rem', fontSize: '0.78rem', cursor: 'pointer', fontWeight: 500,
                        background: active ? pillColor : '#edf2f7',
                        color: active ? '#fff' : '#4a5568',
                        border: `1px solid ${active ? pillColor : '#cbd5e0'}`,
                      }}
                    >
                      {s} ({count})
                    </button>
                  );
                })}
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                 <thead>
                   <tr style={{ borderBottom: '1px solid #e2e8f0', color: '#718096' }}>
                     <th style={{ padding: '0.3rem 0.5rem', width: '2rem' }}></th>
                     <th style={{ textAlign: 'left', padding: '0.3rem 0.5rem' }}>Status</th>
                    <th style={{ textAlign: 'left', padding: '0.3rem 0.5rem' }}>Credit (refund received)</th>
                    <th style={{ textAlign: 'right', padding: '0.3rem 0.5rem' }}>Amount</th>
                    <th style={{ textAlign: 'left', padding: '0.3rem 0.5rem' }}>Original charge</th>
                    <th style={{ textAlign: 'left', padding: '0.3rem 0.5rem' }}>Category</th>
                    <th style={{ textAlign: 'left', padding: '0.3rem 0.5rem' }}>Budget</th>
                  </tr>
                </thead>
                 <tbody>
                   {[...refundReport.matches].sort((a, b) => b.credit.date.localeCompare(a.credit.date)).filter(m => refundStatusFilter.has(m.status)).map((m: RefundMatch) => {
                      const creditId = m.credit.dateTransactionId;
                      const selected = refundSelections[creditId] ?? (m.status !== 'multi' ? m.candidates[0]?.dateTransactionId : undefined);
                      const selectedCandidate = m.candidates.find(c => c.dateTransactionId === selected);
                     const catOverride = refundCategoryOverrides[creditId];
                    const budgetOverride = refundBudgetOverrides[creditId];
                    // Use category/budget from the selected candidate (debit) directly
                    const originalCat = selectedCandidate?.customCategory ?? '';
                    const originalBudget = selectedCandidate?.budgetId ?? '';
                    const catLabel = originalCat ? (categories.find(c => c.categoryId === originalCat)?.name ?? originalCat) : '';
                    const budgetLabel = originalBudget ? (budgets.find(b => b.budgetId === originalBudget)?.name ?? originalBudget) : '';
                     return (
                       <tr key={creditId} style={{ borderBottom: '1px solid #edf2f7' }}>
                         <td style={{ padding: '0.4rem 0.5rem', textAlign: 'center' }}>
                           <input
                             type="checkbox"
                             checked={!!refundChecked[creditId]}
                             disabled={m.status === 'multi' && !refundSelections[creditId]}
                             onChange={e => setRefundChecked(prev => ({ ...prev, [creditId]: e.target.checked }))}
                           />
                         </td>
                         <td style={{ padding: '0.4rem 0.5rem' }}>
                           <span style={{
                             display: 'inline-block', padding: '0.15rem 0.45rem', borderRadius: '999px', fontSize: '0.75rem', fontWeight: 600,
                             background: m.status === 'confident' ? '#c6f6d5' : m.status === 'ambiguous' ? '#fef3c7' : m.status === 'partial' ? '#feebcb' : '#e9d8fd',
                             color: m.status === 'confident' ? '#276749' : m.status === 'ambiguous' ? '#92400e' : m.status === 'partial' ? '#7b341e' : '#553c9a',
                           }}>
                             {m.status}
                           </span>
                           {m.note && <div style={{ fontSize: '0.72rem', color: '#718096', marginTop: '0.2rem' }}>{m.note}</div>}
                        </td>
                        <td style={{ padding: '0.4rem 0.5rem' }}>
                          {fmtDate(m.credit.date)} — {m.credit.customName || m.credit.merchantName || m.credit.name}
                        </td>
                        <td style={{ padding: '0.4rem 0.5rem', textAlign: 'right', color: '#2f855a' }}>
                          {fmtCurrency(Math.abs(m.credit.amount))}
                        </td>
                         <td style={{ padding: '0.4rem 0.5rem' }}>
                           <>
                             <button
                               onClick={() => setCandidateModalCreditId(creditId)}
                               style={{
                                 fontSize: '0.8rem', padding: '0.2rem 0.6rem', cursor: 'pointer',
                                 border: '1px solid #cbd5e0', borderRadius: 4, background: '#fff',
                                 color: selectedCandidate ? '#2d3748' : '#718096',
                               }}
                             >
                               {selectedCandidate
                                 ? `${fmtDate(selectedCandidate.date)} — ${selectedCandidate.merchantName || selectedCandidate.name} (${fmtCurrency(selectedCandidate.amount)})`
                                 : m.candidates.length > 1
                                   ? `— pick from ${m.candidates.length} charges —`
                                   : '— pick charge —'}
                             </button>
                             {selectedCandidate?.note && <div style={{ fontSize: '0.72rem', color: '#718096', marginTop: '0.15rem' }}>💬 {selectedCandidate.note}</div>}
                           </>
                          </td>
                         <td style={{ padding: '0.4rem 0.5rem' }}>
                           {originalCat && !catOverride ? (
                            <span style={{ fontSize: '0.8rem', color: '#4a5568' }}>{catLabel}</span>
                          ) : (
                            <select
                              value={catOverride || originalCat}
                              onChange={e => setRefundCategoryOverrides(prev => ({ ...prev, [creditId]: e.target.value }))}
                              style={{ fontSize: '0.8rem', padding: '0.15rem' }}
                            >
                              <option value="">— category —</option>
                              {categories.map(c => <option key={c.categoryId} value={c.categoryId}>{c.name}</option>)}
                            </select>
                          )}
                        </td>
                        <td style={{ padding: '0.4rem 0.5rem' }}>
                          {originalBudget && !budgetOverride ? (
                            <span style={{ fontSize: '0.8rem', color: '#4a5568' }}>{budgetLabel}</span>
                          ) : (
                            <select
                              value={budgetOverride || originalBudget}
                              onChange={e => setRefundBudgetOverrides(prev => ({ ...prev, [creditId]: e.target.value }))}
                              style={{ fontSize: '0.8rem', padding: '0.15rem' }}
                            >
                              <option value="">— budget —</option>
                              {budgets.map(b => <option key={b.budgetId} value={b.budgetId}>{b.name}</option>)}
                            </select>
                          )}
                        </td>
                      </tr>
                     );
                   })}
                 </tbody>
               </table>
              <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <button
                  style={{ ...inlineStyles.applyBtn, background: '#2b6cb0', color: '#fff' }}
                  onClick={handleConfirmRefunds}
                  disabled={confirmingRefunds}
                >
                  {confirmingRefunds ? 'Saving...' : (() => { const n = refundReport.matches.filter((m: RefundMatch) => refundStatusFilter.has(m.status) && refundChecked[m.credit.dateTransactionId]).length; return `Confirm ${n} Link${n !== 1 ? 's' : ''}`; })()}
                </button>
              </div>
            </>
          )}
          {refundReport && refundReport.matches.length === 0 && (
            <div style={{ color: '#718096', fontSize: '0.9rem' }}>No unlinked refunds found.</div>
          )}
        </div>
      )}

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
                <th style={inlineStyles.sortableTh} onClick={() => toggleSort('date')}>Date{sortArrow('date')}</th>
                <th style={inlineStyles.sortableTh} onClick={() => toggleSort('merchant')}>Merchant{sortArrow('merchant')}</th>
                <th>Category</th><th>Budget</th>
                <th style={{ textAlign: 'right', cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('amount')}>Amount{sortArrow('amount')}</th>
                <th>Status</th><th>Ref</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {paginated.map(txn => (
                <React.Fragment key={txn.dateTransactionId}>
                   <tr id={`txn-row-${txn.dateTransactionId}`} style={
                     txn.ignored ? { background: '#edf2f7', color: '#a0aec0', fontStyle: 'italic' } :
                     txn.pending ? { background: '#f1f5f9', color: '#718096' } : undefined
                   }>
                    <td>
                      <button
                        style={inlineStyles.merchantBtn}
                        onClick={() => toggleDetail(txn.dateTransactionId)}
                        title="Show transaction details"
                      >
                        {fmtDate(txn.date)}
                        {detailId === txn.dateTransactionId ? ' ▲' : ' ▼'}
                      </button>
                    </td>
                     <td>
                       <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                         <span>{txn.customName || txn.merchantName || txn.name}</span>
                         {txn.customName && <span style={inlineStyles.origName}>({txn.merchantName || txn.name})</span>}
                         {txn.linkedRefundIds && txn.linkedRefundIds.length > 0 && (
                           <span
                             style={{ fontSize: '0.7rem', background: '#e2e8f0', color: '#4a5568', borderRadius: '999px', padding: '0.1rem 0.4rem', cursor: 'pointer' }}
                             title={`Refunded (${txn.linkedRefundIds.length} refund${txn.linkedRefundIds.length > 1 ? 's' : ''})`}
                             onClick={() => navigateToLinked(txn.linkedRefundIds!, 'refund')}
                           >{txn.linkedRefundIds.length > 1 ? `↩ refunded ×${txn.linkedRefundIds.length}` : '↩ refunded'}</span>
                         )}
                         {txn.linkedOriginalId && (
                           <span
                             style={{ fontSize: '0.7rem', background: '#b2f5ea', color: '#234e52', borderRadius: '999px', padding: '0.1rem 0.4rem', cursor: 'pointer' }}
                             title={`Refund of ${txn.linkedOriginalId}`}
                             onClick={() => navigateToLinked(txn.linkedOriginalId!, 'original')}
                           >refund</span>
                         )}
                         {txn.note && (
                           <span title={txn.note} style={{ fontSize: '0.85rem', cursor: 'default', lineHeight: 1 }}>💬</span>
                         )}
                       </span>
                     </td>
                     <td>
                       <div style={inlineStyles.catCell}>
                         {txn.pending ? null : txn.splits && txn.splits.length > 0 ? (
                           <span style={{ fontSize: '0.8rem', color: '#718096', fontStyle: 'italic' }}>
                             {txn.splits.length} splits
                           </span>
                         ) : txn.ignored ? (
                           txn.customCategory
                             ? <CatBadge catId={txn.customCategory} categories={categories} />
                             : <span style={{ fontSize: '0.8rem', color: '#a0aec0' }}>—</span>
                         ) : (
                           <>
                             <CatSelect txn={txn} categories={categories} assigningId={assigningId} onAssign={assignCategory} />
                           </>
                         )}
                       </div>
                     </td>
                     <td>
                       <div style={inlineStyles.catCell}>
                         {txn.pending ? null : txn.splits && txn.splits.length > 0 ? (
                           <span style={{ fontSize: '0.8rem', color: '#718096', fontStyle: 'italic' }}>per split</span>
                         ) : txn.ignored ? (
                           <span style={{ fontSize: '0.8rem', color: '#a0aec0' }}>
                             {txn.budgetId ? (budgets.find(b => b.budgetId === txn.budgetId)?.name ?? '—') : '—'}
                           </span>
                         ) : (
                           <BudgetSelect txn={txn} budgets={budgets} incomeSources={incomeSources} assigningId={assigningBudgetId} onAssign={assignBudget} />
                         )}
                       </div>
                     </td>
                    <td style={{ textAlign: 'right', color: amtColor(txn) }}>{amtStr(txn)}</td>
                    <td>{txn.pending ? 'Pending' : 'Posted'}</td>
                    <td>
                      {editingRefId === txn.dateTransactionId && !txn.pending ? (
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
                          {!txn.pending && !txn.ignored && (
                            <button style={inlineStyles.refEditBtn} onClick={() => openRefEditor(txn)} title="Edit reference">
                              {txn.referenceUrl ? '✎' : '+'}
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                      <td>
                        {!txn.pending && (
                           <>
                             {!txn.ignored && (
                               <button
                                 className="split-badge"
                                 onClick={() => setSplitEditorId(
                                   splitEditorId === txn.dateTransactionId ? null : txn.dateTransactionId
                                 )}
                                 title={txn.splits && txn.splits.length > 0 ? 'Edit splits' : 'Split transaction'}
                               >
                                 {txn.splits && txn.splits.length > 0 ? `⅔ ${txn.splits.length}` : '⅔ Split'}
                               </button>
                             )}
                             {!txn.ignored && txn.amount < 0 && !txn.linkedOriginalId && !txn.customCategory && !txn.budgetId && (
                               <button
                                 className="split-badge"
                                 title="Link to original charge"
                                 disabled={inlineLinking === txn.dateTransactionId}
                                 onClick={() => handleInlineLinkRefund(txn)}
                               >
                                 {inlineLinking === txn.dateTransactionId ? '…' : 'Link refund'}
                               </button>
                             )}
                             {txn.transactionId.startsWith('manual-') && (
                               <>
                                 <button style={inlineStyles.refEditBtn} title="Edit transaction"
                                   onClick={() => setAddTxnModal({ txn })}>✎</button>
                                 <button style={{ ...inlineStyles.refEditBtn, color: '#e53e3e' }} title="Delete transaction"
                                   disabled={deletingId === txn.dateTransactionId}
                                   onClick={() => handleDeleteManualTxn(txn)}>🗑</button>
                               </>
                             )}
                           </>
                         )}
                         {txn.pending && (
                           <button style={{ ...inlineStyles.refEditBtn, color: '#e53e3e' }} title="Delete pending transaction"
                             disabled={deletingId === txn.dateTransactionId}
                             onClick={() => handleDeletePendingTxn(txn)}>🗑</button>
                         )}
                      </td>
                  </tr>
                  {splitEditorId === txn.dateTransactionId && (
                    <tr>
                      <td colSpan={8} style={{ padding: '0 0.75rem 0.75rem' }}>
                         <SplitEditor
                           txn={txn}
                           categories={categories}
                           budgets={budgets}
                           onClose={() => setSplitEditorId(null)}
                           onSaved={handleSplitSaved}
                         />
                      </td>
                    </tr>
                  )}
                  {detailId === txn.dateTransactionId && (
                    <tr>
                      <td colSpan={8} style={{ padding: '0 0.75rem 0.75rem' }}>
                         <TxnDetail
                           txn={txn}
                           accounts={accounts}
                           onPfcClick={label => setPfcModal({ txn, label })}
                           editingNoteId={editingNoteId}
                           noteDraft={noteDraft}
                           savingNote={savingNote}
                           onEditNote={t => { setEditingNoteId(t.dateTransactionId); setNoteDraft(t.note || ''); }}
                           onNoteChange={setNoteDraft}
                           onSaveNote={saveNote}
                           onCancelNote={() => setEditingNoteId(null)}
                           editingNameId={editingNameId}
                           nameDraft={nameDraft}
                           savingName={savingName}
                           onEditName={openNameEditor}
                           onNameChange={setNameDraft}
                           onSaveName={saveName}
                           onCancelName={() => setEditingNameId(null)}
                           onLinkRefund={txn.customCategory && txn.budgetId ? handleInlineLinkRefund : undefined}
                            linkingRefund={inlineLinking === txn.dateTransactionId}
                            onIgnore={handleToggleIgnored}
                            ignoringId={ignoringId}
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
            {paginated.map(txn => (
              <div key={txn.dateTransactionId} className="txn-card" style={txn.pending ? { background: '#f1f5f9', color: '#718096' } : undefined}>
                 <div className="txn-card-row">
                   <span className="txn-card-merchant">
                     {txn.customName || txn.merchantName || txn.name}
                     {txn.customName && <span style={inlineStyles.origName}> ({txn.merchantName || txn.name})</span>}
                     {txn.linkedRefundIds && txn.linkedRefundIds.length > 0 && (
                       <span style={{ fontSize: '0.7rem', background: '#e2e8f0', color: '#4a5568', borderRadius: '999px', padding: '0.1rem 0.4rem', marginLeft: '0.3rem' }}>
                         {txn.linkedRefundIds.length > 1 ? `↩ refunded ×${txn.linkedRefundIds.length}` : '↩ refunded'}
                       </span>
                     )}
                     {txn.linkedOriginalId && (
                       <span style={{ fontSize: '0.7rem', background: '#b2f5ea', color: '#234e52', borderRadius: '999px', padding: '0.1rem 0.4rem', marginLeft: '0.3rem' }}>refund</span>
                     )}
                      {txn.note && (
                        <span title={txn.note} style={{ fontSize: '0.85rem', marginLeft: '0.3rem', cursor: 'default' }}>💬</span>
                      )}
                   </span>
                   <span className="txn-card-amount" style={{ color: amtColor(txn) }}>{amtStr(txn)}</span>
                 </div>
                <div className="txn-card-meta">
                  <span className="txn-card-date">
                    <button
                      style={inlineStyles.merchantBtn}
                      onClick={() => toggleDetail(txn.dateTransactionId)}
                    >
                      {fmtDate(txn.date)}
                      {detailId === txn.dateTransactionId ? ' ▲' : ' ▼'}
                    </button>
                  </span>
                  <span className="txn-card-status">{txn.pending ? 'Pending' : 'Posted'}</span>
                  {txn.referenceUrl && (
                    <a href={txn.referenceUrl} target="_blank" rel="noreferrer" style={inlineStyles.refLink} title={txn.referenceNote || txn.referenceUrl}>🔗</a>
                  )}
                </div>
                <div className="txn-card-cat">
                  {txn.pending ? null : txn.splits && txn.splits.length > 0 ? (
                    <div className="split-summary-list">
                      {txn.splits.map((sp, i) => {
                        const cat = categories.find(c => c.categoryId === sp.customCategory);
                        return (
                          <div key={i} className="split-summary-item">
                            <span>{cat ? cat.name : 'Uncategorized'}{sp.note ? ` — ${sp.note}` : ''}</span>
                            <span style={{ color: amtColor(txn) }}>{fmtCurrency(sp.amount)}</span>
                          </div>
                        );
                      })}
                    </div>
                  ) : txn.ignored ? (
                    <>
                      {txn.customCategory
                        ? <CatBadge catId={txn.customCategory} categories={categories} />
                        : <span style={{ fontSize: '0.8rem', color: '#a0aec0' }}>—</span>}
                      <div style={{ marginTop: '0.4rem', fontSize: '0.8rem', color: '#a0aec0' }}>
                        {txn.budgetId ? (budgets.find(b => b.budgetId === txn.budgetId)?.name ?? '—') : '—'}
                      </div>
                    </>
                  ) : (
                    <>
                      <CatSelect txn={txn} categories={categories} assigningId={assigningId} onAssign={assignCategory} />
                      <div style={{ marginTop: '0.4rem' }}>
                        <BudgetSelect txn={txn} budgets={budgets} incomeSources={incomeSources} assigningId={assigningBudgetId} onAssign={assignBudget} />
                      </div>
                    </>
                  )}
                </div>
                {/* Actions row on mobile */}
                 {!txn.pending && (
                   <div style={{ marginTop: '0.4rem', display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
                     {!txn.ignored && (
                       <button
                         className="split-badge"
                         onClick={() => setSplitEditorId(
                           splitEditorId === txn.dateTransactionId ? null : txn.dateTransactionId
                         )}
                       >
                         {txn.splits && txn.splits.length > 0 ? `⅔ Edit splits (${txn.splits.length})` : '⅔ Split'}
                       </button>
                     )}
                     {!txn.ignored && txn.amount < 0 && !txn.linkedOriginalId && !txn.customCategory && !txn.budgetId && (
                       <button
                         className="split-badge"
                         title="Link to original charge"
                         disabled={inlineLinking === txn.dateTransactionId}
                         onClick={() => handleInlineLinkRefund(txn)}
                       >
                         {inlineLinking === txn.dateTransactionId ? '…' : 'Link refund'}
                       </button>
                     )}
                     {txn.ignored && (
                       <button
                         style={{
                           background: '#fff', border: '1px solid #0d7a6b', borderRadius: 6,
                           padding: '0.3rem 0.75rem', cursor: ignoringId === txn.dateTransactionId ? 'default' : 'pointer',
                           fontSize: '0.8rem', color: '#0d7a6b', fontWeight: 600,
                           opacity: ignoringId === txn.dateTransactionId ? 0.6 : 1,
                         }}
                         disabled={ignoringId === txn.dateTransactionId}
                         onClick={() => handleToggleIgnored(txn, false)}
                       >
                         {ignoringId === txn.dateTransactionId ? '…' : 'Unignore'}
                       </button>
                     )}
                     {txn.transactionId.startsWith('manual-') && (
                       <>
                         <button style={{ ...inlineStyles.refEditBtn, fontSize: '0.85rem' }} title="Edit"
                           onClick={() => setAddTxnModal({ txn })}>✎ Edit</button>
                         <button style={{ ...inlineStyles.refEditBtn, color: '#e53e3e', fontSize: '0.85rem' }} title="Delete"
                           disabled={deletingId === txn.dateTransactionId}
                           onClick={() => handleDeleteManualTxn(txn)}>🗑 Delete</button>
                       </>
                     )}
                   </div>
                 )}
                 {txn.pending && (
                   <div style={{ marginTop: '0.4rem' }}>
                     <button style={{ ...inlineStyles.refEditBtn, color: '#e53e3e', fontSize: '0.85rem' }} title="Delete pending transaction"
                       disabled={deletingId === txn.dateTransactionId}
                       onClick={() => handleDeletePendingTxn(txn)}>🗑 Delete pending</button>
                   </div>
                 )}
                {splitEditorId === txn.dateTransactionId && (
                   <SplitEditor
                     txn={txn}
                     categories={categories}
                     budgets={budgets}
                     onClose={() => setSplitEditorId(null)}
                     onSaved={handleSplitSaved}
                   />
                )}
                 {detailId === txn.dateTransactionId && (
                   <TxnDetail
                     txn={txn}
                     accounts={accounts}
                     onPfcClick={label => setPfcModal({ txn, label })}
                     editingNoteId={editingNoteId}
                     noteDraft={noteDraft}
                     savingNote={savingNote}
                     onEditNote={t => { setEditingNoteId(t.dateTransactionId); setNoteDraft(t.note || ''); }}
                     onNoteChange={setNoteDraft}
                     onSaveNote={saveNote}
                     onCancelNote={() => setEditingNoteId(null)}
                     editingNameId={editingNameId}
                     nameDraft={nameDraft}
                     savingName={savingName}
                     onEditName={openNameEditor}
                     onNameChange={setNameDraft}
                     onSaveName={saveName}
                     onCancelName={() => setEditingNameId(null)}
                      onLinkRefund={txn.customCategory && txn.budgetId ? handleInlineLinkRefund : undefined}
                      linkingRefund={inlineLinking === txn.dateTransactionId}
                      onIgnore={handleToggleIgnored}
                      ignoringId={ignoringId}
                    />
                  )}
                  {/* Ref editor on mobile */}
                {!txn.pending && !txn.ignored && (
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
                      <div style={inlineStyles.refView}>
                        {txn.referenceUrl && (
                          <a href={txn.referenceUrl} target="_blank" rel="noreferrer" style={inlineStyles.refLink} title={txn.referenceNote || txn.referenceUrl}>🔗</a>
                        )}
                        <button style={{ ...inlineStyles.refEditBtn, fontSize: '0.8rem' }} onClick={() => openRefEditor(txn)}>
                          {txn.referenceUrl ? '✎ Edit reference' : '+ Add reference'}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* ── Pagination ── */}
          {visible.length > 0 && (() => {
            const rangeSize = 5;
            const half = Math.floor(rangeSize / 2);
            let rangeStart = Math.max(1, effectivePage - half);
            let rangeEnd = Math.min(totalPages, rangeStart + rangeSize - 1);
            if (rangeEnd - rangeStart < rangeSize - 1) rangeStart = Math.max(1, rangeEnd - rangeSize + 1);
            const pages = Array.from({ length: rangeEnd - rangeStart + 1 }, (_, i) => rangeStart + i);
            const btnBase: React.CSSProperties = {
              minWidth: '2rem', padding: '0.25rem 0.5rem', border: '1px solid #cbd5e0',
              borderRadius: '0.25rem', background: '#fff', cursor: 'pointer', fontSize: '0.85rem',
            };
            const btnDisabled: React.CSSProperties = { ...btnBase, color: '#a0aec0', cursor: 'default', background: '#f7fafc' };
            const btnActive: React.CSSProperties = { ...btnBase, background: '#2b6cb0', color: '#fff', borderColor: '#2b6cb0', fontWeight: 600 };
            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', justifyContent: 'center', padding: '0.75rem 0 0.25rem', flexWrap: 'wrap' }}>
                <button style={effectivePage === 1 ? btnDisabled : btnBase} disabled={effectivePage === 1} onClick={() => setTxnPage(1)} title="First page">{'<<'}</button>
                <button style={effectivePage === 1 ? btnDisabled : btnBase} disabled={effectivePage === 1} onClick={() => setTxnPage(p => Math.max(1, p - 1))} title="Previous page">{'<'}</button>
                {rangeStart > 1 && <span style={{ padding: '0 0.25rem', color: '#718096' }}>…</span>}
                {pages.map(p => (
                  <button key={p} style={p === effectivePage ? btnActive : btnBase} onClick={() => setTxnPage(p)}>{p}</button>
                ))}
                {rangeEnd < totalPages && <span style={{ padding: '0 0.25rem', color: '#718096' }}>…</span>}
                <button style={effectivePage === totalPages ? btnDisabled : btnBase} disabled={effectivePage === totalPages} onClick={() => setTxnPage(p => Math.min(totalPages, p + 1))} title="Next page">{'>'}</button>
                <button style={effectivePage === totalPages ? btnDisabled : btnBase} disabled={effectivePage === totalPages} onClick={() => setTxnPage(totalPages)} title="Last page">{'>>'}</button>
                <select
                  value={txnPageSize}
                  onChange={e => { setTxnPageSize(Number(e.target.value)); setTxnPage(1); }}
                  style={{ marginLeft: '0.5rem', fontSize: '0.85rem', padding: '0.25rem 0.4rem', border: '1px solid #cbd5e0', borderRadius: '0.25rem' }}
                  title="Rows per page"
                >
                  {[10, 25, 50, 100].map(n => <option key={n} value={n}>{n} / page</option>)}
                </select>
                <span style={{ marginLeft: '0.25rem', fontSize: '0.8rem', color: '#718096' }}>
                  {(effectivePage - 1) * txnPageSize + 1}–{Math.min(effectivePage * txnPageSize, visible.length)} of {visible.length}
                </span>
              </div>
            );
          })()}
        </>
      )}

      {!loading && accounts.length > 0 && selectedAccounts.size === 0 && (
        <div style={inlineStyles.empty}>
          The account filter is hiding all transactions.{' '}
          <button style={inlineStyles.linkBtn} onClick={() => setFilterAccountsOpen(true)}>
            Click here to adjust the filter.
          </button>
        </div>
      )}
      {!loading && visible.length === 0 && selectedAccounts.size > 0 && accounts.length > 0 && (
        <div style={inlineStyles.empty}>
          {showUncatUnbudgetedOnly ? 'No uncategorized & unbudgeted transactions for this period.' : 'No transactions found for this period.'}
        </div>
      )}

      {/* ── Linked transaction nav modal ── */}
      {linkedNavModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setLinkedNavModal(null)}>
          <div style={{ background: '#fff', borderRadius: '0.75rem', padding: '1.5rem', maxWidth: 460, width: '90%', boxShadow: '0 10px 40px rgba(0,0,0,0.2)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <div style={{ fontSize: '1rem', fontWeight: 600 }}>
                {linkedNavModal.direction === 'refund' ? '↩ Refund credit' : 'Original charge'}
                {linkedNavModal.direction === 'refund' && linkedNavModal.allTxns.length > 1 && (
                  <span style={{ fontWeight: 400, color: '#718096', fontSize: '0.85rem', marginLeft: '0.5rem' }}>({linkedNavModal.allTxns.length} refunds)</span>
                )}
              </div>
              <button style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.1rem', color: '#718096', lineHeight: 1 }} onClick={() => setLinkedNavModal(null)}>✕</button>
            </div>
            {linkedNavModal.loading && (
              <div style={{ color: '#718096', fontSize: '0.9rem', padding: '1rem 0' }}>Loading...</div>
            )}
            {!linkedNavModal.loading && linkedNavModal.allTxns.length === 0 && (
              <div style={{ color: '#e53e3e', fontSize: '0.9rem' }}>Transaction not found.</div>
            )}
            {!linkedNavModal.loading && linkedNavModal.allTxns.length > 0 && (() => {
              const t = linkedNavModal.allTxns.find(x => x.dateTransactionId === linkedNavModal.selectedDtid) ?? linkedNavModal.allTxns[0];
              const acct = accounts.find(a => a.accountId === t.accountId);
              const cat = categories.find(c => c.categoryId === t.customCategory);
              const bud = budgets.find(b => b.budgetId === t.budgetId);
              const isCredit = t.amount < 0;
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {linkedNavModal.allTxns.length > 1 && (
                    <select
                      value={linkedNavModal.selectedDtid}
                      onChange={e => setLinkedNavModal(prev => prev ? { ...prev, selectedDtid: e.target.value } : null)}
                      style={{ marginBottom: '0.5rem', padding: '0.3rem 0.5rem', borderRadius: '0.35rem', border: '1px solid #cbd5e0', fontSize: '0.875rem' }}
                    >
                      {linkedNavModal.allTxns.map(x => (
                        <option key={x.dateTransactionId} value={x.dateTransactionId}>
                          {fmtDate(x.date)} — {isCredit ? '+' : ''}{fmtCurrency(Math.abs(x.amount))}
                        </option>
                      ))}
                    </select>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <div style={{ fontWeight: 600, fontSize: '1rem' }}>{t.customName || t.merchantName || t.name}</div>
                    <div style={{ fontWeight: 700, fontSize: '1.1rem', color: isCredit ? '#2f855a' : '#1a202c' }}>
                      {isCredit ? '+' : ''}{fmtCurrency(Math.abs(t.amount))}
                    </div>
                  </div>
                  <div style={{ color: '#718096', fontSize: '0.85rem' }}>{fmtDate(t.date)}</div>
                  <div style={{ borderTop: '1px solid #edf2f7', paddingTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.85rem', color: '#4a5568' }}>
                    {acct && <div><span style={{ color: '#a0aec0' }}>Account: </span>{acct.name}</div>}
                    {cat && <div><span style={{ color: '#a0aec0' }}>Category: </span>{cat.name}</div>}
                    {bud && <div><span style={{ color: '#a0aec0' }}>Budget: </span>{bud.name}</div>}
                    {t.referenceUrl && <div><span style={{ color: '#a0aec0' }}>Reference: </span><a href={t.referenceUrl} target="_blank" rel="noreferrer" style={{ color: '#2b6cb0' }}>{t.referenceNote || t.referenceUrl}</a></div>}
                  </div>
                </div>
              );
            })()}
            <div style={{ marginTop: '1.25rem', display: 'flex', justifyContent: 'flex-end' }}>
              <button
                style={{ padding: '0.4rem 0.9rem', borderRadius: '0.4rem', border: '1px solid #cbd5e0', background: '#fff', cursor: 'pointer', fontSize: '0.875rem' }}
                onClick={() => setLinkedNavModal(null)}
              >Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ── App root ──────────────────────────────────────────────────────────────────
const AppInner: React.FC = () => {
  const { idToken, loading: authLoading } = useAuth();

  if (authLoading) return <div style={{ textAlign: 'center', marginTop: '4rem', color: '#718096' }}>Loading...</div>;
  if (!idToken) return <LoginPage />;

  return (
    <>
      <Nav />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<TransactionsPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/categories" element={<CategoriesPage />} />
          <Route path="/budgets" element={<BudgetsPage />} />
          <Route path="/budgets/:budgetId" element={<BudgetPeriodPage />} />
          <Route path="/rules" element={<RulesPage />} />
          <Route path="/income" element={<IncomePage />} />
          <Route path="/master-budget" element={<MasterBudgetPage />} />
          <Route path="/import" element={<ImportPage />} />
        </Routes>
      </main>
    </>
  );
};

const App: React.FC = () => (
  <BrowserRouter>
    <AuthProvider>
      <DataProvider>
        <DirtyGuardProvider>
          <AppInner />
        </DirtyGuardProvider>
      </DataProvider>
    </AuthProvider>
  </BrowserRouter>
);

export default App;

// ── Inline styles (non-responsive, color/sizing only) ─────────────────────────
const txnToggleStyles = {
  track: (on: boolean): React.CSSProperties => ({
    display: 'inline-block', width: 36, height: 20, borderRadius: 10,
    background: on ? '#0d7a6b' : '#cbd5e0', position: 'relative',
    flexShrink: 0, transition: 'background 0.2s', cursor: 'pointer',
  }),
  thumb: (on: boolean): React.CSSProperties => ({
    position: 'absolute', top: 3, left: on ? 19 : 3,
    width: 14, height: 14, borderRadius: '50%', background: '#fff',
    boxShadow: '0 1px 3px rgba(0,0,0,0.2)', transition: 'left 0.2s',
  }),
};

const inlineStyles: Record<string, React.CSSProperties> = {
  btn: { background: '#0d7a6b', color: '#fff', border: 'none', borderRadius: 6, padding: '0.4rem 1rem', cursor: 'pointer', fontSize: '0.875rem', whiteSpace: 'nowrap' },
  logoutBtn: { background: 'none', color: '#0d7a6b', border: '1px solid #0d7a6b', borderRadius: 6, padding: '0.4rem 0.75rem', cursor: 'pointer', fontSize: '0.875rem', whiteSpace: 'nowrap' },
  accountChips: { display: 'flex', gap: '0.4rem', flexWrap: 'wrap' },
  chip: { background: '#edf2f7', border: 'none', borderRadius: 20, padding: '0.4rem 0.85rem', cursor: 'pointer', fontSize: '0.875rem', minHeight: 36 },
  chipActive: { background: '#0d7a6b', color: '#fff', border: 'none', borderRadius: 20, padding: '0.4rem 0.85rem', cursor: 'pointer', fontSize: '0.875rem', minHeight: 36 },
  checkLabel: { fontSize: '0.875rem', color: '#4a5568', display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', whiteSpace: 'nowrap' },
  monthPicker: {},
  sortableTh: { cursor: 'pointer', userSelect: 'none' } as React.CSSProperties,
  applyBtn: { background: 'none', color: '#0d7a6b', border: '1px solid #0d7a6b', borderRadius: 6, padding: '0.4rem 0.75rem', cursor: 'pointer', fontSize: '0.875rem', whiteSpace: 'nowrap' },
  syncBtn: { background: '#fef9e7', color: '#856a00', border: '1px solid #fde68a', borderRadius: 6, padding: '0.4rem 0.75rem', cursor: 'pointer', fontSize: '0.875rem', whiteSpace: 'nowrap' },
  linkBtn: { background: 'none', border: 'none', color: '#0d7a6b', cursor: 'pointer', fontSize: 'inherit', padding: 0, textDecoration: 'underline' },
  catCell: { display: 'flex', alignItems: 'center', gap: '0.5rem' },
  catSelect: { maxWidth: 160, minHeight: 36 },
  catBadge: { color: '#fff', borderRadius: 12, padding: '0.15rem 0.6rem', fontSize: '0.75rem', whiteSpace: 'nowrap' },
  empty: { textAlign: 'center', color: '#718096', marginTop: '3rem' },
  error: { background: '#fff5f5', color: '#c53030', border: '1px solid #feb2b2', borderRadius: 6, padding: '0.75rem 1rem', marginBottom: '1rem' },
  success: { background: '#f0fff4', color: '#276749', border: '1px solid #9ae6b4', borderRadius: 6, padding: '0.75rem 1rem', marginBottom: '1rem' },
  refView: { display: 'flex', alignItems: 'center', gap: '0.3rem' },
  refLink: { textDecoration: 'none', fontSize: '0.9rem' },
  refEditBtn: { background: 'none', border: 'none', cursor: 'pointer', color: '#718096', fontSize: '0.85rem', padding: '0 0.2rem' },
  refEditor: { display: 'flex', alignItems: 'center', gap: '0.3rem', flexWrap: 'wrap' },
  refInput: { border: '1px solid #cbd5e0', borderRadius: 4, padding: '0.2rem 0.4rem', fontSize: '0.75rem', width: 130 },
  refSaveBtn: { background: '#0d7a6b', color: '#fff', border: 'none', borderRadius: 4, padding: '0.35rem 0.6rem', cursor: 'pointer', fontSize: '0.8rem' },
  refCancelBtn: { background: 'none', border: 'none', cursor: 'pointer', color: '#718096', fontSize: '0.85rem' },
  merchantBtn: { background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#2d3748', fontSize: 'inherit', textAlign: 'left', fontFamily: 'inherit' },
  origName:   { color: '#9ca3af', fontSize: '0.78rem' },
  nickBtn:    { background: 'none', border: 'none', cursor: 'pointer', color: '#0d7a6b', padding: '0 2px', fontSize: '0.85rem', lineHeight: 1 },
  nickInput:  { fontSize: '0.9rem', padding: '0.15rem 0.4rem', border: '1px solid #0d7a6b', borderRadius: 4, minWidth: 120, outline: 'none' },
};

const navBlockStyles: Record<string, React.CSSProperties> = {
  overlay:    { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' },
  dialog:     { background: '#fff', borderRadius: 12, padding: '1.5rem', maxWidth: 420, width: '100%', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' },
  title:      { margin: '0 0 0.75rem', fontSize: '1.05rem', fontWeight: 600, color: '#1a202c' },
  body:       { margin: '0 0 1.25rem', fontSize: '0.9rem', color: '#4a5568', lineHeight: 1.5 },
  footer:     { display: 'flex', gap: '0.6rem', justifyContent: 'flex-end' },
  discardBtn: { background: 'transparent', color: '#dc2626', border: '1px solid #dc2626', borderRadius: 6, padding: '0.4rem 0.9rem', cursor: 'pointer', fontSize: '0.875rem' },
  stayBtn:    { background: '#0d7a6b', color: '#fff', border: 'none', borderRadius: 6, padding: '0.4rem 0.9rem', cursor: 'pointer', fontSize: '0.875rem' },
};

import React, { useEffect, useState, useCallback } from 'react';
import { BrowserRouter, Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom';
import { DirtyGuardProvider, useDirtyGuard } from './auth/DirtyGuardContext';
import {
  Account, Category, Rule, Transaction, Budget, IncomeSource,
  getTransactions, putTransaction, deleteTransaction,
  updateTransactionCategory, updateTransactionBudget, updateTransactionReference, applyRules, syncTransactions,
  putCategory, putRule,
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
import { INCOME_CATEGORY_ID } from './api/client';

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

  const merchantName = txn.merchantName || txn.name;

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
}> = ({ txn, accounts, onPfcClick }) => {
  const acct = accounts.find(a => a.accountId === txn.accountId);
  const acctLabel = acct ? `${acct.institution} — ${acct.name}` : txn.accountId;

  const hasPrimary  = !!txn.personalFinancePrimary;
  const hasDetailed = !!txn.personalFinanceDetailed && txn.personalFinanceDetailed !== txn.personalFinancePrimary;
  const fmtPfcStr = (s: string) => toTitleCase(s);

  return (
    <div style={detailStyles.wrap}>
      <div style={detailStyles.grid}>
        <DetailRow label="Account"              value={acctLabel} />
        <DetailRow label="Original Description" value={txn.originalDescription} />
        <DetailRow label="Authorized Date"      value={fmtDate(txn.authorizedDate)} />
        <DetailRow label="Payment Channel"      value={fmtChannel(txn.paymentChannel)} />

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
  wrap:   { background: '#f7f8fc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '0.75rem 1rem', marginTop: 2 },
  grid:   { display: 'flex', flexDirection: 'column', gap: '0.4rem' },
  row:    { display: 'flex', gap: '0.75rem', alignItems: 'baseline', fontSize: '0.82rem' },
  label:  { color: '#718096', minWidth: 180, flexShrink: 0, fontWeight: 500 },
  value:  { color: '#2d3748' },
  logo:   { height: 28, borderRadius: 4 },
  pfcBtn: { background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#0d7a6b', fontSize: 'inherit', fontFamily: 'inherit', textDecoration: 'underline', textDecorationStyle: 'dotted' },
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
                        <span style={acctFilterStyles.leafName}>{a.name}</span>
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
            {accounts.map(a => <option key={a.accountId} value={a.accountId}>{a.institution} — {a.name}</option>)}
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
          txnRange, setTxnRange, txnSortKey, setTxnSortKey, txnSortDir, setTxnSortDir } = useData();
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
  const [showUncategorizedOnly, setShowUncategorizedOnly] = useState(false);
  const [applyingRules, setApplyingRules] = useState(false);
  const [applyMsg, setApplyMsg] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [editingRefId, setEditingRefId] = useState<string | null>(null);
  const [refUrl, setRefUrl] = useState('');
  const [refNote, setRefNote] = useState('');
  const [savingRef, setSavingRef] = useState(false);
  const [splitEditorId, setSplitEditorId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [pfcModal, setPfcModal] = useState<{ txn: Transaction; label: string } | null>(null);
  const [addTxnModal, setAddTxnModal] = useState<{ txn?: Transaction } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [incomeModal, setIncomeModal] = useState<Transaction | null>(null);

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

  const handlePfcDone = (updatedTxn: Transaction, newCategory?: Category, newRule?: Rule) => {
    setTransactions(prev => prev.map(t =>
      t.dateTransactionId === updatedTxn.dateTransactionId ? updatedTxn : t
    ));
    if (newCategory) setCategories(prev => [...prev, newCategory]);
    if (newRule)     setRules(prev => [...prev, newRule]);
    setPfcModal(null);
  };

  const amtColor = (txn: Transaction) => txn.amount > 0 ? '#e53e3e' : '#38a169';
  const amtStr = (txn: Transaction) => `${txn.amount > 0 ? '-' : '+'}${fmtCurrency(txn.amount)}`;

  const toggleSort = (key: typeof txnSortKey) => {
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
    .filter(t => !showUncategorizedOnly || !t.customCategory);
  const visible = [...filtered].sort((a, b) => {
    let cmp = 0;
    if (txnSortKey === 'date')     cmp = a.date.localeCompare(b.date);
    else if (txnSortKey === 'merchant') cmp = (a.merchantName || a.name).localeCompare(b.merchantName || b.name);
    else if (txnSortKey === 'amount')   cmp = a.amount - b.amount;
    return txnSortDir === 'asc' ? cmp : -cmp;
  });

  return (
    <div className="page">
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
            onChange={setSelectedAccounts}
            isOpen={filterAccountsOpen}
            onOpen={() => setFilterAccountsOpen(true)}
            onClose={() => setFilterAccountsOpen(false)}
          />
          <select
            value={txnRange}
            onChange={e => setTxnRange(e.target.value as typeof txnRange)}
            style={inlineStyles.monthPicker}
          >
            {RANGE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <label style={inlineStyles.checkLabel} onClick={() => setShowUncategorizedOnly(v => !v)}>
            <span style={txnToggleStyles.track(showUncategorizedOnly)}>
              <span style={txnToggleStyles.thumb(showUncategorizedOnly)} />
            </span>
            Uncategorized only
          </label>
        </div>
        <div className="filter-right">
          <button style={inlineStyles.applyBtn} onClick={handleApplyRules} disabled={applyingRules}
            title="Re-run all auto-assignment rules on this month's transactions">
            {applyingRules ? 'Applying...' : 'Re-apply Rules'}
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
                <th>Status</th><th>Ref</th><th>Split</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(txn => (
                <React.Fragment key={txn.dateTransactionId}>
                  <tr>
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
                      {txn.merchantName || txn.name}
                    </td>
                    <td>
                      <div style={inlineStyles.catCell}>
                        {txn.splits && txn.splits.length > 0 ? (
                          <span style={{ fontSize: '0.8rem', color: '#718096', fontStyle: 'italic' }}>
                            {txn.splits.length} splits
                          </span>
                        ) : (
                          <>
                            <CatSelect txn={txn} categories={categories} assigningId={assigningId} onAssign={assignCategory} />
                          </>
                        )}
                      </div>
                    </td>
                    <td>
                      <div style={inlineStyles.catCell}>
                        {txn.splits && txn.splits.length > 0 ? (
                          <span style={{ fontSize: '0.8rem', color: '#718096', fontStyle: 'italic' }}>per split</span>
                        ) : (
                          <BudgetSelect txn={txn} budgets={budgets} incomeSources={incomeSources} assigningId={assigningBudgetId} onAssign={assignBudget} />
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
                       {txn.transactionId.startsWith('manual-') && (
                         <>
                           <button style={inlineStyles.refEditBtn} title="Edit transaction"
                             onClick={() => setAddTxnModal({ txn })}>✎</button>
                           <button style={{ ...inlineStyles.refEditBtn, color: '#e53e3e' }} title="Delete transaction"
                             disabled={deletingId === txn.dateTransactionId}
                             onClick={() => handleDeleteManualTxn(txn)}>🗑</button>
                         </>
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
                  <span className="txn-card-merchant">
                    {txn.merchantName || txn.name}
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
                  {txn.splits && txn.splits.length > 0 ? (
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
                  ) : (
                    <>
                      <CatSelect txn={txn} categories={categories} assigningId={assigningId} onAssign={assignCategory} />
                      <div style={{ marginTop: '0.4rem' }}>
                        <BudgetSelect txn={txn} budgets={budgets} incomeSources={incomeSources} assigningId={assigningBudgetId} onAssign={assignBudget} />
                      </div>
                    </>
                  )}
                </div>
                {/* Split button on mobile */}
                <div style={{ marginTop: '0.4rem', display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <button
                    className="split-badge"
                    onClick={() => setSplitEditorId(
                      splitEditorId === txn.dateTransactionId ? null : txn.dateTransactionId
                    )}
                  >
                    {txn.splits && txn.splits.length > 0 ? `⅔ Edit splits (${txn.splits.length})` : '⅔ Split'}
                  </button>
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
          {showUncategorizedOnly ? 'No uncategorized transactions for this period.' : 'No transactions found for this period.'}
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

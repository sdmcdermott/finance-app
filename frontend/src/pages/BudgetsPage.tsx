import React, { useState } from 'react';import { useNavigate } from 'react-router-dom';
import { Budget, putBudget, deleteBudget } from '../api/client';
import { useData } from '../auth/DataContext';

const PERIODS = ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'annually'] as const;
const DEFAULT_FORMATS: Record<string, string> = {
  daily: '{name} - {mon} {dd} {yyyy}',
  weekly: '{name} - W{wk} {mon} {yyyy}',
  biweekly: '{name} - W{wk} {mon} {yyyy}',
  monthly: '{name} - {mon} {yyyy}',
  quarterly: '{name} - {q} {yyyy}',
  annually: '{name} - {yyyy}',
};

const emptyForm = (): Omit<Budget, 'userId'> => ({
  budgetId: '',
  name: '',
  budgetType: 'goal',
  period: 'monthly',
  periodFormat: DEFAULT_FORMATS['monthly'],
  goalAmount: 0,
  goalDirection: 'limit',
  surplusHandling: 'ignore',
  transferBudgetId: '',
  transferAmount: 0,
  openingBalance: 0,
});

const BudgetsPage: React.FC = () => {
  const navigate = useNavigate();
  const { budgets, setBudgets, loading } = useData();
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Omit<Budget, 'userId'>>(emptyForm());
  const [saving, setSaving] = useState(false);

  const openNew = () => {
    setForm(emptyForm());
    setEditingId('new');
  };

  const openEdit = (b: Budget) => {
    setForm({ ...b });
    setEditingId(b.budgetId);
  };

  const cancel = () => setEditingId(null);

  const setField = <K extends keyof typeof form>(k: K, v: typeof form[K]) => {
    setForm((prev) => {
      const next = { ...prev, [k]: v };
      if (k === 'period' && prev.periodFormat === DEFAULT_FORMATS[prev.period]) {
        next.periodFormat = DEFAULT_FORMATS[v as string] ?? DEFAULT_FORMATS['monthly'];
      }
      return next;
    });
  };

  const save = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await putBudget(form);
      setBudgets((prev) => {
        const idx = prev.findIndex((b) => b.budgetId === saved.budgetId);
        return idx >= 0 ? prev.map((b) => b.budgetId === saved.budgetId ? saved : b) : [...prev, saved];
      });
      setEditingId(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (b: Budget) => {
    if (!window.confirm(`Delete budget "${b.name}"? All period history will be lost.`)) return;
    try {
      await deleteBudget(b.budgetId);
      setBudgets((prev) => prev.filter((x) => x.budgetId !== b.budgetId));
    } catch (e: any) {
      setError(e.message);
    }
  };

  const checkbookBudgets = budgets.filter((b) => b.budgetType === 'checkbook');

  const formFields = (
    <>
      <div className="form-row">
        <label style={s.label}>Name</label>
        <input style={s.input} value={form.name} onChange={(e) => setField('name', e.target.value)} placeholder="e.g. Monthly Spending" />
      </div>
      <div className="form-row">
        <label style={s.label}>Type</label>
        <div style={s.radioGroup}>
          {(['goal', 'checkbook'] as const).map((t) => (
            <label key={t} style={s.radioLabel}>
              <input type="radio" name="budgetType" value={t} checked={form.budgetType === t} onChange={() => setField('budgetType', t)} style={{ marginRight: 4 }} />
              {t === 'goal' ? 'Goal (track debits toward a target)' : 'Checkbook (track running balance)'}
            </label>
          ))}
        </div>
      </div>
      <div className="form-row">
        <label style={s.label}>Period</label>
        <select style={s.select} value={form.period} onChange={(e) => setField('period', e.target.value as Budget['period'])}>
          {PERIODS.map((p) => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
        </select>
      </div>
      <div className="form-row">
        <label style={s.label}>
          Period Label Format
          <span style={s.hint}> — tokens: {'{name}'}, {'{yyyy}'}, {'{yy}'}, {'{mon}'}, {'{month}'}, {'{dd}'}, {'{wk}'}, {'{q}'}</span>
        </label>
        <input style={s.input} value={form.periodFormat} onChange={(e) => setField('periodFormat', e.target.value)} />
      </div>
      {form.budgetType === 'goal' && (
        <>
          <div className="form-row">
            <label style={s.label}>Goal Amount ($)</label>
            <input style={{ ...s.input, maxWidth: 160 }} type="number" min="0" step="0.01" value={form.goalAmount || ''} onChange={(e) => setField('goalAmount', parseFloat(e.target.value) || 0)} placeholder="0.00" />
          </div>
          <div className="form-row">
            <label style={s.label}>Goal Direction</label>
            <div style={s.radioGroup}>
              <label style={s.radioLabel}>
                <input type="radio" name="goalDir" value="limit" checked={form.goalDirection === 'limit'} onChange={() => setField('goalDirection', 'limit')} style={{ marginRight: 4 }} />
                Spending limit (stay under)
              </label>
              <label style={s.radioLabel}>
                <input type="radio" name="goalDir" value="target" checked={form.goalDirection === 'target'} onChange={() => setField('goalDirection', 'target')} style={{ marginRight: 4 }} />
                Savings target (reach it)
              </label>
            </div>
          </div>
        </>
      )}
      {form.budgetType === 'checkbook' && (
        <div className="form-row">
          <label style={s.label}>Opening Balance ($)</label>
          <input style={{ ...s.input, maxWidth: 160 }} type="number" step="0.01" value={form.openingBalance || ''} onChange={(e) => setField('openingBalance', parseFloat(e.target.value) || 0)} placeholder="0.00" />
        </div>
      )}
      <div className="form-row">
        <label style={s.label}>At period end, surplus/shortfall should</label>
        <select style={s.select} value={form.surplusHandling} onChange={(e) => setField('surplusHandling', e.target.value as Budget['surplusHandling'])}>
          <option value="ignore">Be ignored (start fresh)</option>
          <option value="rollover">Roll over to the next period</option>
          <option value="transfer">Transfer to another budget</option>
        </select>
      </div>
      {form.surplusHandling === 'transfer' && (
        <>
          <div className="form-row">
            <label style={s.label}>Destination Budget (checkbook only)</label>
            <select style={s.select} value={form.transferBudgetId} onChange={(e) => setField('transferBudgetId', e.target.value)}>
              <option value="">— Select —</option>
              {checkbookBudgets.filter((b) => b.budgetId !== editingId).map((b) => (
                <option key={b.budgetId} value={b.budgetId}>{b.name}</option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label style={s.label}>Transfer Amount ($) — leave 0 to transfer full delta</label>
            <input style={{ ...s.input, maxWidth: 160 }} type="number" min="0" step="0.01" value={form.transferAmount || ''} onChange={(e) => setField('transferAmount', parseFloat(e.target.value) || 0)} placeholder="0.00" />
          </div>
        </>
      )}
      <div className="form-actions">
        <button style={s.secondaryBtn} onClick={cancel} disabled={saving}>Cancel</button>
        <button style={s.primaryBtn} onClick={save} disabled={saving || !form.name.trim()}>
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </>
  );

  return (
    <div className="page">
      <div className="page-header">
        <h2 style={s.title}>Budgets</h2>
        {editingId !== 'new' && (
          <button style={s.primaryBtn} onClick={openNew}>+ New Budget</button>
        )}
      </div>

      {error && <div style={s.error}>{error}</div>}

      {editingId === 'new' && (
        <div className="form-card">
          <h3 style={s.formTitle}>New Budget</h3>
          {formFields}
        </div>
      )}

      {loading ? (
        <div style={s.empty}>Loading...</div>
      ) : budgets.length === 0 ? (
        <div style={s.empty}>No budgets yet. Create one to start tracking spending periods.</div>
      ) : (
        <div className="table-wrap">
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>Name</th>
              <th style={s.th}>Type</th>
              <th style={s.th}>Period</th>
              <th style={s.th}></th>
            </tr>
          </thead>
          <tbody>
            {budgets.map((b) => {
              const isEditing = editingId === b.budgetId;
              return (
                <React.Fragment key={b.budgetId}>
                  <tr style={s.tr}>
                    <td style={s.td}>
                      <button style={s.nameBtn} onClick={() => navigate(`/budgets/${b.budgetId}`)}>{b.name}</button>
                    </td>
                    <td style={s.td}><span style={b.budgetType === 'goal' ? s.badgeGoal : s.badgeCheck}>{b.budgetType}</span></td>
                    <td style={s.td}>{b.period}</td>
                    <td style={{ ...s.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {isEditing ? (
                        <button style={s.linkBtn} onClick={cancel}>Cancel</button>
                      ) : (
                        <>
                          <button style={s.linkBtn} onClick={() => navigate(`/budgets/${b.budgetId}`)}>View</button>
                          <button style={{ ...s.linkBtn, marginLeft: 8 }} onClick={() => openEdit(b)}>Edit</button>
                          <button style={{ ...s.linkBtn, color: '#e53e3e', marginLeft: 8 }} onClick={() => remove(b)}>Delete</button>
                        </>
                      )}
                    </td>
                  </tr>
                  {isEditing && (
                    <tr>
                      <td colSpan={4} style={s.expandCell}>
                        <div className="form-card" style={{ margin: 0 }}>
                          {formFields}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
};

const s: Record<string, React.CSSProperties> = {
  title: { margin: 0, fontSize: '1.1rem', fontWeight: 600 },
  primaryBtn: { background: '#0d7a6b', color: '#fff', border: 'none', borderRadius: 6, padding: '0.45rem 1rem', cursor: 'pointer', fontSize: '0.875rem', whiteSpace: 'nowrap' },
  secondaryBtn: { background: 'none', color: '#0d7a6b', border: '1px solid #0d7a6b', borderRadius: 6, padding: '0.45rem 1rem', cursor: 'pointer', fontSize: '0.875rem' },
  linkBtn: { background: 'none', border: 'none', color: '#0d7a6b', cursor: 'pointer', fontSize: '0.875rem', padding: 0 },
  nameBtn: { background: 'none', border: 'none', color: '#0d7a6b', cursor: 'pointer', fontSize: '0.875rem', padding: 0, fontWeight: 600, textDecoration: 'underline' },
  formTitle: { margin: '0 0 1rem', fontSize: '0.95rem', fontWeight: 600 },
  label: { display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#4a5568', marginBottom: '0.3rem' },
  hint: { fontWeight: 400, color: '#718096', fontSize: '0.75rem' },
  input: { width: '100%', boxSizing: 'border-box' as const, border: '1px solid #cbd5e0', borderRadius: 6, padding: '0.4rem 0.6rem', fontSize: '0.9rem' },
  select: { width: '100%' },
  radioGroup: { display: 'flex', flexDirection: 'column' as const, gap: '0.4rem' },
  radioLabel: { fontSize: '0.875rem', color: '#2d3748', cursor: 'pointer', display: 'flex', alignItems: 'center' },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '0.9rem' },
  th: { textAlign: 'left' as const, padding: '0.6rem 0.75rem', background: '#f7fafc', borderBottom: '2px solid #e2e8f0', fontWeight: 600, color: '#4a5568' },
  tr: { borderBottom: '1px solid #e2e8f0' },
  td: { padding: '0.65rem 0.75rem', color: '#2d3748', verticalAlign: 'middle' as const },
  badgeGoal: { background: '#fef9e7', color: '#856a00', borderRadius: 12, padding: '0.1rem 0.5rem', fontSize: '0.78rem', fontWeight: 600 },
  badgeCheck: { background: '#f0fff4', color: '#276749', borderRadius: 12, padding: '0.1rem 0.5rem', fontSize: '0.78rem', fontWeight: 600 },
  empty: { textAlign: 'center' as const, color: '#718096', marginTop: '2rem' },
  error: { background: '#fff5f5', color: '#c53030', border: '1px solid #feb2b2', borderRadius: 6, padding: '0.75rem 1rem', marginBottom: '1rem' },
  expandCell: { padding: 0, background: '#f7fafc', borderBottom: '2px solid #cbd5e0' },
};

export default BudgetsPage;

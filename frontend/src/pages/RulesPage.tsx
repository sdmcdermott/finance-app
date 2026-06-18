import React, { useState } from 'react';
import { Rule, putRule, deleteRule, Category, Budget, MASTER_BUDGET_ID } from '../api/client';
import { useData } from '../auth/DataContext';
import { fmtCurrency } from '../utils/dates';

// ── Shared form fields ────────────────────────────────────────────────────────
interface RuleFormProps {
  categories: Category[];
  budgets: Budget[];
  formPattern: string; setFormPattern: (v: string) => void;
  formCategoryId: string; setFormCategoryId: (v: string) => void;
  formBudgetId: string; setFormBudgetId: (v: string) => void;
  formPriority: string; setFormPriority: (v: string) => void;
  useAmount: boolean; setUseAmount: (v: boolean) => void;
  formAmount: string; setFormAmount: (v: string) => void;
  formAmountTol: string; setFormAmountTol: (v: string) => void;
  useDay: boolean; setUseDay: (v: boolean) => void;
  formDay: string; setFormDay: (v: string) => void;
  formDayTol: string; setFormDayTol: (v: string) => void;
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
}

const RuleForm: React.FC<RuleFormProps> = ({
  categories, budgets,
  formPattern, setFormPattern,
  formCategoryId, setFormCategoryId,
  formBudgetId, setFormBudgetId,
  formPriority, setFormPriority,
  useAmount, setUseAmount, formAmount, setFormAmount, formAmountTol, setFormAmountTol,
  useDay, setUseDay, formDay, setFormDay, formDayTol, setFormDayTol,
  saving, onCancel, onSave,
}) => (
  <div style={{ paddingTop: '0.75rem' }}>
    <div className="form-row">
      <label style={styles.label}>Pattern (merchant name contains)</label>
      <input style={styles.input} value={formPattern} onChange={e => setFormPattern(e.target.value)} placeholder="e.g. whole foods" />
    </div>
    <div className="form-row">
      <label style={styles.label}>Assign to Category <span style={styles.optional}>(optional)</span></label>
      <select style={styles.select} value={formCategoryId} onChange={e => setFormCategoryId(e.target.value)}>
        <option value="">— None —</option>
        {categories.map(c => <option key={c.categoryId} value={c.categoryId}>{c.name}</option>)}
      </select>
    </div>
    <div className="form-row">
      <label style={styles.label}>Assign to Budget <span style={styles.optional}>(optional)</span></label>
      <select style={styles.select} value={formBudgetId} onChange={e => setFormBudgetId(e.target.value)}>
        <option value="">— None —</option>
        <option value={MASTER_BUDGET_ID}>⬡ Master Budget</option>
        {budgets.map(b => <option key={b.budgetId} value={b.budgetId}>{b.name}</option>)}
      </select>
    </div>
    <div className="form-row">
      <label style={styles.checkboxLabel}>
        <input type="checkbox" checked={useAmount} onChange={e => setUseAmount(e.target.checked)} style={{ marginRight: 6 }} />
        Match amount <span style={styles.optional}>(optional AND condition)</span>
      </label>
      {useAmount && (
        <div style={styles.inlineGroup}>
          <div style={styles.inlineField}>
            <span style={styles.inlineLabel}>Amount ($)</span>
            <input style={{ ...styles.input, maxWidth: 110 }} type="number" min="0.01" step="0.01" value={formAmount} onChange={e => setFormAmount(e.target.value)} placeholder="e.g. 49.99" />
          </div>
          <div style={styles.inlineField}>
            <span style={styles.inlineLabel}>Tolerance (±$)</span>
            <input style={{ ...styles.input, maxWidth: 110 }} type="number" min="0" step="0.01" value={formAmountTol} onChange={e => setFormAmountTol(e.target.value)} placeholder="0.00" />
          </div>
        </div>
      )}
    </div>
    <div className="form-row">
      <label style={styles.checkboxLabel}>
        <input type="checkbox" checked={useDay} onChange={e => setUseDay(e.target.checked)} style={{ marginRight: 6 }} />
        Match day of month <span style={styles.optional}>(optional AND condition)</span>
      </label>
      {useDay && (
        <div style={styles.inlineGroup}>
          <div style={styles.inlineField}>
            <span style={styles.inlineLabel}>Day (1–31)</span>
            <input style={{ ...styles.input, maxWidth: 80 }} type="number" min="1" max="31" value={formDay} onChange={e => setFormDay(e.target.value)} placeholder="e.g. 15" />
          </div>
          <div style={styles.inlineField}>
            <span style={styles.inlineLabel}>Tolerance (±days)</span>
            <input style={{ ...styles.input, maxWidth: 80 }} type="number" min="0" max="15" value={formDayTol} onChange={e => setFormDayTol(e.target.value)} placeholder="0" />
          </div>
        </div>
      )}
    </div>
    <div className="form-row">
      <label style={styles.label}>Priority (lower = applied first)</label>
      <input style={{ ...styles.input, maxWidth: 100 }} type="number" min="0" value={formPriority} onChange={e => setFormPriority(e.target.value)} />
    </div>
    <div className="form-actions">
      <button style={styles.secondaryBtn} onClick={onCancel} disabled={saving}>Cancel</button>
      <button style={styles.primaryBtn} onClick={onSave} disabled={saving || !formPattern.trim() || (!formCategoryId && !formBudgetId)}>
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  </div>
);

const RulesPage: React.FC = () => {
  const { rules, setRules, categories, budgets, loading } = useData();
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formPattern, setFormPattern] = useState('');
  const [formCategoryId, setFormCategoryId] = useState('');
  const [formBudgetId, setFormBudgetId] = useState('');
  const [formPriority, setFormPriority] = useState('10');

  // Optional amount filter
  const [useAmount, setUseAmount] = useState(false);
  const [formAmount, setFormAmount] = useState('');
  const [formAmountTol, setFormAmountTol] = useState('0');

  // Optional day-of-month filter
  const [useDay, setUseDay] = useState(false);
  const [formDay, setFormDay] = useState('');
  const [formDayTol, setFormDayTol] = useState('0');

  const [saving, setSaving] = useState(false);

  const resetForm = () => {
    setFormPattern('');
    setFormCategoryId('');
    setFormBudgetId('');
    setFormPriority('10');
    setUseAmount(false);
    setFormAmount('');
    setFormAmountTol('0');
    setUseDay(false);
    setFormDay('');
    setFormDayTol('0');
  };

  const openNew = () => {
    resetForm();
    setEditingId('new');
  };

  const openEdit = (rule: Rule) => {
    setEditingId(rule.ruleId);
    setFormPattern(rule.pattern);
    setFormCategoryId(rule.categoryId);
    setFormBudgetId(rule.budgetId);
    setFormPriority(String(rule.priority));

    const hasAmount = (rule.amountMatch ?? 0) > 0;
    setUseAmount(hasAmount);
    setFormAmount(hasAmount ? String(rule.amountMatch) : '');
    setFormAmountTol(hasAmount ? String(rule.amountTolerance ?? 0) : '0');

    const hasDay = (rule.dayOfMonth ?? 0) > 0;
    setUseDay(hasDay);
    setFormDay(hasDay ? String(rule.dayOfMonth) : '');
    setFormDayTol(hasDay ? String(rule.dayTolerance ?? 0) : '0');
  };

  const cancelEdit = () => { setEditingId(null); };

  const save = async () => {
    if (!formPattern.trim() || (!formCategoryId && !formBudgetId)) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await putRule({
        ruleId: editingId === 'new' ? '' : editingId!,
        pattern: formPattern.trim(),
        categoryId: formCategoryId,
        budgetId: formBudgetId,
        priority: parseInt(formPriority, 10) || 10,
        ...(useAmount && formAmount ? {
          amountMatch: parseFloat(formAmount),
          amountTolerance: parseFloat(formAmountTol) || 0,
        } : {}),
        ...(useDay && formDay ? {
          dayOfMonth: parseInt(formDay, 10),
          dayTolerance: parseInt(formDayTol, 10) || 0,
        } : {}),
      });
      setRules((prev) => {
        const idx = prev.findIndex((r) => r.ruleId === saved.ruleId);
        const next = idx >= 0
          ? prev.map((r) => r.ruleId === saved.ruleId ? saved : r)
          : [...prev, saved];
        return next.slice().sort((a, b) => a.priority - b.priority);
      });
      setEditingId(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (rule: Rule) => {
    const catName = categories.find((c) => c.categoryId === rule.categoryId)?.name;
    const budgetName = budgets.find((b) => b.budgetId === rule.budgetId)?.name;
    const assigns = [catName, budgetName].filter(Boolean).join(' + ') || rule.categoryId;
    if (!window.confirm(`Delete rule "${rule.pattern}" → ${assigns}?`)) return;
    try {
      await deleteRule(rule.ruleId);
      setRules((prev) => prev.filter((r) => r.ruleId !== rule.ruleId));
    } catch (e: any) {
      setError(e.message);
    }
  };

  const categoryName = (id: string) => categories.find((c) => c.categoryId === id)?.name ?? '—';
  const categoryColor = (id: string) => categories.find((c) => c.categoryId === id)?.color ?? '#cbd5e0';
  const budgetName = (id: string) => {
    if (id === MASTER_BUDGET_ID) return 'Master Budget';
    return budgets.find((b) => b.budgetId === id)?.name ?? '—';
  };
  const sortedRules = rules.slice().sort((a, b) => a.priority - b.priority);

  const ruleConditionSummary = (rule: Rule): string => {
    const parts: string[] = [];
    if ((rule.amountMatch ?? 0) > 0) {
      const tol = rule.amountTolerance ?? 0;
      parts.push(tol > 0
        ? `amount ${fmtCurrency(rule.amountMatch!)} ±${fmtCurrency(tol)}`
        : `amount = ${fmtCurrency(rule.amountMatch!)}`);
    }
    if ((rule.dayOfMonth ?? 0) > 0) {
      const tol = rule.dayTolerance ?? 0;
      parts.push(tol > 0
        ? `day ${rule.dayOfMonth} ±${tol}d`
        : `day ${rule.dayOfMonth}`);
    }
    return parts.join(', ');
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 style={styles.title}>Auto-Assignment Rules</h2>
          <p style={styles.subtitle}>
            Rules automatically assign a category and/or budget to transactions whose merchant name contains the pattern.
            Amount and day-of-month filters are optional AND conditions.
            Lower priority values run first. Manual assignments are never overridden.
          </p>
        </div>
        <button style={styles.primaryBtn} onClick={openNew}>+ New Rule</button>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {editingId === 'new' && (
        <div className="form-card">
          <h3 style={styles.formTitle}>New Rule</h3>
          <RuleForm
            categories={categories} budgets={budgets}
            formPattern={formPattern} setFormPattern={setFormPattern}
            formCategoryId={formCategoryId} setFormCategoryId={setFormCategoryId}
            formBudgetId={formBudgetId} setFormBudgetId={setFormBudgetId}
            formPriority={formPriority} setFormPriority={setFormPriority}
            useAmount={useAmount} setUseAmount={setUseAmount}
            formAmount={formAmount} setFormAmount={setFormAmount}
            formAmountTol={formAmountTol} setFormAmountTol={setFormAmountTol}
            useDay={useDay} setUseDay={setUseDay}
            formDay={formDay} setFormDay={setFormDay}
            formDayTol={formDayTol} setFormDayTol={setFormDayTol}
            saving={saving} onCancel={cancelEdit} onSave={save}
          />
        </div>
      )}

      {loading ? (
        <div style={styles.empty}>Loading...</div>
      ) : sortedRules.length === 0 ? (
        <div style={styles.empty}>No rules yet. Create one to automatically categorize transactions.</div>
      ) : (
        <div className="table-wrap"><table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Priority</th>
              <th style={styles.th}>Pattern</th>
              <th style={styles.th}>Conditions</th>
              <th style={styles.th}>Category</th>
              <th style={styles.th}>Budget</th>
              <th style={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {sortedRules.map((rule) => {
              const conditions = ruleConditionSummary(rule);
              const isEditing = editingId === rule.ruleId;
              return (
                <React.Fragment key={rule.ruleId}>
                  <tr style={styles.tr}>
                    <td style={{ ...styles.td, width: 70, color: '#718096' }}>{rule.priority}</td>
                    <td style={styles.td}>
                      <code style={styles.pattern}>{rule.pattern}</code>
                    </td>
                    <td style={styles.td}>
                      {conditions
                        ? <span style={styles.condBadge}>{conditions}</span>
                        : <span style={styles.none}>—</span>}
                    </td>
                    <td style={styles.td}>
                      {rule.categoryId ? (
                        <span style={{ ...styles.catBadge, background: categoryColor(rule.categoryId) }}>
                          {categoryName(rule.categoryId)}
                        </span>
                      ) : (
                        <span style={styles.none}>—</span>
                      )}
                    </td>
                    <td style={styles.td}>
                      {rule.budgetId ? (
                        <span style={styles.budgetBadge}>{budgetName(rule.budgetId)}</span>
                      ) : (
                        <span style={styles.none}>—</span>
                      )}
                    </td>
                    <td style={{ ...styles.td, textAlign: 'right' }}>
                      <button style={styles.linkBtn} onClick={() => isEditing ? cancelEdit() : openEdit(rule)}>
                        {isEditing ? 'Cancel' : 'Edit'}
                      </button>
                      {!isEditing && (
                        <button style={{ ...styles.linkBtn, color: '#e53e3e', marginLeft: 8 }} onClick={() => remove(rule)}>Delete</button>
                      )}
                    </td>
                  </tr>
                  {isEditing && (
                    <tr>
                      <td colSpan={6} style={{ padding: '0.5rem 0.75rem 0.75rem' }}>
                        <div className="form-card" style={{ marginBottom: 0 }}>
                          <RuleForm
                          categories={categories} budgets={budgets}
                          formPattern={formPattern} setFormPattern={setFormPattern}
                          formCategoryId={formCategoryId} setFormCategoryId={setFormCategoryId}
                          formBudgetId={formBudgetId} setFormBudgetId={setFormBudgetId}
                          formPriority={formPriority} setFormPriority={setFormPriority}
                          useAmount={useAmount} setUseAmount={setUseAmount}
                          formAmount={formAmount} setFormAmount={setFormAmount}
                          formAmountTol={formAmountTol} setFormAmountTol={setFormAmountTol}
                          useDay={useDay} setUseDay={setUseDay}
                          formDay={formDay} setFormDay={setFormDay}
                          formDayTol={formDayTol} setFormDayTol={setFormDayTol}
                           saving={saving} onCancel={cancelEdit} onSave={save}
                          />
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table></div>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  title: { margin: '0 0 0.25rem', fontSize: '1.1rem', fontWeight: 600 },
  subtitle: { margin: 0, fontSize: '0.8rem', color: '#718096', maxWidth: 620 },
  optional: { fontWeight: 400, color: '#a0aec0', fontSize: '0.75rem' },
  primaryBtn: { background: '#0d7a6b', color: '#fff', border: 'none', borderRadius: 6, padding: '0.45rem 1rem', cursor: 'pointer', fontSize: '0.875rem', whiteSpace: 'nowrap' },
  secondaryBtn: { background: 'none', color: '#0d7a6b', border: '1px solid #0d7a6b', borderRadius: 6, padding: '0.45rem 1rem', cursor: 'pointer', fontSize: '0.875rem' },
  linkBtn: { background: 'none', border: 'none', color: '#0d7a6b', cursor: 'pointer', fontSize: '0.875rem', padding: 0 },
  formTitle: { margin: '0 0 1rem', fontSize: '0.95rem', fontWeight: 600 },
  label: { display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#4a5568', marginBottom: '0.3rem' },
  checkboxLabel: { display: 'flex', alignItems: 'center', fontSize: '0.8rem', fontWeight: 600, color: '#4a5568', marginBottom: '0.3rem', cursor: 'pointer' },
  input: { width: '100%', boxSizing: 'border-box' as const, border: '1px solid #cbd5e0', borderRadius: 6, padding: '0.4rem 0.6rem', fontSize: '0.9rem' },
  select: { width: '100%' },
  inlineGroup: { display: 'flex', gap: '1rem', flexWrap: 'wrap' as const, marginTop: '0.5rem' },
  inlineField: { display: 'flex', flexDirection: 'column' as const, gap: '0.2rem' },
  inlineLabel: { fontSize: '0.75rem', color: '#718096', fontWeight: 500 },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '0.9rem' },
  th: { textAlign: 'left' as const, padding: '0.6rem 0.75rem', background: '#f7fafc', borderBottom: '2px solid #e2e8f0', fontWeight: 600, color: '#4a5568' },
  tr: { borderBottom: '1px solid #e2e8f0' },
  td: { padding: '0.65rem 0.75rem', color: '#2d3748', verticalAlign: 'middle' as const },
  pattern: { background: '#edf2f7', borderRadius: 4, padding: '0.15rem 0.4rem', fontSize: '0.85rem', fontFamily: 'monospace' },
  condBadge: { background: '#fef3c7', color: '#92400e', borderRadius: 4, padding: '0.15rem 0.5rem', fontSize: '0.78rem', fontFamily: 'monospace' },
  catBadge: { color: '#fff', borderRadius: 12, padding: '0.15rem 0.6rem', fontSize: '0.8rem', display: 'inline-block' },
  budgetBadge: { background: '#fef3c0', color: '#7a5c00', borderRadius: 12, padding: '0.15rem 0.6rem', fontSize: '0.8rem', display: 'inline-block' },
  none: { color: '#a0aec0', fontSize: '0.85rem' },
  empty: { textAlign: 'center' as const, color: '#718096', marginTop: '2rem' },
  error: { background: '#fff5f5', color: '#c53030', border: '1px solid #feb2b2', borderRadius: 6, padding: '0.75rem 1rem', marginBottom: '1rem' },
};

export default RulesPage;

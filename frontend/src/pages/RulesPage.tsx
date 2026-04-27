import React, { useEffect, useState } from 'react';
import { Category, Rule, getCategories, getRules, putRule, deleteRule } from '../api/client';

const RulesPage: React.FC = () => {
  const [rules, setRules] = useState<Rule[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formPattern, setFormPattern] = useState('');
  const [formCategoryId, setFormCategoryId] = useState('');
  const [formPriority, setFormPriority] = useState('10');
  const [saving, setSaving] = useState(false);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [r, c] = await Promise.all([getRules(), getCategories()]);
      setRules(r.slice().sort((a, b) => a.priority - b.priority));
      setCategories(c);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const openNew = () => {
    setEditingId('new');
    setFormPattern('');
    setFormCategoryId(categories[0]?.categoryId ?? '');
    setFormPriority('10');
  };

  const openEdit = (rule: Rule) => {
    setEditingId(rule.ruleId);
    setFormPattern(rule.pattern);
    setFormCategoryId(rule.categoryId);
    setFormPriority(String(rule.priority));
  };

  const cancelEdit = () => { setEditingId(null); };

  const save = async () => {
    if (!formPattern.trim() || !formCategoryId) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await putRule({
        ruleId: editingId === 'new' ? '' : editingId!,
        pattern: formPattern.trim(),
        categoryId: formCategoryId,
        priority: parseInt(formPriority, 10) || 10,
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
    const catName = categories.find((c) => c.categoryId === rule.categoryId)?.name ?? rule.categoryId;
    if (!window.confirm(`Delete rule "${rule.pattern}" → ${catName}?`)) return;
    try {
      await deleteRule(rule.ruleId);
      setRules((prev) => prev.filter((r) => r.ruleId !== rule.ruleId));
    } catch (e: any) {
      setError(e.message);
    }
  };

  const categoryName = (id: string) => categories.find((c) => c.categoryId === id)?.name ?? id;
  const categoryColor = (id: string) => categories.find((c) => c.categoryId === id)?.color ?? '#cbd5e0';

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 style={styles.title}>Auto-Assignment Rules</h2>
          <p style={styles.subtitle}>
            Rules automatically assign a category to transactions whose merchant name contains the pattern.
            Lower priority values run first. Manual assignments are never overridden.
          </p>
        </div>
        <button style={styles.primaryBtn} onClick={openNew}>+ New Rule</button>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {editingId && (
        <div className="form-card">
          <h3 style={styles.formTitle}>{editingId === 'new' ? 'New Rule' : 'Edit Rule'}</h3>
          <div className="form-row">
            <label style={styles.label}>Pattern (merchant name contains)</label>
            <input
              style={styles.input}
              value={formPattern}
              onChange={(e) => setFormPattern(e.target.value)}
              placeholder="e.g. whole foods"
            />
          </div>
          <div className="form-row">
            <label style={styles.label}>Assign to Category</label>
            <select
              style={styles.select}
              value={formCategoryId}
              onChange={(e) => setFormCategoryId(e.target.value)}
            >
              <option value="">— Select category —</option>
              {categories.map((c) => (
                <option key={c.categoryId} value={c.categoryId}>{c.name}</option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label style={styles.label}>Priority (lower = applied first)</label>
            <input
              style={{ ...styles.input, maxWidth: 100 }}
              type="number"
              min="0"
              value={formPriority}
              onChange={(e) => setFormPriority(e.target.value)}
            />
          </div>
          <div className="form-actions">
            <button style={styles.secondaryBtn} onClick={cancelEdit} disabled={saving}>Cancel</button>
            <button
              style={styles.primaryBtn}
              onClick={save}
              disabled={saving || !formPattern.trim() || !formCategoryId}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div style={styles.empty}>Loading...</div>
      ) : rules.length === 0 ? (
        <div style={styles.empty}>No rules yet. Create one to automatically categorize transactions.</div>
      ) : (
        <div className="table-wrap"><table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Priority</th>
              <th style={styles.th}>Pattern</th>
              <th style={styles.th}>Assigns To</th>
              <th style={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.ruleId} style={styles.tr}>
                <td style={{ ...styles.td, width: 70, color: '#718096' }}>{rule.priority}</td>
                <td style={styles.td}>
                  <code style={styles.pattern}>{rule.pattern}</code>
                </td>
                <td style={styles.td}>
                  <span style={{ ...styles.catBadge, background: categoryColor(rule.categoryId) }}>
                    {categoryName(rule.categoryId)}
                  </span>
                </td>
                <td style={{ ...styles.td, textAlign: 'right' }}>
                  <button style={styles.linkBtn} onClick={() => openEdit(rule)}>Edit</button>
                  <button style={{ ...styles.linkBtn, color: '#e53e3e', marginLeft: 8 }} onClick={() => remove(rule)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  title: { margin: '0 0 0.25rem', fontSize: '1.1rem', fontWeight: 600 },
  subtitle: { margin: 0, fontSize: '0.8rem', color: '#718096', maxWidth: 540 },
  primaryBtn: { background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 6, padding: '0.45rem 1rem', cursor: 'pointer', fontSize: '0.875rem', whiteSpace: 'nowrap' },
  secondaryBtn: { background: '#edf2f7', color: '#2d3748', border: 'none', borderRadius: 6, padding: '0.45rem 1rem', cursor: 'pointer', fontSize: '0.875rem' },
  linkBtn: { background: 'none', border: 'none', color: '#4f46e5', cursor: 'pointer', fontSize: '0.875rem', padding: 0 },
  formTitle: { margin: '0 0 1rem', fontSize: '0.95rem', fontWeight: 600 },
  label: { display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#4a5568', marginBottom: '0.3rem' },
  input: { width: '100%', boxSizing: 'border-box' as const, border: '1px solid #cbd5e0', borderRadius: 6, padding: '0.4rem 0.6rem', fontSize: '0.9rem' },
  select: { width: '100%', border: '1px solid #cbd5e0', borderRadius: 6, padding: '0.4rem 0.6rem', fontSize: '0.9rem', background: '#fff' },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '0.9rem' },
  th: { textAlign: 'left' as const, padding: '0.6rem 0.75rem', background: '#f7fafc', borderBottom: '2px solid #e2e8f0', fontWeight: 600, color: '#4a5568' },
  tr: { borderBottom: '1px solid #e2e8f0' },
  td: { padding: '0.65rem 0.75rem', color: '#2d3748', verticalAlign: 'middle' as const },
  pattern: { background: '#edf2f7', borderRadius: 4, padding: '0.15rem 0.4rem', fontSize: '0.85rem', fontFamily: 'monospace' },
  catBadge: { color: '#fff', borderRadius: 12, padding: '0.15rem 0.6rem', fontSize: '0.8rem', display: 'inline-block' },
  empty: { textAlign: 'center' as const, color: '#718096', marginTop: '2rem' },
  error: { background: '#fff5f5', color: '#c53030', border: '1px solid #feb2b2', borderRadius: 6, padding: '0.75rem 1rem', marginBottom: '1rem' },
};

export default RulesPage;

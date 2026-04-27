import React, { useEffect, useState } from 'react';
import { Category, getCategories, putCategory, deleteCategory } from '../api/client';

const PRESET_COLORS = [
  '#6366f1', '#f59e0b', '#10b981', '#ef4444',
  '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6',
  '#f97316', '#84cc16',
];

const CategoriesPage: React.FC = () => {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formColor, setFormColor] = useState(PRESET_COLORS[0]);
  const [saving, setSaving] = useState(false);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setCategories(await getCategories());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const openNew = () => {
    setEditingId('new');
    setFormName('');
    setFormColor(PRESET_COLORS[0]);
  };

  const openEdit = (cat: Category) => {
    setEditingId(cat.categoryId);
    setFormName(cat.name);
    setFormColor(cat.color);
  };

  const cancelEdit = () => { setEditingId(null); };

  const save = async () => {
    if (!formName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await putCategory({
        categoryId: editingId === 'new' ? '' : editingId!,
        name: formName.trim(),
        color: formColor,
      });
      setCategories((prev) => {
        const idx = prev.findIndex((c) => c.categoryId === saved.categoryId);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = saved;
          return next;
        }
        return [...prev, saved];
      });
      setEditingId(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (cat: Category) => {
    if (!window.confirm(`Delete "${cat.name}"? Transactions assigned to it will become uncategorized.`)) return;
    try {
      await deleteCategory(cat.categoryId);
      setCategories((prev) => prev.filter((c) => c.categoryId !== cat.categoryId));
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h2 style={styles.title}>Spending Categories</h2>
        <button style={styles.primaryBtn} onClick={openNew}>+ New Category</button>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {editingId && (
        <div className="form-card">
          <h3 style={styles.formTitle}>{editingId === 'new' ? 'New Category' : 'Edit Category'}</h3>
          <div className="form-row">
            <label style={styles.label}>Name</label>
            <input
              style={styles.input}
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="e.g. Groceries"
            />
          </div>
          <div className="form-row">
            <label style={styles.label}>Color</label>
            <div style={styles.colorPicker}>
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setFormColor(c)}
                  style={{
                    ...styles.colorSwatch,
                    background: c,
                    outline: formColor === c ? `3px solid ${c}` : 'none',
                    outlineOffset: 2,
                  }}
                />
              ))}
            </div>
          </div>
          <div className="form-actions">
            <button style={styles.secondaryBtn} onClick={cancelEdit} disabled={saving}>Cancel</button>
            <button style={styles.primaryBtn} onClick={save} disabled={saving || !formName.trim()}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div style={styles.empty}>Loading...</div>
      ) : categories.length === 0 ? (
        <div style={styles.empty}>No categories yet. Create one to start tagging transactions.</div>
      ) : (
        <div className="table-wrap">
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Category</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {categories.map((cat) => (
                <tr key={cat.categoryId} style={styles.tr}>
                  <td style={styles.td}>
                    <span style={{ ...styles.dot, background: cat.color }} />
                    {cat.name}
                  </td>
                  <td style={{ ...styles.td, textAlign: 'right' }}>
                    <button style={styles.linkBtn} onClick={() => openEdit(cat)}>Edit</button>
                    <button style={{ ...styles.linkBtn, color: '#e53e3e', marginLeft: 8 }} onClick={() => remove(cat)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  title: { margin: 0, fontSize: '1.1rem', fontWeight: 600 },
  primaryBtn: { background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 6, padding: '0.45rem 1rem', cursor: 'pointer', fontSize: '0.875rem' },
  secondaryBtn: { background: '#edf2f7', color: '#2d3748', border: 'none', borderRadius: 6, padding: '0.45rem 1rem', cursor: 'pointer', fontSize: '0.875rem' },
  linkBtn: { background: 'none', border: 'none', color: '#4f46e5', cursor: 'pointer', fontSize: '0.875rem', padding: 0 },
  formTitle: { margin: '0 0 1rem', fontSize: '0.95rem', fontWeight: 600 },
  label: { display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#4a5568', marginBottom: '0.3rem' },
  input: { width: '100%', boxSizing: 'border-box' as const, border: '1px solid #cbd5e0', borderRadius: 6, padding: '0.4rem 0.6rem', fontSize: '0.9rem' },
  colorPicker: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap' },
  colorSwatch: { width: 32, height: 32, borderRadius: '50%', border: 'none', cursor: 'pointer' },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '0.9rem' },
  th: { textAlign: 'left' as const, padding: '0.6rem 0.75rem', background: '#f7fafc', borderBottom: '2px solid #e2e8f0', fontWeight: 600, color: '#4a5568' },
  tr: { borderBottom: '1px solid #e2e8f0' },
  td: { padding: '0.65rem 0.75rem', color: '#2d3748', verticalAlign: 'middle' as const },
  dot: { display: 'inline-block', width: 10, height: 10, borderRadius: '50%', marginRight: 8 },
  empty: { textAlign: 'center' as const, color: '#718096', marginTop: '2rem' },
  error: { background: '#fff5f5', color: '#c53030', border: '1px solid #feb2b2', borderRadius: 6, padding: '0.75rem 1rem', marginBottom: '1rem' },
};

export default CategoriesPage;

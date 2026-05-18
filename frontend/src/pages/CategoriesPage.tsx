import React, { useState, useEffect } from 'react';
import { Category, putCategory, deleteCategory } from '../api/client';
import { useData } from '../auth/DataContext';

const PRESET_COLORS = [
  '#6366f1', '#f59e0b', '#10b981', '#ef4444',
  '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6',
  '#f97316', '#84cc16',
];

const CategoriesPage: React.FC = () => {
  const { categories, setCategories, loading } = useData();
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formColor, setFormColor] = useState(PRESET_COLORS[0]);
  const [saving, setSaving] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [hexInput, setHexInput] = useState('');
  const [rgbInput, setRgbInput] = useState({ r: '', g: '', b: '' });

  const isPreset = PRESET_COLORS.includes(formColor);

  useEffect(() => {
    setHexInput(formColor.replace('#', ''));
    const r = parseInt(formColor.slice(1, 3), 16);
    const g = parseInt(formColor.slice(3, 5), 16);
    const b = parseInt(formColor.slice(5, 7), 16);
    if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
      setRgbInput({ r: String(r), g: String(g), b: String(b) });
    }
  }, [formColor]);

  const applyHex = (raw: string) => {
    const h = raw.replace('#', '');
    if (/^[0-9a-fA-F]{6}$/.test(h)) setFormColor('#' + h.toLowerCase());
  };

  const applyRgb = (r: string, g: string, b: string) => {
    const ri = parseInt(r), gi = parseInt(g), bi = parseInt(b);
    if ([ri, gi, bi].every(v => !isNaN(v) && v >= 0 && v <= 255)) {
      setFormColor('#' + [ri, gi, bi].map(v => v.toString(16).padStart(2, '0')).join(''));
    }
  };

  const openNew = () => {
    setEditingId('new');
    setFormName('');
    setFormColor(PRESET_COLORS[0]);
    setCustomOpen(false);
  };

  const openEdit = (cat: Category) => {
    setEditingId(cat.categoryId);
    setFormName(cat.name);
    setFormColor(cat.color);
    setCustomOpen(!PRESET_COLORS.includes(cat.color));
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

  const formFields = (
    <>
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
              onClick={() => { setFormColor(c); setCustomOpen(false); }}
              style={{
                ...styles.colorSwatch,
                background: c,
                outline: formColor === c && !customOpen ? `3px solid ${c}` : 'none',
                outlineOffset: 2,
              }}
            />
          ))}
          <button
            title="Custom color"
            onClick={() => setCustomOpen(o => !o)}
            style={{
              ...styles.colorSwatch,
              background: !isPreset ? formColor : 'conic-gradient(red, yellow, lime, aqua, blue, magenta, red)',
              outline: customOpen || !isPreset ? '3px solid #0d7a6b' : 'none',
              outlineOffset: 2,
              fontSize: '1rem',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            {isPreset && <span style={{ fontSize: '1.1rem', lineHeight: 1, pointerEvents: 'none' }}>+</span>}
          </button>
        </div>
        {customOpen && (
          <div style={styles.customPanel}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
              <input
                type="color"
                value={formColor}
                onChange={e => setFormColor(e.target.value)}
                style={{ width: 48, height: 48, border: 'none', borderRadius: 6, cursor: 'pointer', padding: 2, background: 'none' }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                <span style={styles.inputLabel}>#</span>
                <input
                  style={{ ...styles.shortInput, width: 80 }}
                  maxLength={6}
                  value={hexInput}
                  onChange={e => { setHexInput(e.target.value); applyHex(e.target.value); }}
                  placeholder="e.g. ff6600"
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                <span style={styles.inputLabel}>R</span>
                <input style={styles.shortInput} type="number" min={0} max={255} value={rgbInput.r}
                  onChange={e => { const v = { ...rgbInput, r: e.target.value }; setRgbInput(v); applyRgb(v.r, v.g, v.b); }} />
                <span style={styles.inputLabel}>G</span>
                <input style={styles.shortInput} type="number" min={0} max={255} value={rgbInput.g}
                  onChange={e => { const v = { ...rgbInput, g: e.target.value }; setRgbInput(v); applyRgb(v.r, v.g, v.b); }} />
                <span style={styles.inputLabel}>B</span>
                <input style={styles.shortInput} type="number" min={0} max={255} value={rgbInput.b}
                  onChange={e => { const v = { ...rgbInput, b: e.target.value }; setRgbInput(v); applyRgb(v.r, v.g, v.b); }} />
              </div>
              <div style={{ width: 32, height: 32, borderRadius: '50%', background: formColor, border: '1px solid #cbd5e0', flexShrink: 0 }} />
            </div>
          </div>
        )}
      </div>
      <div className="form-actions">
        <button style={styles.secondaryBtn} onClick={cancelEdit} disabled={saving}>Cancel</button>
        <button style={styles.primaryBtn} onClick={save} disabled={saving || !formName.trim()}>
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </>
  );

  return (
    <div className="page">
      <div className="page-header">
        <h2 style={styles.title}>Spending Categories</h2>
        {editingId !== 'new' && (
          <button style={styles.primaryBtn} onClick={openNew}>+ New Category</button>
        )}
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {editingId === 'new' && (
        <div className="form-card">
          <h3 style={styles.formTitle}>New Category</h3>
          {formFields}
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
              {categories.map((cat) => {
                const isEditing = editingId === cat.categoryId;
                return (
                  <React.Fragment key={cat.categoryId}>
                    <tr style={styles.tr}>
                      <td style={styles.td}>
                        <span style={{ ...styles.dot, background: cat.color }} />
                        {cat.name}
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>
                        {isEditing ? (
                          <button style={styles.linkBtn} onClick={cancelEdit}>Cancel</button>
                        ) : (
                          <>
                            <button style={styles.linkBtn} onClick={() => openEdit(cat)}>Edit</button>
                            <button style={{ ...styles.linkBtn, color: '#e53e3e', marginLeft: 8 }} onClick={() => remove(cat)}>Delete</button>
                          </>
                        )}
                      </td>
                    </tr>
                    {isEditing && (
                      <tr>
                        <td colSpan={2} style={styles.expandCell}>
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

const styles: Record<string, React.CSSProperties> = {
  title: { margin: 0, fontSize: '1.1rem', fontWeight: 600 },
  primaryBtn: { background: '#0d7a6b', color: '#fff', border: 'none', borderRadius: 6, padding: '0.45rem 1rem', cursor: 'pointer', fontSize: '0.875rem' },
  secondaryBtn: { background: 'none', color: '#0d7a6b', border: '1px solid #0d7a6b', borderRadius: 6, padding: '0.45rem 1rem', cursor: 'pointer', fontSize: '0.875rem' },
  linkBtn: { background: 'none', border: 'none', color: '#0d7a6b', cursor: 'pointer', fontSize: '0.875rem', padding: 0 },
  formTitle: { margin: '0 0 1rem', fontSize: '0.95rem', fontWeight: 600 },
  label: { display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#4a5568', marginBottom: '0.3rem' },
  input: { width: '100%', boxSizing: 'border-box' as const, border: '1px solid #cbd5e0', borderRadius: 6, padding: '0.4rem 0.6rem', fontSize: '0.9rem' },
  colorPicker: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap' as const, alignItems: 'center' },
  colorSwatch: { width: 32, height: 32, borderRadius: '50%', border: 'none', cursor: 'pointer', flexShrink: 0 },
  customPanel: { marginTop: '0.75rem', padding: '0.75rem', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8 },
  shortInput: { width: 56, border: '1px solid #cbd5e0', borderRadius: 6, padding: '0.3rem 0.4rem', fontSize: '0.85rem' },
  inputLabel: { fontSize: '0.8rem', fontWeight: 600, color: '#4a5568' },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '0.9rem' },
  th: { textAlign: 'left' as const, padding: '0.6rem 0.75rem', background: '#f7fafc', borderBottom: '2px solid #e2e8f0', fontWeight: 600, color: '#4a5568' },
  tr: { borderBottom: '1px solid #e2e8f0' },
  td: { padding: '0.65rem 0.75rem', color: '#2d3748', verticalAlign: 'middle' as const },
  dot: { display: 'inline-block', width: 10, height: 10, borderRadius: '50%', marginRight: 8 },
  empty: { textAlign: 'center' as const, color: '#718096', marginTop: '2rem' },
  error: { background: '#fff5f5', color: '#c53030', border: '1px solid #feb2b2', borderRadius: 6, padding: '0.75rem 1rem', marginBottom: '1rem' },
  expandCell: { padding: 0, background: '#f7fafc', borderBottom: '2px solid #cbd5e0' },
};

export default CategoriesPage;

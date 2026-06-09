import React, { useState, useEffect, useRef } from 'react';
import { DeductionItem } from '../api/client';

interface Props {
  title: string;
  items: DeductionItem[];
  namePlaceholder?: string;   // placeholder for the Description column input
  onConfirm: (items: DeductionItem[]) => void;
  onClose: () => void;
}

export const ItemizeModal: React.FC<Props> = ({ title, items: initialItems, namePlaceholder = 'e.g. Description', onConfirm, onClose }) => {
  const [rows, setRows] = useState<DeductionItem[]>(
    initialItems.length > 0 ? initialItems.map(i => ({ ...i })) : [{ name: '', amount: 0 }]
  );
  const lastNameRef = useRef<HTMLInputElement | null>(null);

  // Focus the last name input when a new row is added
  useEffect(() => {
    lastNameRef.current?.focus();
  }, [rows.length]);

  const setRow = (idx: number, patch: Partial<DeductionItem>) => {
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, ...patch } : r));
  };

  const addRow = () => setRows(prev => [...prev, { name: '', amount: 0 }]);

  const removeRow = (idx: number) => {
    setRows(prev => prev.length === 1 ? [{ name: '', amount: 0 }] : prev.filter((_, i) => i !== idx));
  };

  const total = rows.reduce((s, r) => s + (r.amount || 0), 0);

  const handleConfirm = () => {
    const valid = rows.filter(r => r.name.trim() !== '' || r.amount > 0);
    onConfirm(valid);
  };

  // Modal is truly modal — no backdrop dismiss

  return (
    <div style={styles.backdrop}>
      <div style={styles.modal} role="dialog" aria-modal="true" aria-label={title}>
        <div style={styles.header}>
          <span style={styles.headerTitle}>{title}</span>
          <button style={styles.closeBtn} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div style={styles.body}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Description</th>
                <th style={{ ...styles.th, textAlign: 'right' }}>Amount / Period ($)</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => (
                <tr key={idx}>
                  <td style={styles.td}>
                    <input
                      ref={idx === rows.length - 1 ? lastNameRef : undefined}
                      style={styles.input}
                      value={row.name}
                      onChange={e => setRow(idx, { name: e.target.value })}
                      placeholder={namePlaceholder}
                    />
                  </td>
                  <td style={{ ...styles.td, textAlign: 'right' }}>
                    <input
                      style={{ ...styles.input, textAlign: 'right', width: 100 }}
                      type="number"
                      min="0"
                      step="0.01"
                      value={row.amount || ''}
                      onChange={e => setRow(idx, { amount: parseFloat(e.target.value) || 0 })}
                    />
                  </td>
                  <td style={{ ...styles.td, width: 32 }}>
                    <button
                      style={styles.removeBtn}
                      onClick={() => removeRow(idx)}
                      title="Remove row"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <button style={styles.addRowBtn} onClick={addRow}>+ Add item</button>

          <div style={styles.totalRow}>
            <span style={styles.totalLabel}>Total</span>
            <span style={styles.totalValue}>${total.toFixed(2)}</span>
          </div>
        </div>

        <div style={styles.footer}>
          <button style={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button style={styles.okBtn} onClick={handleConfirm}>OK</button>
        </div>
      </div>
    </div>
  );
};

// ── Icon: two lines on a piece of paper (SVG) ─────────────────────────────────
// Used in the input field to open the modal.
export const ItemizeIcon: React.FC<{ size?: number; color?: string }> = ({
  size = 15,
  color = '#6b7280',
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    {/* Paper outline */}
    <rect x="2" y="1" width="12" height="14" rx="1.5" stroke={color} strokeWidth="1.4" fill="none"/>
    {/* Three horizontal lines on the paper */}
    <line x1="5" y1="5.5" x2="11" y2="5.5" stroke={color} strokeWidth="1.3" strokeLinecap="round"/>
    <line x1="5" y1="8"   x2="11" y2="8"   stroke={color} strokeWidth="1.3" strokeLinecap="round"/>
    <line x1="5" y1="10.5" x2="9" y2="10.5" stroke={color} strokeWidth="1.3" strokeLinecap="round"/>
  </svg>
);

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed', inset: 0,
    background: 'rgba(0,0,0,0.4)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    background: '#fff',
    borderRadius: 10,
    boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
    width: '90%', maxWidth: 520,
    display: 'flex', flexDirection: 'column',
    maxHeight: '90vh',
    overflow: 'hidden',
  },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '0.85rem 1.1rem',
    borderBottom: '1px solid #e2e8f0',
  },
  headerTitle: { fontWeight: 600, fontSize: '0.95rem', color: '#1a202c' },
  closeBtn: {
    background: 'none', border: 'none', cursor: 'pointer',
    fontSize: '0.9rem', color: '#6b7280', padding: '0 0.2rem',
    lineHeight: 1,
  },
  body: {
    padding: '1rem 1.1rem',
    overflowY: 'auto',
    flex: 1,
  },
  table: { width: '100%', borderCollapse: 'collapse', marginBottom: '0.6rem' },
  th: {
    textAlign: 'left', padding: '0.4rem 0.4rem 0.5rem',
    fontSize: '0.8rem', color: '#4a5568',
    borderBottom: '2px solid #e2e8f0', fontWeight: 600,
  },
  td: { padding: '0.35rem 0.4rem', verticalAlign: 'middle' },
  input: {
    width: '100%', boxSizing: 'border-box',
    padding: '0.35rem 0.5rem',
    border: '1px solid #cbd5e0', borderRadius: 5,
    fontSize: '0.875rem',
  },
  removeBtn: {
    background: 'none', border: 'none', cursor: 'pointer',
    color: '#9ca3af', fontSize: '0.8rem', padding: 2,
    lineHeight: 1,
  },
  addRowBtn: {
    background: 'none', border: 'none', cursor: 'pointer',
    color: '#0d7a6b', fontSize: '0.8rem', padding: '0.3rem 0',
    textDecoration: 'underline',
  },
  totalRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    borderTop: '2px solid #e2e8f0', marginTop: '0.6rem', paddingTop: '0.6rem',
    fontWeight: 700, fontSize: '0.9rem',
  },
  totalLabel: { color: '#374151' },
  totalValue: { color: '#0d7a6b' },
  footer: {
    display: 'flex', justifyContent: 'flex-end', gap: '0.5rem',
    padding: '0.75rem 1.1rem',
    borderTop: '1px solid #e2e8f0',
  },
  cancelBtn: {
    background: 'none', color: '#0d7a6b', border: '1px solid #0d7a6b',
    borderRadius: 6, padding: '0.4rem 1rem', cursor: 'pointer', fontSize: '0.875rem',
  },
  okBtn: {
    background: '#0d7a6b', color: '#fff', border: 'none',
    borderRadius: 6, padding: '0.4rem 1rem', cursor: 'pointer', fontSize: '0.875rem',
  },
};

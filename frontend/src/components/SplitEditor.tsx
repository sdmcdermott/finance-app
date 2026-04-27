import React, { useState } from 'react';
import { Transaction, TransactionSplit, Category, putSplits } from '../api/client';

interface Props {
  txn: Transaction;
  categories: Category[];
  onClose: () => void;
  onSaved: (updated: Transaction) => void;
}

// A blank split row ready for editing
const blankSplit = (): Omit<TransactionSplit, 'accountId' | 'dateTransactionId'> => ({
  splitId: '',
  amount: 0,
  customCategory: '',
  budgetId: '',
  note: '',
});

const fmt2 = (n: number) => n.toFixed(2);

const SplitEditor: React.FC<Props> = ({ txn, categories, onClose, onSaved }) => {
  const parentAbs = Math.abs(txn.amount);
  const isCreditTxn = txn.amount < 0; // negative = credit/income in Plaid convention

  // Initialise from existing splits or two blank rows
  const [rows, setRows] = useState<Omit<TransactionSplit, 'accountId' | 'dateTransactionId'>[]>(
    () => {
      if (txn.splits && txn.splits.length >= 2) {
        return txn.splits.map(s => ({
          splitId: s.splitId,
          amount: s.amount,
          customCategory: s.customCategory,
          budgetId: s.budgetId,
          note: s.note,
        }));
      }
      // Pre-fill first row with the parent's category
      const first = blankSplit();
      first.customCategory = txn.customCategory || '';
      first.amount = parentAbs;
      const second = blankSplit();
      return [first, second];
    }
  );

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Derived totals
  const allocated = rows.reduce((s, r) => s + (r.amount || 0), 0);
  const remainder = parseFloat((parentAbs - allocated).toFixed(2));
  const valid = rows.length >= 2
    && rows.every(r => r.amount > 0)
    && Math.abs(remainder) <= 0.015;

  const setRow = (idx: number, patch: Partial<typeof rows[0]>) => {
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, ...patch } : r));
  };

  const addRow = () => setRows(prev => [...prev, blankSplit()]);

  const removeRow = (idx: number) => {
    if (rows.length <= 2) return; // minimum 2
    setRows(prev => prev.filter((_, i) => i !== idx));
  };

  // Distribute remainder into last row for convenience
  const distributeRemainder = () => {
    if (rows.length === 0) return;
    const lastIdx = rows.length - 1;
    const sumExcludingLast = rows.slice(0, lastIdx).reduce((s, r) => s + (r.amount || 0), 0);
    const lastAmount = parseFloat((parentAbs - sumExcludingLast).toFixed(2));
    if (lastAmount > 0) {
      setRow(lastIdx, { amount: lastAmount });
    }
  };

  const handleSave = async () => {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await putSplits(txn.accountId, txn.dateTransactionId, rows);
      onSaved({ ...txn, splits: saved });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveAllSplits = async () => {
    if (!window.confirm('Remove all splits? The transaction will revert to a single entry.')) return;
    setSaving(true);
    setError(null);
    try {
      await putSplits(txn.accountId, txn.dateTransactionId, []);
      onSaved({ ...txn, splits: [] });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="split-editor">
      <div className="split-editor-header">
        <div>
          <div className="split-editor-title">Split Transaction</div>
          <div className="split-editor-subtitle">
            {txn.merchantName || txn.name} &nbsp;·&nbsp;
            <span style={{ color: txn.amount > 0 ? '#e53e3e' : '#38a169', fontWeight: 600 }}>
              {isCreditTxn ? '+' : '-'}${fmt2(parentAbs)}
            </span>
          </div>
        </div>
        <button className="split-close-btn" onClick={onClose} title="Close">✕</button>
      </div>

      {error && <div className="split-error">{error}</div>}

      <div className="split-rows">
        {rows.map((row, idx) => (
          <div key={idx} className="split-row">
            <div className="split-row-num">{idx + 1}</div>
            <div className="split-row-fields">
              <input
                type="number"
                className="split-amount"
                min="0.01"
                step="0.01"
                value={row.amount || ''}
                onChange={e => setRow(idx, { amount: parseFloat(e.target.value) || 0 })}
                placeholder="0.00"
              />
              <select
                className="split-cat"
                value={row.customCategory}
                onChange={e => setRow(idx, { customCategory: e.target.value })}
              >
                <option value="">— Category —</option>
                {categories.map(c => (
                  <option key={c.categoryId} value={c.categoryId}>{c.name}</option>
                ))}
              </select>
              <input
                type="text"
                className="split-note"
                placeholder="Note (optional)"
                value={row.note}
                onChange={e => setRow(idx, { note: e.target.value })}
              />
            </div>
            {rows.length > 2 && (
              <button className="split-remove-btn" onClick={() => removeRow(idx)} title="Remove row">✕</button>
            )}
          </div>
        ))}
      </div>

      <div className="split-summary">
        <span className={`split-remainder ${Math.abs(remainder) > 0.015 ? 'split-remainder--bad' : 'split-remainder--ok'}`}>
          {Math.abs(remainder) <= 0.015
            ? '✓ Amounts balance'
            : `Remaining: $${fmt2(Math.abs(remainder))} ${remainder > 0 ? 'unallocated' : 'over'}`}
        </span>
        {remainder > 0.015 && (
          <button className="split-distribute-btn" onClick={distributeRemainder}>
            Fill last row
          </button>
        )}
      </div>

      <div className="split-actions">
        <button className="split-add-btn" onClick={addRow}>+ Add row</button>
        <div className="split-actions-right">
          {(txn.splits && txn.splits.length > 0) && (
            <button className="split-unsplit-btn" onClick={handleRemoveAllSplits} disabled={saving}>
              Remove splits
            </button>
          )}
          <button className="split-cancel-btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="split-save-btn" onClick={handleSave} disabled={saving || !valid}>
            {saving ? 'Saving…' : 'Save splits'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SplitEditor;

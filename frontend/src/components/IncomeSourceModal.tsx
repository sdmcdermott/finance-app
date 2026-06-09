import React, { useState, useEffect } from 'react';
import {
  Transaction, IncomeSource, Rule,
  putRule, updateTransactionBudget,
  INCOME_BUDGET_PREFIX, INCOME_CATEGORY_ID, MASTER_BUDGET_ID,
} from '../api/client';
import { fmtCurrency } from '../utils/dates';

interface Props {
  transaction: Transaction;
  incomeSources: IncomeSource[];
  // Existing income rules keyed by incomeSourceId for pre-population
  incomeRulesBySourceId: Record<string, Rule>;
  // sourceId is undefined if user chose not to associate with a source
  // budgetId is the budget to assign, or undefined
  // rule is the created/updated rule, or undefined
  onConfirm: (sourceId: string | undefined, budgetId: string | undefined, rule?: Rule) => void;
  onClose: () => void;
}

const Toggle: React.FC<{ on: boolean; onChange: (v: boolean) => void }> = ({ on, onChange }) => (
  <button
    role="switch"
    aria-checked={on}
    onClick={() => onChange(!on)}
    style={{
      position: 'relative', display: 'inline-flex', alignItems: 'center',
      width: 44, height: 24, borderRadius: 12,
      background: on ? '#0d7a6b' : '#d1d5db',
      border: 'none', cursor: 'pointer',
      transition: 'background 0.2s', flexShrink: 0,
    }}
  >
    <span style={{
      position: 'absolute',
      left: on ? 22 : 2,
      width: 20, height: 20, borderRadius: '50%',
      background: '#fff',
      transition: 'left 0.2s',
      boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
    }} />
  </button>
);

export const IncomeSourceModal: React.FC<Props> = ({
  transaction, incomeSources, incomeRulesBySourceId, onConfirm, onClose,
}) => {
  const [associate, setAssociate]         = useState(true);
  const [sourceId, setSourceId]           = useState(incomeSources[0]?.incomeSourceId ?? '');
  const [createRule, setCreateRule]       = useState(true);
  const [amountTolerance, setAmountTol]   = useState(50);
  const [saving, setSaving]               = useState(false);
  const [error, setError]                 = useState('');

  // Pre-populate tolerance from existing rule when source changes
  useEffect(() => {
    const existing = incomeRulesBySourceId[sourceId];
    setAmountTol(existing?.amountTolerance ?? 50);
  }, [sourceId, incomeRulesBySourceId]);

  const txnAmount = Math.abs(transaction.amount);
  const merchant  = transaction.merchantName || transaction.name;

  const handleConfirm = async () => {
    setSaving(true);
    setError('');
    try {
      if (!associate) {
        // User said no — category already set, nothing else to do
        onConfirm(undefined, undefined);
        return;
      }

      // Tag transaction with income budget sentinel
      const budgetId = INCOME_BUDGET_PREFIX + sourceId;
      await updateTransactionBudget(
        transaction.accountId,
        transaction.dateTransactionId,
        budgetId,
      );

      let savedRule: Rule | undefined;
      if (createRule) {
        const existing = incomeRulesBySourceId[sourceId];
        const ruleId = existing?.ruleId ?? crypto.randomUUID();
        savedRule = {
          ruleId,
          pattern:         merchant,
          categoryId:      INCOME_CATEGORY_ID,
          budgetId,
          priority:        10,
          amountMatch:     txnAmount,
          amountTolerance,
          incomeSourceId:  sourceId,
        };
        await putRule(savedRule);
      }

      onConfirm(sourceId, budgetId, savedRule);
    } catch (e: any) {
      setError(e.message ?? 'Failed to save');
      setSaving(false);
    }
  };

  return (
    <div style={s.overlay}>
      <div style={s.modal}>

        <div style={s.header}>
          <h3 style={s.title}>Income categorized</h3>
          <button style={s.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={s.body}>
          <p style={s.desc}>
            <strong>{merchant}</strong> — {fmtCurrency(txnAmount)}
          </p>

          {/* Associate toggle */}
          <div style={s.toggleRow}>
            <div style={{ flex: 1 }}>
              <div style={s.toggleQuestion}>Associate with an income source?</div>
              <div style={s.hint}>Links this transaction to a recurring income source for variance tracking.</div>
            </div>
            <Toggle on={associate} onChange={setAssociate} />
          </div>

          {/* Income source + rule fields — grayed out when associate=false */}
          <div style={{ opacity: associate ? 1 : 0.4, pointerEvents: associate ? 'auto' : 'none', display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.75rem' }}>
            <label style={s.fieldLabel}>
              Income source
              <select
                style={s.select}
                value={sourceId}
                onChange={e => setSourceId(e.target.value)}
                disabled={!associate}
              >
                {incomeSources.map(src => (
                  <option key={src.incomeSourceId} value={src.incomeSourceId}>
                    {src.name}
                  </option>
                ))}
              </select>
            </label>

            {/* Rule toggle */}
            <div style={s.toggleRow}>
              <div style={{ flex: 1 }}>
                <div style={s.toggleQuestion}>Automatically tag future matching transactions?</div>
                <div style={s.hint}>
                  Creates a rule matching <strong>{merchant}</strong> near {fmtCurrency(txnAmount)}.
                  Turn off for one-off income like a bonus or commission.
                </div>
              </div>
              <Toggle on={createRule} onChange={setCreateRule} />
            </div>

            {createRule && (
              <label style={s.fieldLabel}>
                Amount tolerance (±$)
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginTop: '0.1rem' }}>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={amountTolerance}
                    onChange={e => setAmountTol(parseFloat(e.target.value) || 0)}
                    style={s.numInput}
                    disabled={!associate}
                  />
                  <span style={s.hint}>
                    Matches deposits between {fmtCurrency(txnAmount - amountTolerance)} and {fmtCurrency(txnAmount + amountTolerance)}
                  </span>
                </div>
              </label>
            )}
          </div>

          {error && <p style={s.error}>{error}</p>}
        </div>

        <div style={s.footer}>
          <button style={s.cancelBtn} onClick={onClose} disabled={saving}>Cancel</button>
          <button
            style={saving ? s.confirmBtnDisabled : s.confirmBtn}
            onClick={handleConfirm}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
};

const s: Record<string, React.CSSProperties> = {
  overlay:         { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' },
  modal:           { background: '#fff', borderRadius: 12, width: '100%', maxWidth: 460, boxShadow: '0 8px 32px rgba(0,0,0,0.18)', display: 'flex', flexDirection: 'column' },
  header:          { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1rem 1.25rem 0.5rem', borderBottom: '1px solid #e2e8f0' },
  title:           { margin: 0, fontSize: '1rem', fontWeight: 600 },
  closeBtn:        { background: 'none', border: 'none', fontSize: '1.1rem', cursor: 'pointer', color: '#6b7280', padding: '2px 6px' },
  body:            { padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' },
  desc:            { margin: '0 0 0.25rem', fontSize: '0.9rem', color: '#2d3748' },
  toggleRow:       { display: 'flex', alignItems: 'center', gap: '1rem', padding: '0.6rem 0.75rem', background: '#f7fafc', borderRadius: 8, border: '1px solid #e2e8f0' },
  toggleQuestion:  { fontSize: '0.875rem', fontWeight: 600, color: '#2d3748', marginBottom: '0.15rem' },
  fieldLabel:      { display: 'flex', flexDirection: 'column' as const, gap: '0.3rem', fontSize: '0.85rem', fontWeight: 600, color: '#4a5568' },
  select:          { border: '1px solid #d1d5db', borderRadius: 6, padding: '0.4rem 0.6rem', fontSize: '0.9rem' },
  numInput:        { border: '1px solid #d1d5db', borderRadius: 6, padding: '0.4rem 0.6rem', fontSize: '0.9rem', width: 80 },
  hint:            { fontSize: '0.78rem', color: '#6b7280', margin: 0 },
  error:           { color: '#dc2626', fontSize: '0.85rem', marginTop: '0.5rem' },
  footer:          { display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', padding: '0.75rem 1.25rem', borderTop: '1px solid #e2e8f0' },
  cancelBtn:          { background: 'transparent', color: '#0d7a6b', border: '1px solid #0d7a6b', borderRadius: 6, padding: '0.4rem 1rem', cursor: 'pointer', fontSize: '0.875rem' },
  confirmBtn:         { background: '#0d7a6b', color: '#fff', border: 'none', borderRadius: 6, padding: '0.4rem 1rem', cursor: 'pointer', fontSize: '0.875rem' },
  confirmBtnDisabled: { background: '#a0aec0', color: '#fff', border: 'none', borderRadius: 6, padding: '0.4rem 1rem', cursor: 'default', fontSize: '0.875rem' },
};

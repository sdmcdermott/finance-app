import React, { useState, useEffect } from 'react';
import {
  SuggestFixedCost, SuggestFixedCostsResult, MBFixedCost,
  suggestFixedCosts, putRule, applyRules,
} from '../api/client';
import { fmtCurrency } from '../utils/dates';

const uuidv4 = () => crypto.randomUUID();

const FREQ_LABELS: Record<string, string> = {
  weekly:      'Weekly',
  biweekly:    'Bi-weekly',
  semimonthly: 'Semi-monthly',
  monthly:     'Monthly',
  quarterly:   'Quarterly',
  annually:    'Annually',
};

interface Props {
  onConfirm: (added: MBFixedCost[]) => void;
  onClose: () => void;
}

export const SuggestFixedCostsModal: React.FC<Props> = ({ onConfirm, onClose }) => {
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [result, setResult]       = useState<SuggestFixedCostsResult | null>(null);
  const [selected, setSelected]   = useState<Set<number>>(new Set());
  const [saving, setSaving]       = useState(false);

  const suggestions: SuggestFixedCost[] = result?.suggestions ?? [];

  useEffect(() => {
    suggestFixedCosts()
      .then(r => { setResult(r); setSelected(new Set()); })
      .catch(() => setError('Failed to load suggestions.'))
      .finally(() => setLoading(false));
  }, []);

  const toggle = (i: number) => setSelected(prev => {
    const next = new Set(prev);
    next.has(i) ? next.delete(i) : next.add(i);
    return next;
  });

  const toggleAll = () => {
    if (selected.size === suggestions.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(suggestions.map((_, i) => i)));
    }
  };

  const handleConfirm = async () => {
    if (selected.size === 0) { onClose(); return; }
    setSaving(true);
    setError('');

    const added: MBFixedCost[] = [];
    try {
      for (const i of Array.from(selected)) {
        const s = suggestions[i];
        const ruleId = uuidv4();

        await putRule({
          ruleId,
          pattern:         s.merchant,
          categoryId:      '',
          budgetId:        '__master_budget__',
          priority:        50,
          amountMatch:     s.meanAmount,
          amountTolerance: 5,
          dayOfMonth:      s.meanDay,
          dayTolerance:    1,
        });

        added.push({
          id:        uuidv4(),
          name:      s.merchant,
          amount:    s.meanAmount,
          frequency: s.frequency,
          ruleId,
        });
      }
      onConfirm(added);
    } catch {
      setError('Failed to save rules. Some may have been saved.');
      setSaving(false);
      return;
    }

    // Apply all rules to existing transactions now that new rules are saved
    try {
      await applyRules();
    } catch {
      // Non-fatal — rules will apply on next sync
    }
    setSaving(false);
  };

  // Data window banner content
  const windowBanner = (() => {
    if (!result || result.fullWindow) return null;
    const mo = result.monthsCovered;
    const moStr = mo < 1 ? 'less than 1 month' : `~${Math.round(mo)} month${Math.round(mo) !== 1 ? 's' : ''}`;
    return (
      <div style={s.windowBanner}>
        <strong>Limited data:</strong> only {moStr} of transactions available (oldest: {result.oldestDate}).
        For best results, 6 months of data is recommended. Frequency estimates for low-occurrence
        merchants are marked <span style={s.lowBadge}>low confidence</span>.
      </div>
    );
  })();

  return (
    <div style={s.overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={s.modal}>
        <div style={s.header}>
          <h3 style={s.title}>Suggest from Transactions</h3>
          <button style={s.closeBtn} onClick={onClose}>✕</button>
        </div>

        <p style={s.desc}>
          Recurring charges found in your transaction history — uncategorized and unbudgeted only.
          Select any to add as fixed costs and create a matching rule.
        </p>

        {windowBanner}

        {loading && <p style={s.muted}>Scanning transactions…</p>}
        {error   && <p style={s.errMsg}>{error}</p>}

        {!loading && suggestions.length === 0 && !error && (
          <p style={s.muted}>No recurring patterns found in uncategorized transactions.</p>
        )}

        {suggestions.length > 0 && (
          <>
            <div style={s.selectAll}>
              <label style={s.checkLabel}>
                <input
                  type="checkbox"
                  checked={selected.size === suggestions.length}
                  onChange={toggleAll}
                  style={{ marginRight: 6 }}
                />
                Select all ({suggestions.length})
              </label>
            </div>

            <div style={s.listWrap}>
              <table style={s.table}>
                <thead>
                  <tr>
                    <th style={s.th}></th>
                    <th style={s.th}>Merchant</th>
                    <th style={{ ...s.th, textAlign: 'center' }}>Avg day</th>
                    <th style={{ ...s.th, textAlign: 'right' }}>Avg amount</th>
                    <th style={s.th}>Frequency</th>
                    <th style={{ ...s.th, textAlign: 'center' }}>Seen</th>
                    <th style={s.th}>Recent dates</th>
                  </tr>
                </thead>
                <tbody>
                  {suggestions.map((s2, i) => (
                    <tr
                      key={i}
                      style={{ ...s.tr, background: selected.has(i) ? '#f0faf7' : undefined, cursor: 'pointer' }}
                      onClick={() => toggle(i)}
                    >
                      <td style={s.td}>
                        <input
                          type="checkbox"
                          checked={selected.has(i)}
                          onChange={() => toggle(i)}
                          onClick={e => e.stopPropagation()}
                        />
                      </td>
                      <td style={{ ...s.td, fontWeight: 500 }}>{s2.merchant}</td>
                      <td style={{ ...s.td, textAlign: 'center' }}>{s2.meanDay}</td>
                      <td style={{ ...s.td, textAlign: 'right' }}>{fmtCurrency(s2.meanAmount)}</td>
                      <td style={s.td}>
                        {FREQ_LABELS[s2.frequency] ?? s2.frequency}
                        {s2.confidence === 'low' && (
                          <span style={s.lowBadge} title="Frequency estimate may be less reliable due to limited data">
                            low confidence
                          </span>
                        )}
                      </td>
                      <td style={{ ...s.td, textAlign: 'center' }}>{s2.occurrences}×</td>
                      <td style={{ ...s.td, fontSize: '0.78rem', color: '#6b7280' }}>
                        {s2.sampleDates.slice(-3).join(', ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div style={s.footer}>
          <button style={s.cancelBtn} onClick={onClose} disabled={saving}>Cancel</button>
          <button
            style={selected.size > 0 ? s.confirmBtn : s.confirmBtnDisabled}
            onClick={handleConfirm}
            disabled={saving || selected.size === 0}
          >
            {saving ? 'Saving…' : `Add ${selected.size} cost${selected.size !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
};

const s: Record<string, React.CSSProperties> = {
  overlay:   { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' },
  modal:     { background: '#fff', borderRadius: 12, width: '100%', maxWidth: 780, maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' },
  header:    { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1rem 1.25rem 0.5rem', borderBottom: '1px solid #e2e8f0' },
  title:     { margin: 0, fontSize: '1rem', fontWeight: 600 },
  closeBtn:  { background: 'none', border: 'none', fontSize: '1.1rem', cursor: 'pointer', color: '#6b7280', padding: '2px 6px' },
  desc:      { margin: '0.75rem 1.25rem 0.25rem', fontSize: '0.85rem', color: '#4a5568' },
  muted:     { margin: '0.75rem 1.25rem', color: '#6b7280', fontSize: '0.875rem' },
  errMsg:    { margin: '0.5rem 1.25rem', color: '#dc2626', fontSize: '0.875rem' },
  windowBanner: {
    margin: '0.5rem 1.25rem 0', padding: '0.6rem 0.8rem',
    background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 6,
    fontSize: '0.82rem', color: '#92400e', lineHeight: 1.5,
  },
  lowBadge:  { marginLeft: 6, fontSize: '0.7rem', background: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d', borderRadius: 4, padding: '1px 5px', verticalAlign: 'middle', whiteSpace: 'nowrap' as const },
  selectAll: { padding: '0.5rem 1.25rem', borderBottom: '1px solid #e2e8f0' },
  checkLabel:{ display: 'flex', alignItems: 'center', fontSize: '0.85rem', color: '#374151', cursor: 'pointer' },
  listWrap:  { overflowY: 'auto', flex: 1, padding: '0 1.25rem' },
  table:     { width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' },
  th:        { padding: '0.5rem 0.5rem', background: '#f7fafc', borderBottom: '2px solid #e2e8f0', textAlign: 'left', fontWeight: 600, color: '#4a5568', whiteSpace: 'nowrap' },
  tr:        { borderBottom: '1px solid #e2e8f0' },
  td:        { padding: '0.5rem 0.5rem', color: '#2d3748', verticalAlign: 'middle' },
  footer:    { display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', padding: '0.75rem 1.25rem', borderTop: '1px solid #e2e8f0' },
  cancelBtn:          { background: 'transparent', color: '#0d7a6b', border: '1px solid #0d7a6b', borderRadius: 6, padding: '0.4rem 1rem', cursor: 'pointer', fontSize: '0.875rem' },
  confirmBtn:         { background: '#0d7a6b', color: '#fff', border: 'none', borderRadius: 6, padding: '0.4rem 1rem', cursor: 'pointer', fontSize: '0.875rem' },
  confirmBtnDisabled: { background: '#a0aec0', color: '#fff', border: 'none', borderRadius: 6, padding: '0.4rem 1rem', cursor: 'default', fontSize: '0.875rem' },
};

import React, { useState, useEffect } from 'react';
import {
  SuggestFixedCost, SuggestFixedCostsResult, MBFixedCost, Rule,
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
  existingFixedCosts: MBFixedCost[];
  existingRules: Rule[];
}

export const SuggestFixedCostsModal: React.FC<Props> = ({
  onConfirm, onClose, existingFixedCosts, existingRules,
}) => {
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [result, setResult]     = useState<SuggestFixedCostsResult | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [saving, setSaving]     = useState(false);

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

  // Returns the name of the first existing fixed cost whose rule pattern
  // overlaps with this suggestion's merchant string, or null if none.
  const matchingFixedCostName = (sg: SuggestFixedCost): string | null => {
    for (const fc of existingFixedCosts) {
      if (!fc.ruleId) continue;
      const rule = existingRules.find(r => r.ruleId === fc.ruleId);
      if (!rule) continue;
      const pattern  = rule.pattern.toLowerCase();
      const merchant = sg.merchant.toLowerCase();
      if (merchant.includes(pattern) || pattern.includes(merchant)) {
        return fc.name || rule.pattern;
      }
    }
    return null;
  };

  const handleConfirm = async () => {
    if (selected.size === 0) { onClose(); return; }
    setSaving(true);
    setError('');

    const added: MBFixedCost[] = [];
    try {
      for (const i of Array.from(selected)) {
        const sg = suggestions[i];
        const ruleId = uuidv4();

        const rulePayload = {
          ruleId,
          pattern:         sg.merchant,
          categoryId:      '',
          budgetId:        '__master_budget__',
          priority:        50,
          amountMatch:     sg.meanAmount,
          amountTolerance: 5,
          dayOfMonth:      sg.meanDay,
          dayTolerance:    1,
        };
        const savedRule = await putRule(rulePayload);
        console.log('[SuggestFixedCosts] putRule response', savedRule);

        added.push({
          id:        uuidv4(),
          name:      sg.merchant,
          amount:    sg.meanAmount,
          frequency: sg.frequency,
          ruleId,
        });
      }
      onConfirm(added);
    } catch (err) {
      console.error('[SuggestFixedCosts] putRule failed', err);
      setError('Failed to save rules. Some may have been saved.');
      setSaving(false);
      return;
    }

    try {
      await applyRules();
    } catch {
      // Non-fatal — rules will apply on next sync
    }
    setSaving(false);
  };

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
    <div style={s.overlay}>
      <div style={s.modal} className="suggest-modal">
        <div style={s.header}>
          <h3 style={s.title}>Suggest from Transactions</h3>
          <button style={s.closeBtn} onClick={onClose}>✕</button>
        </div>

        <p style={s.desc}>
          Recurring charges found in your transaction history, including transactions you've already
          categorized or budgeted. Select any to add as fixed costs and create a matching rule.
        </p>

        {windowBanner}

        {loading && <p style={s.muted}>Scanning transactions…</p>}
        {error   && <p style={s.errMsg}>{error}</p>}

        {!loading && suggestions.length === 0 && !error && (
          <p style={s.muted}>No recurring patterns found in your transaction history.</p>
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
              {/* ── Desktop table ── */}
              <table style={s.table} className="suggest-table">
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
                  {suggestions.map((sg, i) => {
                    const existingName = matchingFixedCostName(sg);
                    return (
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
                        <td style={{ ...s.td, fontWeight: 500 }}>
                          {sg.merchant}
                          {existingName && (
                            <span style={s.existsBadge} title={`Already tracked as "${existingName}"`}>
                              already a fixed cost
                            </span>
                          )}
                        </td>
                        <td style={{ ...s.td, textAlign: 'center' }}>{sg.meanDay}</td>
                        <td style={{ ...s.td, textAlign: 'right' }}>{fmtCurrency(sg.meanAmount)}</td>
                        <td style={s.td}>
                          {FREQ_LABELS[sg.frequency] ?? sg.frequency}
                          {sg.confidence === 'low' && (
                            <span style={s.lowBadge} title="Frequency estimate may be less reliable due to limited data">
                              low confidence
                            </span>
                          )}
                        </td>
                        <td style={{ ...s.td, textAlign: 'center' }}>{sg.occurrences}×</td>
                        <td style={{ ...s.td, fontSize: '0.78rem', color: '#6b7280' }}>
                          {sg.sampleDates.slice(-3).join(', ')}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {/* ── Mobile cards ── */}
              <div className="suggest-cards">
                {suggestions.map((sg, i) => {
                  const existingName = matchingFixedCostName(sg);
                  return (
                    <div
                      key={i}
                      className={`suggest-card${selected.has(i) ? ' selected' : ''}`}
                      onClick={() => toggle(i)}
                    >
                      <div className="suggest-card-row">
                        <input
                          type="checkbox"
                          checked={selected.has(i)}
                          onChange={() => toggle(i)}
                          onClick={e => e.stopPropagation()}
                          style={{ marginRight: 8, flexShrink: 0 }}
                        />
                        <span className="suggest-card-merchant">{sg.merchant}</span>
                        <span className="suggest-card-amount">{fmtCurrency(sg.meanAmount)}</span>
                      </div>
                      <div className="suggest-card-meta">
                        <span>Day {sg.meanDay}</span>
                        <span style={{ color: '#cbd5e0' }}>·</span>
                        <span>{FREQ_LABELS[sg.frequency] ?? sg.frequency}</span>
                        <span style={{ color: '#cbd5e0' }}>·</span>
                        <span>{sg.occurrences}×</span>
                        {sg.confidence === 'low' && (
                          <span style={s.lowBadge}>low confidence</span>
                        )}
                        {existingName && (
                          <span style={s.existsBadge} title={`Already tracked as "${existingName}"`}>
                            already a fixed cost
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: '#a0aec0', marginTop: '0.25rem' }}>
                        {sg.sampleDates.slice(-3).join(', ')}
                      </div>
                    </div>
                  );
                })}
              </div>
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
  lowBadge:    { marginLeft: 6, fontSize: '0.7rem', background: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d', borderRadius: 4, padding: '1px 5px', verticalAlign: 'middle', whiteSpace: 'nowrap' as const },
  existsBadge: { marginLeft: 6, fontSize: '0.7rem', background: '#e0f2fe', color: '#0369a1', border: '1px solid #bae6fd', borderRadius: 4, padding: '1px 5px', verticalAlign: 'middle', whiteSpace: 'nowrap' as const },
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

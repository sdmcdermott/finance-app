import React, { useState, useEffect, useCallback } from 'react';
import { useData } from '../auth/DataContext';
import { useDirtyGuard } from '../auth/DirtyGuardContext';
import {
  MasterBudget, MBIncomeSource, MBFixedCost, MBBucket,
  getMasterBudget, putMasterBudget, getTransactions, Transaction,
} from '../api/client';
import { fmtCurrency } from '../utils/dates';
import { MoneyInput } from '../components/MoneyInput';
import { SuggestFixedCostsModal } from '../components/SuggestFixedCostsModal';

// ── BucketMoneyInput: formats on blur, commits only on blur ───────────────────

function fmtMoney(v: number): string {
  if (!v) return '';
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const BucketMoneyInput: React.FC<{ value: number; onCommit: (v: number) => void }> = ({ value, onCommit }) => {
  const [focused, setFocused] = useState(false);
  const [raw, setRaw] = useState('');

  const display = focused ? raw : fmtMoney(value);

  return (
    <input
      type="text"
      inputMode="decimal"
      value={display}
      placeholder="$0.00"
      style={{ maxWidth: 120, textAlign: 'right', padding: '0.35rem 0.5rem', border: '1px solid #cbd5e0', borderRadius: 5, fontSize: '0.875rem', width: '100%', boxSizing: 'border-box' }}
      onFocus={() => { setFocused(true); setRaw(value ? String(value) : ''); }}
      onChange={e => setRaw(e.target.value)}
      onBlur={() => {
        setFocused(false);
        onCommit(parseFloat(raw.replace(/[^0-9.]/g, '')) || 0);
        setRaw('');
      }}
    />
  );
};
const BucketPercentInput: React.FC<{ value: number; onCommit: (v: number) => void }> = ({ value, onCommit }) => {
  const [focused, setFocused] = useState(false);
  const [raw, setRaw] = useState('');

  const display = focused ? raw : (value > 0 ? +(value * 100).toFixed(2) : '');

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
      <input
        style={{ maxWidth: 70, textAlign: 'right', padding: '0.35rem 0.5rem', border: '1px solid #cbd5e0', borderRadius: 5, fontSize: '0.875rem', boxSizing: 'border-box' }}
        type="text"
        inputMode="decimal"
        value={display}
        placeholder="0"
        onFocus={() => { setFocused(true); setRaw(value > 0 ? String(+(value * 100).toFixed(2)) : ''); }}
        onChange={e => setRaw(e.target.value)}
        onBlur={() => {
          setFocused(false);
          onCommit((parseFloat(raw) || 0) / 100);
          setRaw('');
        }}
      />
      <span style={{ color: '#6b7280', fontSize: '0.85rem' }}>%</span>
    </div>
  );
};

const uuidv4 = () => crypto.randomUUID();

// ── Cluster master-budget transactions into inferred fixed costs ───────────────

interface TxnFixedCost {
  merchant: string;
  meanAmount: number;
  frequency: string;
  occurrences: number;
}

function clusterMasterBudgetTxns(txns: Transaction[]): TxnFixedCost[] {
  const mb = txns.filter(t => t.budgetId === '__master_budget__' && t.amount > 0);
  type Cluster = { merchant: string; txns: Transaction[] };
  const assigned = new Array(mb.length).fill(false);
  const clusters: Cluster[] = [];

  for (let i = 0; i < mb.length; i++) {
    if (assigned[i]) continue;
    const t = mb[i];
    const merchant = t.merchantName || t.name || '';
    if (!merchant) continue;
    const cl: Cluster = { merchant, txns: [t] };
    assigned[i] = true;

    for (let j = i + 1; j < mb.length; j++) {
      if (assigned[j]) continue;
      const u = mb[j];
      const uMerchant = u.merchantName || u.name || '';
      if (merchant.toLowerCase() !== uMerchant.toLowerCase()) continue;
      const di = new Date(t.date).getDate();
      const dj = new Date(u.date).getDate();
      let dd = Math.abs(di - dj);
      if (dd > 15) dd = 30 - dd;
      if (dd > 1) continue;
      if (Math.abs(Math.abs(t.amount) - Math.abs(u.amount)) > 5) continue;
      cl.txns.push(u);
      assigned[j] = true;
    }
    clusters.push(cl);
  }

  return clusters.map(cl => {
    const n = cl.txns.length;
    const meanAmt = Math.round(cl.txns.reduce((s, t) => s + Math.abs(t.amount), 0) / n * 100) / 100;
    const freq = n >= 24 ? 'weekly' : n >= 11 ? 'biweekly' : n >= 10 ? 'semimonthly'
      : n >= 3 ? 'monthly' : n === 2 ? 'quarterly' : 'annually';
    return { merchant: cl.merchant, meanAmount: meanAmt, frequency: freq, occurrences: n };
  });
}

// ── Frequency helpers ──────────────────────────────────────────────────────────

const FREQ_LABELS: Record<string, string> = {
  weekly:      'Weekly',
  biweekly:    'Bi-weekly',
  semimonthly: 'Semi-monthly',
  monthly:     'Monthly',
  quarterly:   'Quarterly',
  annually:    'Annually',
};

const PERIODS_PER_MONTH: Record<string, number> = {
  weekly:      52 / 12,
  biweekly:    26 / 12,
  semimonthly: 2,
  monthly:     1,
  quarterly:   1 / 3,
  annually:    1 / 12,
};

function toMonthly(amount: number, freq: string): number {
  return amount * (PERIODS_PER_MONTH[freq] ?? 1);
}

// ── Toggle switch (reused from IncomePage pattern) ────────────────────────────

const Toggle: React.FC<{ on: boolean; onChange: (v: boolean) => void }> = ({ on, onChange }) => (
  <span
    style={{
      display: 'inline-block', width: 36, height: 20, borderRadius: 10, cursor: 'pointer',
      background: on ? '#0d7a6b' : '#cbd5e0', position: 'relative', flexShrink: 0,
      transition: 'background 0.2s',
    }}
    onClick={() => onChange(!on)}
  >
    <span style={{
      position: 'absolute', top: 3, left: on ? 19 : 3,
      width: 14, height: 14, borderRadius: '50%', background: '#fff',
      boxShadow: '0 1px 3px rgba(0,0,0,0.2)', transition: 'left 0.2s',
    }} />
  </span>
);

// ── Main component ─────────────────────────────────────────────────────────────

const MasterBudgetPage: React.FC = () => {
  const { incomeSources, budgets } = useData();

  const [mb, setMb] = useState<MasterBudget | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [showSuggest, setShowSuggest] = useState(false);
  const [txnFixedCosts, setTxnFixedCosts] = useState<TxnFixedCost[]>([]);
  const [showTxnCosts, setShowTxnCosts] = useState(false);

  // Register dirty check with nav guard; unregister on unmount
  const dirtyGuard = useDirtyGuard();
  const dirtyRef = useCallback(() => dirty, [dirty]);
  useEffect(() => {
    dirtyGuard.register(dirtyRef);
    return () => dirtyGuard.unregister();
  }, [dirtyGuard, dirtyRef]);

  // Block browser tab close/refresh when dirty
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); } };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  // Track percent-mode per bucket by id (avoids inferring from value=0 which breaks on new buckets)
  const [percentMode, setPercentMode] = useState<Set<string>>(new Set());
  const [remainingMode, setRemainingMode] = useState<Set<string>>(new Set());

  // Load once on mount
  useEffect(() => {
    getMasterBudget()
      .then(data => {
        // Merge: ensure every income source has an MBIncomeSource entry
        setMb(() => {
          const existingIds = new Set((data.incomeSources ?? []).map(s => s.incomeSourceId));
          const merged: MBIncomeSource[] = [
            ...(data.incomeSources ?? []),
            ...incomeSources
              .filter(s => !existingIds.has(s.incomeSourceId))
              .map(s => ({ incomeSourceId: s.incomeSourceId, monthlyOverride: 0, enabled: true })),
          ];
          return { ...data, incomeSources: merged };
        });
        // Init percent mode from saved buckets
        setPercentMode(new Set(
          (data.buckets ?? []).filter(b => b.percent > 0).map(b => b.id)
        ));
      })
      .finally(() => setLoading(false));

    // Fetch last 6 months of transactions to find master-budget-assigned ones
    const end = new Date();
    const start = new Date(); start.setMonth(start.getMonth() - 6);
    getTransactions({
      startDate: start.toISOString().slice(0, 10),
      endDate:   end.toISOString().slice(0, 10),
    }).then(txns => {
      const clusters = clusterMasterBudgetTxns(txns);
      setTxnFixedCosts(clusters);
      // Auto-expand if there are clusters not yet added as managed fixed costs
      // We check against the mb loaded above; safe because both fetches are in the same effect
      setMb(prev => {
        if (prev && clusters.some(tc => !prev.fixedCosts.some(fc => fc.name.toLowerCase() === tc.merchant.toLowerCase()))) {
          setShowTxnCosts(true);
        }
        return prev;
      });
    }).catch(() => {}); // non-fatal
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Also add any income sources not yet in mb when incomeSources loads
  useEffect(() => {
    if (!mb) return;
    const existingIds = new Set(mb.incomeSources.map(s => s.incomeSourceId));
    const newEntries = incomeSources
      .filter(s => !existingIds.has(s.incomeSourceId))
      .map(s => ({ incomeSourceId: s.incomeSourceId, monthlyOverride: 0, enabled: true }));
    if (newEntries.length > 0) {
      setMb(prev => prev ? { ...prev, incomeSources: [...prev.incomeSources, ...newEntries] } : prev);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomeSources]);

  const patch = useCallback((update: Partial<MasterBudget>) => {
    setMb(prev => prev ? { ...prev, ...update } : prev);
    setDirty(true);
  }, []);

  const save = async () => {
    if (!mb) return;
    setSaving(true);
    setError('');
    try {
      const saved = await putMasterBudget({
        incomeSources: mb.incomeSources,
        fixedCosts:    mb.fixedCosts,
        buckets:       mb.buckets,
      });
      setMb(saved);
      setDirty(false);
    } catch {
      setError('Save failed.');
    } finally {
      setSaving(false);
    }
  };

  // ── Derived numbers ──────────────────────────────────────────────────────────

  // Monthly net pay per source (from lastNetPay or gross)
  const monthlyNetPay = useCallback((incomeSourceId: string): number => {
    const src = incomeSources.find(s => s.incomeSourceId === incomeSourceId);
    if (!src) return 0;
    const netPerPeriod = src.lastNetPay?.netPay ?? src.grossAmount;
    return toMonthly(netPerPeriod, src.frequency);
  }, [incomeSources]);

  const effectiveMonthlyIncome = (mbi: MBIncomeSource): number => {
    if (!mbi.enabled) return 0;
    return mbi.monthlyOverride > 0 ? mbi.monthlyOverride : monthlyNetPay(mbi.incomeSourceId);
  };

  const totalIncome = mb
    ? mb.incomeSources.reduce((s, mbi) => s + effectiveMonthlyIncome(mbi), 0)
    : 0;

  const totalFixed = mb
    ? mb.fixedCosts.reduce((s, fc) => s + toMonthly(fc.amount, fc.frequency), 0)
    : 0;

  const discretionary = totalIncome - totalFixed;

  const totalAllocated = mb
    ? (() => {
        // Sum non-remaining buckets first, then remaining = what's left
        const nonRemaining = mb.buckets
          .filter(b => !remainingMode.has(b.id))
          .reduce((s, b) => s + (percentMode.has(b.id) ? discretionary * b.percent : b.amountMonthly), 0);
        const hasRemaining = mb.buckets.some(b => remainingMode.has(b.id));
        return hasRemaining ? discretionary : nonRemaining;
      })()
    : 0;

  const unallocated = discretionary - totalAllocated;

  // ── Income source helpers ────────────────────────────────────────────────────

  const updateMBIS = (id: string, patch: Partial<MBIncomeSource>) => {
    if (!mb) return;
    const updated = mb.incomeSources.map(s =>
      s.incomeSourceId === id ? { ...s, ...patch } : s
    );
    patch_mb({ incomeSources: updated });
  };

  // Rename to avoid collision with outer patch
  const patch_mb = (update: Partial<MasterBudget>) => patch(update);

  // ── Fixed cost helpers ───────────────────────────────────────────────────────

  const addFixedCost = () => {
    if (!mb) return;
    const fc: MBFixedCost = { id: uuidv4(), name: '', amount: 0, frequency: 'monthly' };
    patch_mb({ fixedCosts: [...mb.fixedCosts, fc] });
  };

  const updateFixedCost = (id: string, p: Partial<MBFixedCost>) => {
    if (!mb) return;
    patch_mb({ fixedCosts: mb.fixedCosts.map(fc => fc.id === id ? { ...fc, ...p } : fc) });
  };

  const removeFixedCost = (id: string) => {
    if (!mb) return;
    patch_mb({ fixedCosts: mb.fixedCosts.filter(fc => fc.id !== id) });
  };

  // ── Bucket helpers ───────────────────────────────────────────────────────────

  const addBucket = () => {
    if (!mb) return;
    const b: MBBucket = { id: uuidv4(), name: '', amountMonthly: 0, percent: 0 };
    patch_mb({ buckets: [...mb.buckets, b] });
  };

  const updateBucket = (id: string, p: Partial<MBBucket>) => {
    if (!mb) return;
    patch_mb({ buckets: mb.buckets.map(b => b.id === id ? { ...b, ...p } : b) });
  };

  const removeBucket = (id: string) => {
    if (!mb) return;
    patch_mb({ buckets: mb.buckets.filter(b => b.id !== id) });
    setPercentMode(prev => { const next = new Set(prev); next.delete(id); return next; });
    setRemainingMode(prev => { const next = new Set(prev); next.delete(id); return next; });
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  if (loading) return <div style={s.page}><p style={s.muted}>Loading…</p></div>;

  if (!mb) return <div style={s.page}><p style={s.error}>{error || 'No data.'}</p></div>;

  return (
    <>
    <div style={s.page}>
      <div className="page-header">
        <h2 style={s.heading}>Master Budget</h2>
        <button
          style={dirty ? s.primaryBtn : s.primaryBtnDisabled}
          onClick={save}
          disabled={!dirty || saving}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {error && <p style={s.error}>{error}</p>}

      {/* ── Summary bar ─────────────────────────────────────────────────── */}
      <div style={s.summaryBar}>
        <SummaryCell label="Monthly Income" value={totalIncome} color="#0d7a6b" />
        <span style={s.summaryArrow}>−</span>
        <SummaryCell label="Fixed Costs" value={totalFixed} color="#dc2626" />
        <span style={s.summaryArrow}>=</span>
        <SummaryCell label="Discretionary" value={discretionary} color={discretionary >= 0 ? '#0d7a6b' : '#dc2626'} />
        <span style={s.summaryArrow}>−</span>
        <SummaryCell label="Allocated" value={totalAllocated} color="#374151" />
        <span style={s.summaryArrow}>=</span>
        <SummaryCell
          label="Unallocated"
          value={unallocated}
          color={Math.abs(unallocated) < 0.01 ? '#059669' : unallocated < 0 ? '#dc2626' : '#374151'}
        />
      </div>

      {/* ── Income ──────────────────────────────────────────────────────── */}
      <Section title="Income Sources">
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>Enabled</th>
              <th style={s.th}>Name</th>
              <th style={s.th}>Frequency</th>
              <th style={{ ...s.th, textAlign: 'right' }}>Net Pay / Period</th>
              <th style={{ ...s.th, textAlign: 'right' }}>Monthly Net Pay</th>
              <th style={{ ...s.th, textAlign: 'right' }}>Monthly Override</th>
              <th style={s.th}>Track variance in budget</th>
            </tr>
          </thead>
          <tbody>
            {mb.incomeSources.map(mbi => {
              const src = incomeSources.find(s => s.incomeSourceId === mbi.incomeSourceId);
              if (!src) return null;
              const netPerPeriod = src.lastNetPay?.netPay ?? src.grossAmount;
              const monthly = monthlyNetPay(mbi.incomeSourceId);
              return (
                <tr key={mbi.incomeSourceId} style={s.tr}>
                  <td style={s.td}>
                    <Toggle on={mbi.enabled} onChange={v => updateMBIS(mbi.incomeSourceId, { enabled: v })} />
                  </td>
                  <td style={{ ...s.td, opacity: mbi.enabled ? 1 : 0.4 }}>{src.name}</td>
                  <td style={{ ...s.td, opacity: mbi.enabled ? 1 : 0.4 }}>
                    {FREQ_LABELS[src.frequency] ?? src.frequency}
                  </td>
                  <td style={{ ...s.td, textAlign: 'right', opacity: mbi.enabled ? 1 : 0.4 }}>
                    {fmtCurrency(netPerPeriod)}
                    {!src.lastNetPay && <span style={s.estBadge} title="No net pay calculated; using gross pay">gross</span>}
                  </td>
                  <td style={{ ...s.td, textAlign: 'right', opacity: mbi.enabled ? 1 : 0.4 }}>
                    {fmtCurrency(monthly)}
                  </td>
                  <td style={{ ...s.td, textAlign: 'right' }}>
                    <MoneyInput
                      value={mbi.monthlyOverride}
                      onChange={v => updateMBIS(mbi.incomeSourceId, { monthlyOverride: v })}
                      placeholder="Optional override"
                      style={{ maxWidth: 140, textAlign: 'right' }}
                    />
                  </td>
                  <td style={s.td}>
                    <select
                      style={s.freqSelect}
                      value={mbi.linkedBudgetId ?? ''}
                      onChange={e => updateMBIS(mbi.incomeSourceId, { linkedBudgetId: e.target.value || undefined })}
                    >
                      <option value="">— none —</option>
                      {budgets.filter(b => b.budgetType === 'checkbook').map(b => (
                        <option key={b.budgetId} value={b.budgetId}>{b.name}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {mb.incomeSources.length === 0 && (
          <p style={s.muted}>No income sources yet. Add them on the Income page.</p>
        )}
      </Section>

      {/* ── Fixed Costs ─────────────────────────────────────────────────── */}
      <Section title="Fixed / Recurring Costs" action={
        <button style={s.suggestLink} onClick={() => setShowSuggest(true)}>
          (suggest from transactions)
        </button>
      }>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>Name</th>
              <th style={s.th}>Frequency</th>
              <th style={{ ...s.th, textAlign: 'right' }}>Amount</th>
              <th style={{ ...s.th, textAlign: 'right' }}>Monthly</th>
              <th style={s.th}>Track variance in budget</th>
              <th style={s.th}></th>
            </tr>
          </thead>
          <tbody>
            {mb.fixedCosts.map(fc => (
              <tr key={fc.id} style={s.tr}>
                <td style={s.td}>
                  <input
                    style={s.nameInput}
                    value={fc.name}
                    onChange={e => updateFixedCost(fc.id, { name: e.target.value })}
                    placeholder="e.g. Mortgage"
                  />
                </td>
                <td style={s.td}>
                  <select
                    style={s.freqSelect}
                    value={fc.frequency}
                    onChange={e => updateFixedCost(fc.id, { frequency: e.target.value as MBFixedCost['frequency'] })}
                  >
                    {Object.entries(FREQ_LABELS).map(([v, l]) => (
                      <option key={v} value={v}>{l}</option>
                    ))}
                  </select>
                </td>
                <td style={{ ...s.td, textAlign: 'right' }}>
                  <MoneyInput
                    value={fc.amount}
                    onChange={v => updateFixedCost(fc.id, { amount: v })}
                    style={{ maxWidth: 130, textAlign: 'right' }}
                  />
                </td>
                <td style={{ ...s.td, textAlign: 'right', color: '#dc2626' }}>
                  {fmtCurrency(toMonthly(fc.amount, fc.frequency))}
                </td>
                <td style={s.td}>
                  <select
                    style={s.freqSelect}
                    value={fc.linkedBudgetId ?? ''}
                    onChange={e => updateFixedCost(fc.id, { linkedBudgetId: e.target.value || undefined })}
                  >
                    <option value="">— none —</option>
                    {budgets.filter(b => b.budgetType === 'checkbook').map(b => (
                      <option key={b.budgetId} value={b.budgetId}>{b.name}</option>
                    ))}
                  </select>
                </td>
                <td style={{ ...s.td, textAlign: 'right' }}>
                  <button style={s.removeBtn} onClick={() => removeFixedCost(fc.id)} title="Remove">✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button style={s.addBtn} onClick={addFixedCost}>+ Add cost</button>

        {/* Txn-assigned master budget costs — read-only inferred rows */}
        {txnFixedCosts.length > 0 && (
          <div style={{ marginTop: '1rem' }}>
            <button
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: '#0d7a6b', fontWeight: 600, fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}
              onClick={() => setShowTxnCosts(v => !v)}
            >
              <span style={{ fontSize: '0.75rem' }}>{showTxnCosts ? '▼' : '▶'}</span>
              From transactions
              {!showTxnCosts && txnFixedCosts.some(tc => !mb.fixedCosts.some(fc => fc.name.toLowerCase() === tc.merchant.toLowerCase())) && (
                <span style={{ background: '#0d7a6b', color: '#fff', borderRadius: '999px', fontSize: '0.7rem', padding: '1px 7px', marginLeft: '0.25rem' }}>
                  {txnFixedCosts.filter(tc => !mb.fixedCosts.some(fc => fc.name.toLowerCase() === tc.merchant.toLowerCase())).length} new
                </span>
              )}
            </button>
            {showTxnCosts && (
              <>
                <p style={{ ...s.sectionNote, margin: '0.4rem 0' }}>
                  These merchants have transactions assigned to Master Budget. Click <em>Add</em> to convert to a managed fixed cost.
                </p>
                <table style={s.table}>
                  <thead>
                    <tr>
                      <th style={s.th}>Merchant</th>
                      <th style={{ ...s.th, textAlign: 'right' }}>Avg amount</th>
                      <th style={s.th}>Inferred frequency</th>
                      <th style={{ ...s.th, textAlign: 'center' }}>Seen</th>
                      <th style={s.th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {txnFixedCosts.map((tc, i) => {
                      const alreadyAdded = mb.fixedCosts.some(
                        fc => fc.name.toLowerCase() === tc.merchant.toLowerCase()
                      );
                      return (
                        <tr key={i} style={{ ...s.tr, opacity: alreadyAdded ? 0.45 : 1 }}>
                          <td style={s.td}>{tc.merchant}</td>
                          <td style={{ ...s.td, textAlign: 'right' }}>{fmtCurrency(tc.meanAmount)}</td>
                          <td style={s.td}>{FREQ_LABELS[tc.frequency] ?? tc.frequency}</td>
                          <td style={{ ...s.td, textAlign: 'center' }}>{tc.occurrences}×</td>
                          <td style={s.td}>
                            {alreadyAdded ? (
                              <span style={s.muted}>added</span>
                            ) : (
                              <button
                                style={s.addBtn}
                                onClick={() => patch_mb({
                                  fixedCosts: [...mb.fixedCosts, {
                                    id:        uuidv4(),
                                    name:      tc.merchant,
                                    amount:    tc.meanAmount,
                                    frequency: tc.frequency as MBFixedCost['frequency'],
                                    fromTxn:   true,
                                  }],
                                })}
                              >Add</button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </>
            )}
          </div>
        )}
      </Section>

      {/* ── Discretionary Buckets ───────────────────────────────────────── */}
      <Section title="Discretionary Buckets">
        <p style={s.sectionNote}>
          Allocate the <strong>{fmtCurrency(discretionary)}</strong> monthly discretionary remainder
          into spending buckets. Link each bucket to an existing budget to push the amount there as a
          goal amount or checkbook credit.
        </p>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>Name</th>
              <th style={s.th}>Amount type</th>
              <th style={{ ...s.th, textAlign: 'right' }}>Value</th>
              <th style={{ ...s.th, textAlign: 'right' }}>Monthly</th>
              <th style={s.th}>Link to budget</th>
              <th style={s.th}>Link type</th>
              <th style={s.th}></th>
            </tr>
          </thead>
          <tbody>
          {mb.buckets.map(b => {
              const isPercent   = percentMode.has(b.id);
              const isRemaining = remainingMode.has(b.id);
              // For "remaining" buckets, compute unallocated excluding this bucket's contribution
              const otherAllocated = mb.buckets
                .filter(x => x.id !== b.id)
                .reduce((sum, x) => {
                  if (remainingMode.has(x.id)) return sum;
                  if (percentMode.has(x.id))   return sum + discretionary * x.percent;
                  return sum + x.amountMonthly;
                }, 0);
              const remainingVal = Math.max(0, Math.round((discretionary - otherAllocated) * 100) / 100);
              const monthly = isRemaining
                ? remainingVal
                : isPercent
                  ? discretionary * b.percent
                  : b.amountMonthly;
              const linkedBudget = budgets.find(bg => bg.budgetId === b.linkedBudgetId);
              const derivedLinkType = linkedBudget?.budgetType === 'checkbook' ? 'credit' : 'goal';

              const amtType = isRemaining ? 'remaining' : isPercent ? 'percent' : 'fixed';

              return (
                <tr key={b.id} style={s.tr}>
                  <td style={s.td}>
                    <input
                      style={s.nameInput}
                      value={b.name}
                      onChange={e => updateBucket(b.id, { name: e.target.value })}
                      placeholder="e.g. Dining out"
                    />
                  </td>
                  <td style={s.td}>
                    <select
                      style={s.freqSelect}
                      value={amtType}
                      onChange={e => {
                        const val = e.target.value;
                        // Clear all mode flags first
                        setPercentMode(prev => { const n = new Set(prev); n.delete(b.id); return n; });
                        setRemainingMode(prev => { const n = new Set(prev); n.delete(b.id); return n; });
                        if (val === 'percent') {
                          setPercentMode(prev => new Set(prev).add(b.id));
                          const pct = discretionary > 0 ? monthly / discretionary : 0;
                          updateBucket(b.id, { amountMonthly: 0, percent: pct });
                        } else if (val === 'remaining') {
                          setRemainingMode(prev => new Set(prev).add(b.id));
                          updateBucket(b.id, { amountMonthly: 0, percent: 0 });
                        } else {
                          // fixed — convert current displayed monthly to $, rounded
                          updateBucket(b.id, { percent: 0, amountMonthly: Math.round(monthly * 100) / 100 });
                        }
                      }}
                    >
                      <option value="fixed">Fixed $</option>
                      <option value="percent">% of discretionary</option>
                      <option value="remaining">$ Remaining</option>
                    </select>
                  </td>
                  <td style={{ ...s.td, textAlign: 'right' }}>
                    {isRemaining ? (
                      <span style={{ color: '#6b7280', fontSize: '0.875rem' }}>{fmtCurrency(remainingVal)}</span>
                    ) : !isPercent ? (
                      <BucketMoneyInput
                        value={b.amountMonthly}
                        onCommit={v => updateBucket(b.id, { amountMonthly: v })}
                      />
                    ) : (
                      <BucketPercentInput
                        value={b.percent}
                        onCommit={v => updateBucket(b.id, { percent: v })}
                      />
                    )}
                  </td>
                  <td style={{ ...s.td, textAlign: 'right' }}>
                    {fmtCurrency(monthly)}
                  </td>
                  <td style={s.td}>
                    <select
                      style={s.freqSelect}
                      value={b.linkedBudgetId ?? ''}
                      onChange={e => {
                        const newId = e.target.value || undefined;
                        const bg = budgets.find(x => x.budgetId === newId);
                        const lt = bg?.budgetType === 'checkbook' ? 'credit' : 'goal';
                        updateBucket(b.id, { linkedBudgetId: newId, linkType: newId ? lt : undefined });
                      }}
                    >
                      <option value="">— none —</option>
                      {budgets.map(bg => (
                        <option key={bg.budgetId} value={bg.budgetId}>{bg.name}</option>
                      ))}
                    </select>
                  </td>
                  <td style={s.td}>
                    {linkedBudget ? (
                      <span style={s.linkTypeBadge}>
                        {derivedLinkType === 'credit' ? 'Checkbook credit' : 'Goal amount'}
                      </span>
                    ) : (
                      <span style={s.muted}>—</span>
                    )}
                  </td>
                  <td style={s.td}>
                    <button style={s.removeBtn} onClick={() => removeBucket(b.id)} title="Remove">✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <button style={s.addBtn} onClick={addBucket}>+ Add bucket</button>

        {/* Allocation summary */}
        <div style={s.allocSummary}>
            <span>Allocated: <strong>{fmtCurrency(totalAllocated)}</strong></span>
            <span style={{ margin: '0 0.5rem', color: '#9ca3af' }}>·</span>
            <span style={{ color: Math.abs(unallocated) < 0.01 ? '#059669' : unallocated < 0 ? '#dc2626' : '#374151' }}>
              Unallocated: <strong>{fmtCurrency(unallocated)}</strong>
            </span>
          </div>
      </Section>
    </div>

    {showSuggest && (
      <SuggestFixedCostsModal
        onClose={() => setShowSuggest(false)}
        onConfirm={added => {
          if (mb) {
            patch_mb({ fixedCosts: [...mb.fixedCosts, ...added] });
          }
          setShowSuggest(false);
        }}
      />
    )}
    </>
  );
};

// ── Small helpers ──────────────────────────────────────────────────────────────

const Section: React.FC<{ title: string; children: React.ReactNode; action?: React.ReactNode }> = ({ title, children, action }) => (
  <div style={sectionStyle}>
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', marginBottom: '0.75rem' }}>
      <h3 style={{ ...sectionTitle, marginBottom: 0 }}>{title}</h3>
      {action}
    </div>
    {children}
  </div>
);

const SummaryCell: React.FC<{ label: string; value: number; color: string }> = ({ label, value, color }) => (
  <div style={{ textAlign: 'center', flex: 1, minWidth: 0 }}>
    <div style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: 2 }}>{label}</div>
    <div style={{ fontSize: '1.05rem', fontWeight: 700, color }}>{fmtCurrency(value)}</div>
  </div>
);

const sectionStyle: React.CSSProperties = {
  background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10,
  padding: '1rem 1.25rem', marginBottom: '1.25rem',
};

const sectionTitle: React.CSSProperties = {
  margin: '0 0 0.75rem', fontSize: '1rem', fontWeight: 600, color: '#1a202c',
};

// ── Styles ─────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page:        { padding: '1.5rem 1rem', maxWidth: 1100, margin: '0 auto' },
  heading:     { margin: 0, fontSize: '1.25rem', fontWeight: 600 },
  muted:       { color: '#6b7280', fontSize: '0.875rem' },
  error:       { color: '#dc2626', fontSize: '0.875rem' },
  sectionNote: { fontSize: '0.875rem', color: '#4a5568', marginTop: 0, marginBottom: '0.75rem' },

  summaryBar: {
    display: 'flex', alignItems: 'center', gap: '0.5rem',
    background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10,
    padding: '1rem 1.5rem', marginBottom: '1.25rem', flexWrap: 'wrap',
  },
  summaryArrow: { fontSize: '1.2rem', color: '#9ca3af', fontWeight: 300, flexShrink: 0 },

  table:      { width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem', marginBottom: '0.5rem' },
  th:         { textAlign: 'left', padding: '0.5rem 0.6rem', background: '#f7fafc', borderBottom: '2px solid #e2e8f0', fontWeight: 600, color: '#4a5568', whiteSpace: 'nowrap' },
  td:         { padding: '0.5rem 0.6rem', color: '#2d3748', borderBottom: '1px solid #e2e8f0', verticalAlign: 'middle' },
  tr:         { borderBottom: '1px solid #e2e8f0' },

  nameInput:  { padding: '0.35rem 0.5rem', border: '1px solid #cbd5e0', borderRadius: 5, fontSize: '0.875rem', width: '100%', boxSizing: 'border-box' as const },
  freqSelect: { padding: '0.35rem 0.5rem', border: '1px solid #cbd5e0', borderRadius: 5, fontSize: '0.875rem', width: '100%' },

  addBtn:     { background: 'none', border: 'none', color: '#0d7a6b', cursor: 'pointer', fontSize: '0.85rem', padding: '0.3rem 0', textDecoration: 'underline', marginTop: '0.25rem' },
  suggestLink: { background: 'none', border: 'none', color: '#0d7a6b', cursor: 'pointer', fontSize: '0.8rem', padding: 0, textDecoration: 'underline' },
  removeBtn:  { background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: '0.85rem', padding: 2 },

  allocSummary: { fontSize: '0.875rem', color: '#374151', margin: '0.5rem 0 0.25rem', padding: '0.4rem 0' },

  estBadge:   { marginLeft: 6, fontSize: '0.7rem', background: '#fef3c7', color: '#92400e', borderRadius: 4, padding: '1px 5px', verticalAlign: 'middle' },
  linkTypeBadge: { fontSize: '0.8rem', color: '#4a5568', background: '#f7fafc', border: '1px solid #e2e8f0', borderRadius: 4, padding: '2px 7px', whiteSpace: 'nowrap' as const },

  primaryBtn:         { background: '#0d7a6b', color: '#fff', border: 'none', borderRadius: 6, padding: '0.45rem 1rem', cursor: 'pointer', fontSize: '0.875rem' },
  primaryBtnDisabled: { background: '#a0aec0', color: '#fff', border: 'none', borderRadius: 6, padding: '0.45rem 1rem', cursor: 'default', fontSize: '0.875rem' },
};

export default MasterBudgetPage;

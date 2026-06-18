import React, { useState, useEffect, useCallback } from 'react';
import { useData } from '../auth/DataContext';
import { useDirtyGuard } from '../auth/DirtyGuardContext';
import {
  MasterBudget, MBIncomeSource, MBFixedCost, MBBucket,
  getMasterBudget, putMasterBudget,
  putRule, applyRules,
  INCOME_BUDGET_PREFIX, INCOME_CATEGORY_ID,
  getMasterBudgetVariance, MasterBudgetVariance, MASTER_BUDGET_ID,
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
  const { incomeSources, budgets, refreshAll, rules, categories } = useData();

  const [mb, setMb] = useState<MasterBudget | null>(null);
  const [versions, setVersions] = useState<MasterBudget[]>([]);
  // Date string of the version currently being viewed/edited ("" = legacy)
  const [selectedVersionDate, setSelectedVersionDate] = useState<string>('');
  // The effectiveDate the version had when it was last loaded or saved —
  // used to delete the old DynamoDB item when the user renames the date.
  const [originalVersionDate, setOriginalVersionDate] = useState<string>('');
  // New-version creation form state (null = form not open)
  const [newVersionForm, setNewVersionForm] = useState<{ effectiveDate: string; label: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [showSuggest, setShowSuggest] = useState(false);
  const [variance, setVariance] = useState<MasterBudgetVariance | null>(null);

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

  // Income rule config: which rows are expanded, and local draft state
  const [expandedIncomeRule, setExpandedIncomeRule] = useState<Set<string>>(new Set());
  const [incomeRuleDraft, setIncomeRuleDraft] = useState<Record<string, {
    pattern: string; amountMatch: number; amountTolerance: number;
  }>>({});
  const [incomeRuleSaving, setIncomeRuleSaving] = useState<Set<string>>(new Set());

  // Fixed cost rule config: which rows are expanded, and local draft state
  const [expandedFcRule, setExpandedFcRule] = useState<Set<string>>(new Set());
  const [fcRuleDraft, setFcRuleDraft] = useState<Record<string, {
    pattern: string;
    categoryId: string;
    useAmount: boolean;
    amountMatch: number;
    amountTolerance: number;
    useDay: boolean;
    dayOfMonth: number;
    dayTolerance: number;
  }>>({});
  const [fcRuleSaving, setFcRuleSaving] = useState<Set<string>>(new Set());

  const toggleIncomeRuleExpand = (sourceId: string) => {
    setExpandedIncomeRule(prev => {
      const s = new Set(prev);
      if (s.has(sourceId)) { s.delete(sourceId); return s; }
      s.add(sourceId);
      // Seed draft from existing rule matched by incomeSourceId
      if (!incomeRuleDraft[sourceId]) {
        const existing = rules.find(r => r.incomeSourceId === sourceId);
        setIncomeRuleDraft(d => ({
          ...d,
          [sourceId]: {
            pattern:         existing?.pattern         ?? '',
            amountMatch:     existing?.amountMatch     ?? 0,
            amountTolerance: existing?.amountTolerance ?? 50,
          },
        }));
      }
      return s;
    });
  };

  const patchRuleDraft = (sourceId: string, patch: Partial<typeof incomeRuleDraft[string]>) => {
    setIncomeRuleDraft(d => ({ ...d, [sourceId]: { ...d[sourceId], ...patch } }));
  };

  const saveIncomeRule = async (mbi: MBIncomeSource) => {
    const draft = incomeRuleDraft[mbi.incomeSourceId];
    if (!draft?.pattern) return;
    setIncomeRuleSaving(prev => new Set(prev).add(mbi.incomeSourceId));
    try {
      const ruleId = mbi.incomeRuleId || crypto.randomUUID();
      await putRule({
        ruleId,
        pattern:         draft.pattern,
        categoryId:      INCOME_CATEGORY_ID,
        budgetId:        INCOME_BUDGET_PREFIX + mbi.incomeSourceId,
        priority:        10,
        amountMatch:     draft.amountMatch,
          amountTolerance: draft.amountTolerance,
        incomeSourceId:  mbi.incomeSourceId,
      });
      // Persist ruleId back onto the MBIncomeSource
      updateMBIS(mbi.incomeSourceId, { incomeRuleId: ruleId });
      // Auto-apply rules so existing transactions get tagged
      try { await applyRules(); } catch { /* non-fatal */ }
      setExpandedIncomeRule(prev => { const s = new Set(prev); s.delete(mbi.incomeSourceId); return s; });
    } catch (e: any) {
      alert('Failed to save income rule: ' + e.message);
    } finally {
      setIncomeRuleSaving(prev => { const s = new Set(prev); s.delete(mbi.incomeSourceId); return s; });
    }
  };

  const toggleFcRuleExpand = (fcId: string) => {
    setExpandedFcRule(prev => {
      const s = new Set(prev);
      if (s.has(fcId)) { s.delete(fcId); return s; }
      s.add(fcId);
      // Seed draft from existing rule if fc has one, otherwise from fc defaults
      if (!fcRuleDraft[fcId]) {
        const fc = mb?.fixedCosts.find(f => f.id === fcId);
        const existing = fc?.ruleId ? rules.find(r => r.ruleId === fc.ruleId) : undefined;
        const hasExistingAmount = (existing?.amountMatch ?? 0) > 0;
        const hasExistingDay    = (existing?.dayOfMonth  ?? 0) > 0;
        setFcRuleDraft(d => ({
          ...d,
          [fcId]: {
            pattern:         existing?.pattern         ?? fc?.name ?? '',
            categoryId:      existing?.categoryId      ?? '',
            useAmount:       hasExistingAmount || (!existing && (fc?.amount ?? 0) > 0),
            amountMatch:     existing?.amountMatch     ?? fc?.amount ?? 0,
            amountTolerance: existing?.amountTolerance ?? 5,
            useDay:          hasExistingDay,
            dayOfMonth:      existing?.dayOfMonth      ?? 0,
            dayTolerance:    existing?.dayTolerance    ?? 3,
          },
        }));
      }
      return s;
    });
  };

  const patchFcRuleDraft = (fcId: string, patch: Partial<typeof fcRuleDraft[string]>) => {
    setFcRuleDraft(d => ({ ...d, [fcId]: { ...d[fcId], ...patch } }));
  };

  const saveFcRule = async (fc: MBFixedCost) => {
    const draft = fcRuleDraft[fc.id];
    if (!draft?.pattern) return;
    setFcRuleSaving(prev => new Set(prev).add(fc.id));
    try {
      const ruleId = fc.ruleId || crypto.randomUUID();
      await putRule({
        ruleId,
        pattern:    draft.pattern,
        categoryId: draft.categoryId,
        budgetId:   MASTER_BUDGET_ID,
        priority:   50,
        ...(draft.useAmount && draft.amountMatch > 0 ? {
          amountMatch:     draft.amountMatch,
          amountTolerance: draft.amountTolerance,
        } : {}),
        ...(draft.useDay && draft.dayOfMonth > 0 ? {
          dayOfMonth:  draft.dayOfMonth,
          dayTolerance: draft.dayTolerance,
        } : {}),
      });
      updateFixedCost(fc.id, { ruleId });
      try { await applyRules(); } catch { /* non-fatal */ }
      setExpandedFcRule(prev => { const s = new Set(prev); s.delete(fc.id); return s; });
    } catch (e: any) {
      alert('Failed to save rule: ' + e.message);
    } finally {
      setFcRuleSaving(prev => { const s = new Set(prev); s.delete(fc.id); return s; });
    }
  };

  // Load once on mount
  useEffect(() => {
    getMasterBudget()
      .then(({ versions: vers, current }) => {
        setVersions(vers);
        const active = current ?? (vers.length > 0 ? vers[vers.length - 1] : null);
        if (!active) { setLoading(false); return; }
        setSelectedVersionDate(active.effectiveDate ?? '');
        setOriginalVersionDate(active.effectiveDate ?? '');

        // Merge: ensure every income source has an MBIncomeSource entry
        setMb(() => {
          const existingIds = new Set((active.incomeSources ?? []).map(s => s.incomeSourceId));
          const merged: MBIncomeSource[] = [
            ...(active.incomeSources ?? []),
            ...incomeSources
              .filter(s => !existingIds.has(s.incomeSourceId))
              .map(s => ({ incomeSourceId: s.incomeSourceId, monthlyOverride: 0, enabled: true })),
          ];
          return { ...active, incomeSources: merged };
        });
        // Init percent/remaining mode from saved buckets.
        // Use explicit amountType when present; fall back to inferring from percent > 0
        // for records saved before amountType was introduced.
        setPercentMode(new Set(
          (active.buckets ?? [])
            .filter(b => b.amountType === 'percent' || (!b.amountType && b.percent > 0))
            .map(b => b.id)
        ));
        setRemainingMode(new Set(
          (active.buckets ?? []).filter(b => b.amountType === 'remaining').map(b => b.id)
        ));
      })
      .finally(() => setLoading(false));
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

  // Load variance for current month
  useEffect(() => {
    getMasterBudgetVariance().then(setVariance).catch(() => {});
  }, []);

  const patch = useCallback((update: Partial<MasterBudget>) => {
    setMb(prev => prev ? { ...prev, ...update } : prev);
    setDirty(true);
  }, []);

  const save = async () => {
    if (!mb) return;
    setSaving(true);
    setError('');
    try {
      const { version: saved } = await putMasterBudget({
        effectiveDate:         mb.effectiveDate,
        label:                 mb.label,
        previousEffectiveDate: originalVersionDate !== (mb.effectiveDate ?? '') ? originalVersionDate : undefined,
        incomeSources: mb.incomeSources,
        fixedCosts:    mb.fixedCosts,
        buckets:       mb.buckets,
      }, discretionary);
      // Update local version list: replace or add the saved version, and remove
      // any stale entry for the old date if the user renamed it.
      setVersions(prev => {
        let next = prev.filter(v => (v.effectiveDate ?? '') !== originalVersionDate || (v.effectiveDate ?? '') === (saved.effectiveDate ?? ''));
        const existing = next.findIndex(v => (v.effectiveDate ?? '') === (saved.effectiveDate ?? ''));
        if (existing >= 0) {
          next[existing] = saved;
        } else {
          next = [...next, saved];
        }
        return next.sort((a, b) => (a.effectiveDate ?? '') < (b.effectiveDate ?? '') ? -1 : 1);
      });
      setMb(saved);
      setSelectedVersionDate(saved.effectiveDate ?? '');
      setOriginalVersionDate(saved.effectiveDate ?? '');
      setDirty(false);
      setNewVersionForm(null);
      // Refresh the budgets cache — backend has updated linked budgets and their periods.
      await refreshAll();
    } catch {
      setError('Save failed.');
    } finally {
      setSaving(false);
    }
  };

  // Switch the editor to a different version.
  const selectVersion = (effectiveDate: string) => {
    if (dirty && !window.confirm('You have unsaved changes. Switch versions and discard them?')) return;
    const v = versions.find(ver => (ver.effectiveDate ?? '') === effectiveDate);
    if (!v) return;
    setSelectedVersionDate(effectiveDate);
    setOriginalVersionDate(effectiveDate);
    setMb(v);
    setDirty(false);
    setNewVersionForm(null);
    setPercentMode(new Set(
      (v.buckets ?? [])
        .filter(b => b.amountType === 'percent' || (!b.amountType && b.percent > 0))
        .map(b => b.id)
    ));
    setRemainingMode(new Set(
      (v.buckets ?? []).filter(b => b.amountType === 'remaining').map(b => b.id)
    ));
  };

  // Start creating a new version as a clone of the currently viewed version.
  const startNewVersion = () => {
    setNewVersionForm({ effectiveDate: '', label: '' });
  };

  // Confirm the new version form: clone mb into a new version with the given date.
  const confirmNewVersion = () => {
    if (!newVersionForm || !mb) return;
    const date = newVersionForm.effectiveDate;
    if (!date) { alert('Please set an effective date for the new version.'); return; }
    if (versions.some(v => v.effectiveDate === date)) {
      alert(`A version with effective date ${date} already exists.`);
      return;
    }
    const cloned: MasterBudget = {
      ...mb,
      effectiveDate: date,
      label: newVersionForm.label || undefined,
    };
    setMb(cloned);
    setSelectedVersionDate(date);
    setOriginalVersionDate(''); // new version — no prior SK to delete
    setDirty(true);
    setNewVersionForm(null);
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

      {/* ── Version selector bar ─────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: '#6b7280', fontWeight: 500 }}>Version:</span>
        <select
          style={{ fontSize: 13, padding: '4px 8px', border: '1px solid #cbd5e0', borderRadius: 5 }}
          value={selectedVersionDate}
          onChange={e => selectVersion(e.target.value)}
        >
          {versions.map(v => {
            const key = v.effectiveDate ?? '';
            const label = v.label
              ? `${v.label}${v.effectiveDate ? ` (from ${v.effectiveDate})` : ''}`
              : v.effectiveDate
                ? `From ${v.effectiveDate}`
                : 'Original (no date)';
            return <option key={key} value={key}>{label}</option>;
          })}
        </select>
        {mb && mb.effectiveDate && (
          <span style={{ fontSize: 12, color: '#6b7280' }}>
            Effective from <strong>{mb.effectiveDate}</strong>
            {(() => {
              const idx = versions.findIndex(v => (v.effectiveDate ?? '') === (mb.effectiveDate ?? ''));
              const next = versions[idx + 1];
              return next?.effectiveDate
                ? <> through <strong>{next.effectiveDate}</strong> (exclusive)</>
                : <> onward</>;
            })()}
          </span>
        )}
        {mb && !mb.effectiveDate && (
          <span style={{ fontSize: 12, color: '#b45309', background: '#fffbeb', padding: '2px 8px', borderRadius: 4, border: '1px solid #fde68a' }}>
            No effective date — set one when saving to enable date-based propagation
          </span>
        )}
        {!newVersionForm ? (
          <button
            style={{ ...s.secondaryBtn, marginLeft: 'auto' }}
            onClick={startNewVersion}
          >
            + New Version
          </button>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, padding: '6px 12px' }}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>New version — effective from:</span>
            <input
              type="date"
              value={newVersionForm.effectiveDate}
              onChange={e => setNewVersionForm(f => f ? { ...f, effectiveDate: e.target.value } : f)}
              style={{ fontSize: 13, padding: '3px 6px', border: '1px solid #cbd5e0', borderRadius: 4 }}
            />
            <input
              type="text"
              placeholder="Label (optional)"
              value={newVersionForm.label}
              onChange={e => setNewVersionForm(f => f ? { ...f, label: e.target.value } : f)}
              style={{ fontSize: 13, padding: '3px 6px', border: '1px solid #cbd5e0', borderRadius: 4, minWidth: 160 }}
            />
            <button style={s.primaryBtn} onClick={confirmNewVersion}>Clone &amp; Edit</button>
            <button style={s.secondaryBtn} onClick={() => setNewVersionForm(null)}>Cancel</button>
          </div>
        )}
      </div>

      {/* Editable label/date — always shown so the user can set a date on the legacy version */}
      {mb && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
          <label style={{ fontSize: 13, color: '#6b7280' }}>
            Effective date:
            <input
              type="date"
              value={mb.effectiveDate ?? ''}
              onChange={e => patch({ effectiveDate: e.target.value })}
              style={{ marginLeft: 6, fontSize: 13, padding: '3px 6px', border: '1px solid #cbd5e0', borderRadius: 4 }}
            />
          </label>
          <label style={{ fontSize: 13, color: '#6b7280' }}>
            Label:
            <input
              type="text"
              placeholder="e.g. 2026 salary increase"
              value={mb.label ?? ''}
              onChange={e => patch({ label: e.target.value || undefined })}
              style={{ marginLeft: 6, fontSize: 13, padding: '3px 6px', border: '1px solid #cbd5e0', borderRadius: 4, minWidth: 200 }}
            />
          </label>
        </div>
      )}

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
              <th style={s.th}>Variance budget</th>
              <th style={s.th}>Match rule</th>
            </tr>
          </thead>
          <tbody>
            {mb.incomeSources.map(mbi => {
              const src = incomeSources.find(s => s.incomeSourceId === mbi.incomeSourceId);
              if (!src) return null;
              const netPerPeriod = src.lastNetPay?.netPay ?? src.grossAmount;
              const monthly = monthlyNetPay(mbi.incomeSourceId);
              const isExpanded = expandedIncomeRule.has(mbi.incomeSourceId);
              const draft = incomeRuleDraft[mbi.incomeSourceId];
              const hasRule = !!mbi.incomeRuleId || rules.some(r => r.incomeSourceId === mbi.incomeSourceId);
              return (
                <React.Fragment key={mbi.incomeSourceId}>
                <tr style={s.tr}>
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
                    {budgets.map(b => (
                        <option key={b.budgetId} value={b.budgetId}>{b.name}</option>
                      ))}
                    </select>
                  </td>
                  <td style={s.td}>
                    <button
                      style={{ ...s.suggestLink, fontSize: '0.78rem' }}
                      onClick={() => toggleIncomeRuleExpand(mbi.incomeSourceId)}
                    >
                      {hasRule ? '✓ rule' : '+ match rule'}{isExpanded ? ' ▲' : ' ▼'}
                    </button>
                  </td>
                </tr>
                {isExpanded && (
                  <tr style={{ background: '#f7fafc' }}>
                    <td colSpan={8} style={{ padding: '0.75rem 1rem', borderBottom: '1px solid #e2e8f0' }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'flex-end' }}>
                        <label style={s.ruleLabel}>
                          Deposit description contains
                          <input
                            style={s.ruleInput}
                            placeholder="e.g. ADP, DIRECT DEP"
                            value={draft?.pattern ?? ''}
                            onChange={e => patchRuleDraft(mbi.incomeSourceId, { pattern: e.target.value })}
                          />
                        </label>
                        <label style={s.ruleLabel}>
                          Expected amount ($)
                          <input
                            style={s.ruleInput}
                            type="number" min="0" step="0.01"
                            placeholder={String(netPerPeriod.toFixed(2))}
                            value={draft?.amountMatch || ''}
                            onChange={e => patchRuleDraft(mbi.incomeSourceId, { amountMatch: parseFloat(e.target.value) || 0 })}
                          />
                        </label>
                        <label style={s.ruleLabel}>
                          ± tolerance ($)
                          <input
                            style={{ ...s.ruleInput, maxWidth: 70 }}
                            type="number" min="0" step="0.01"
                            value={draft?.amountTolerance ?? 5}
                            onChange={e => patchRuleDraft(mbi.incomeSourceId, { amountTolerance: parseFloat(e.target.value) || 0 })}
                          />
                        </label>
                        <button
                          style={draft?.pattern ? s.addBtn : { ...s.addBtn, opacity: 0.5 }}
                          disabled={!draft?.pattern || incomeRuleSaving.has(mbi.incomeSourceId)}
                          onClick={() => saveIncomeRule(mbi)}
                        >
                          {incomeRuleSaving.has(mbi.incomeSourceId) ? 'Saving…' : 'Save rule'}
                        </button>
                      </div>
                      <p style={{ ...s.muted, marginTop: '0.4rem', fontSize: '0.78rem' }}>
                        Matching deposits will be categorized as <strong>Income</strong> and linked to this source for variance tracking.
                      </p>
                    </td>
                  </tr>
                )}
                </React.Fragment>
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
              <th style={s.th}>Variance budget</th>
              <th style={s.th}>Match rule</th>
              <th style={s.th}></th>
            </tr>
          </thead>
          <tbody>
            {mb.fixedCosts.map(fc => {
              const isExpanded = expandedFcRule.has(fc.id);
              const draft = fcRuleDraft[fc.id];
              const hasRule = !!fc.ruleId;
              return (
              <React.Fragment key={fc.id}>
              <tr style={s.tr}>
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
                    {budgets.map(b => (
                      <option key={b.budgetId} value={b.budgetId}>{b.name}</option>
                    ))}
                  </select>
                </td>
                <td style={s.td}>
                  <button
                    style={{ ...s.suggestLink, fontSize: '0.78rem' }}
                    onClick={() => toggleFcRuleExpand(fc.id)}
                  >
                    {hasRule ? '✓ rule' : '+ match rule'}{isExpanded ? ' ▲' : ' ▼'}
                  </button>
                </td>
                <td style={{ ...s.td, textAlign: 'right' }}>
                  <button style={s.removeBtn} onClick={() => removeFixedCost(fc.id)} title="Remove">✕</button>
                </td>
              </tr>
              {isExpanded && (
                <tr style={{ background: '#f7fafc' }}>
                  <td colSpan={7} style={{ padding: '0.75rem 1rem', borderBottom: '1px solid #e2e8f0' }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'flex-end' }}>
                      <label style={s.ruleLabel}>
                        Description contains
                        <input
                          style={s.ruleInput}
                          placeholder={`e.g. ${fc.name || 'netflix'}`}
                          value={draft?.pattern ?? ''}
                          onChange={e => patchFcRuleDraft(fc.id, { pattern: e.target.value })}
                        />
                      </label>
                      <label style={s.ruleLabel}>
                        Category <span style={{ fontWeight: 400, color: '#a0aec0' }}>(optional)</span>
                        <select
                          style={{ ...s.ruleInput, minWidth: 160 }}
                          value={draft?.categoryId ?? ''}
                          onChange={e => patchFcRuleDraft(fc.id, { categoryId: e.target.value })}
                        >
                          <option value="">— None —</option>
                          {categories.map(c => (
                            <option key={c.categoryId} value={c.categoryId}>{c.name}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'flex-end', marginTop: '0.5rem' }}>
                      <label style={{ ...s.ruleLabel, flexDirection: 'row', alignItems: 'center', gap: '0.35rem' }}>
                        <input
                          type="checkbox"
                          checked={draft?.useAmount ?? false}
                          onChange={e => patchFcRuleDraft(fc.id, { useAmount: e.target.checked })}
                        />
                        Match amount
                      </label>
                      {draft?.useAmount && (
                        <>
                          <label style={s.ruleLabel}>
                            Amount ($)
                            <input
                              style={{ ...s.ruleInput, maxWidth: 100 }}
                              type="number" min="0" step="0.01"
                              value={draft?.amountMatch || ''}
                              onChange={e => patchFcRuleDraft(fc.id, { amountMatch: parseFloat(e.target.value) || 0 })}
                            />
                          </label>
                          <label style={s.ruleLabel}>
                            ±$ tolerance
                            <input
                              style={{ ...s.ruleInput, maxWidth: 70 }}
                              type="number" min="0" step="0.01"
                              value={draft?.amountTolerance ?? 5}
                              onChange={e => patchFcRuleDraft(fc.id, { amountTolerance: parseFloat(e.target.value) || 0 })}
                            />
                          </label>
                        </>
                      )}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'flex-end', marginTop: '0.5rem' }}>
                      <label style={{ ...s.ruleLabel, flexDirection: 'row', alignItems: 'center', gap: '0.35rem' }}>
                        <input
                          type="checkbox"
                          checked={draft?.useDay ?? false}
                          onChange={e => patchFcRuleDraft(fc.id, { useDay: e.target.checked })}
                        />
                        Match day of month
                      </label>
                      {draft?.useDay && (
                        <>
                          <label style={s.ruleLabel}>
                            Day (1–31)
                            <input
                              style={{ ...s.ruleInput, maxWidth: 70 }}
                              type="number" min="1" max="31"
                              value={draft?.dayOfMonth || ''}
                              onChange={e => patchFcRuleDraft(fc.id, { dayOfMonth: parseInt(e.target.value) || 0 })}
                            />
                          </label>
                          <label style={s.ruleLabel}>
                            ±days tolerance
                            <input
                              style={{ ...s.ruleInput, maxWidth: 70 }}
                              type="number" min="0" max="15"
                              value={draft?.dayTolerance ?? 3}
                              onChange={e => patchFcRuleDraft(fc.id, { dayTolerance: parseInt(e.target.value) || 0 })}
                            />
                          </label>
                        </>
                      )}
                    </div>
                    <div style={{ marginTop: '0.6rem' }}>
                      <button
                        style={draft?.pattern ? s.addBtn : { ...s.addBtn, opacity: 0.5 }}
                        disabled={!draft?.pattern || fcRuleSaving.has(fc.id)}
                        onClick={() => saveFcRule(fc)}
                      >
                        {fcRuleSaving.has(fc.id) ? 'Saving…' : 'Save rule'}
                      </button>
                    </div>
                    <p style={{ ...s.muted, marginTop: '0.4rem', fontSize: '0.78rem' }}>
                      Matching transactions will be assigned to Master Budget and tracked against this cost.
                    </p>
                  </td>
                </tr>
              )}
              </React.Fragment>
              );
            })}
          </tbody>
        </table>
        <button style={s.addBtn} onClick={addFixedCost}>+ Add cost</button>
      </Section>

      {/* ── Variance Summary ────────────────────────────────────────────── */}
      {variance && (
        <Section title={`Variance — ${variance.month}`}>
          {/* Income variance */}
          {variance.income.length > 0 && (
            <>
              <p style={{ ...s.sectionNote, marginBottom: '0.4rem' }}>Income</p>
              <table style={s.table}>
                <thead>
                  <tr>
                    <th style={s.th}>Source</th>
                    <th style={{ ...s.th, textAlign: 'right' }}>Expected</th>
                    <th style={{ ...s.th, textAlign: 'right' }}>Actual</th>
                    <th style={{ ...s.th, textAlign: 'right' }}>Variance</th>
                    <th style={{ ...s.th, textAlign: 'center' }}>Matched</th>
                  </tr>
                </thead>
                <tbody>
                  {variance.income.map(v => {
                    const src = incomeSources.find(s2 => s2.incomeSourceId === v.incomeSourceId);
                    const varColor = v.variance >= 0 ? '#16a34a' : '#dc2626';
                    return (
                      <tr key={v.incomeSourceId} style={s.tr}>
                        <td style={s.td}>{src?.name ?? v.incomeSourceId}</td>
                        <td style={{ ...s.td, textAlign: 'right' }}>{fmtCurrency(v.expectedMonthly)}</td>
                        <td style={{ ...s.td, textAlign: 'right' }}>{fmtCurrency(v.actual)}</td>
                        <td style={{ ...s.td, textAlign: 'right', color: varColor, fontWeight: 600 }}>
                          {v.variance >= 0 ? '+' : ''}{fmtCurrency(v.variance)}
                        </td>
                        <td style={{ ...s.td, textAlign: 'center', color: v.matchedCount === 0 ? '#dc2626' : '#2d3748' }}>
                          {v.matchedCount === 0 ? '⚠ none' : `${v.matchedCount}×`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
          {variance.income.length === 0 && (
            <p style={s.muted}>No income sources with match rules yet. Configure a match rule on each income source above.</p>
          )}

          {/* Fixed cost variance */}
          {variance.fixedCosts.length > 0 && (
            <>
              <p style={{ ...s.sectionNote, marginTop: '1rem', marginBottom: '0.4rem' }}>Fixed / Recurring Costs</p>
              <table style={s.table}>
                <thead>
                  <tr>
                    <th style={s.th}>Cost</th>
                    <th style={{ ...s.th, textAlign: 'right' }}>Expected</th>
                    <th style={{ ...s.th, textAlign: 'right' }}>Actual</th>
                    <th style={{ ...s.th, textAlign: 'right' }}>Variance</th>
                    <th style={{ ...s.th, textAlign: 'center' }}>Matched</th>
                  </tr>
                </thead>
                <tbody>
                  {variance.fixedCosts.map(v => {
                    // Positive variance = spent more than expected (bad for costs)
                    const varColor = v.variance > 0 ? '#dc2626' : v.variance < 0 ? '#16a34a' : '#2d3748';
                    return (
                      <tr key={v.fixedCostId} style={s.tr}>
                        <td style={s.td}>{v.name}</td>
                        <td style={{ ...s.td, textAlign: 'right' }}>{fmtCurrency(v.expectedMonthly)}</td>
                        <td style={{ ...s.td, textAlign: 'right' }}>{fmtCurrency(v.actual)}</td>
                        <td style={{ ...s.td, textAlign: 'right', color: varColor, fontWeight: 600 }}>
                          {v.variance > 0 ? '+' : ''}{fmtCurrency(v.variance)}
                        </td>
                        <td style={{ ...s.td, textAlign: 'center', color: v.matchedCount === 0 ? '#9ca3af' : '#2d3748' }}>
                          {v.matchedCount === 0 ? '—' : `${v.matchedCount}×`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </Section>
      )}

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
                          updateBucket(b.id, { amountMonthly: 0, percent: pct, amountType: 'percent' });
                        } else if (val === 'remaining') {
                          setRemainingMode(prev => new Set(prev).add(b.id));
                          updateBucket(b.id, { amountMonthly: 0, percent: 0, amountType: 'remaining' });
                        } else {
                          // fixed — convert current displayed monthly to $, rounded
                          updateBucket(b.id, { percent: 0, amountMonthly: Math.round(monthly * 100) / 100, amountType: 'fixed' });
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
          // Reload rules into DataContext so the inline rule form seeds
          // correctly without requiring a page leave-and-return.
          refreshAll();
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
  secondaryBtn:       { background: '#fff', color: '#374151', border: '1px solid #d1d5db', borderRadius: 6, padding: '0.4rem 0.9rem', cursor: 'pointer', fontSize: '0.875rem' },

  ruleLabel: { display: 'flex', flexDirection: 'column' as const, gap: '0.2rem', fontSize: '0.78rem', color: '#4a5568', fontWeight: 600 },
  ruleInput: { border: '1px solid #d1d5db', borderRadius: 4, padding: '0.3rem 0.5rem', fontSize: '0.85rem', minWidth: 140 },
};

export default MasterBudgetPage;

import React, { useState } from 'react';
import {
  Account, updateAccount, getCCCycleSuggestion, validateGuidedCycle, getTransactions,
  CCCycleSuggestion, GuidedCycleResult, ManualStatementEntry, Transaction,
} from '../api/client';
import { fmtCurrency, fmtDate } from '../utils/dates';
import { CCCycleWindowDetailModal } from './CCCycleWindowDetailModal';

interface Props {
  account: Account;
  onClose: () => void;
  onSaved: (patch: { ccPaymentDueDay?: number; ccGracePeriodDays?: number; ccCycleConfidence?: string }) => void;
}

type Tab = 'guided' | 'auto' | 'manual';

const emptyRow = (): ManualStatementEntry => ({ closeDate: '', dueDate: '' });

// ── Date helpers for the "Verify" button (Enter Manually tab) ───────────────
// Generates the implied (closeDate, dueDate) pairs for the last `count`
// occurrences of a fixed payment due day, working backward from today, so
// the same guided-validation routine can run against the currently-entered
// due day + grace period without requiring the user to re-type dates
// they've already provided.

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + days);
  return copy;
}

// Returns the given day within (year, month), clamping to the last valid
// day of that month (e.g. day=31 in February clamps to 28/29) — mirrors the
// backend's dateWithDay in internal/db/cccycle.go.
function dateWithDayClamped(year: number, month: number, day: number): Date {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, lastDay));
}

// Returns the most recent `count` occurrences of paymentDueDay on or before
// today, most recent first.
function recentDueDates(paymentDueDay: number, count: number): Date[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let year = today.getFullYear();
  let month = today.getMonth();
  let candidate = dateWithDayClamped(year, month, paymentDueDay);
  if (candidate > today) {
    month -= 1;
    if (month < 0) { month = 11; year -= 1; }
    candidate = dateWithDayClamped(year, month, paymentDueDay);
  }
  const dates: Date[] = [];
  for (let i = 0; i < count; i++) {
    dates.push(candidate);
    month -= 1;
    if (month < 0) { month = 11; year -= 1; }
    candidate = dateWithDayClamped(year, month, paymentDueDay);
  }
  return dates;
}

/**
 * Lets the user configure how a credit card's next payment is projected on
 * the Cash Flow page, as an alternative to (or override of) the automatic
 * billing-cycle heuristic (internal/db/cccycle.go). Three ways to arrive at
 * the two final values (payment due day, grace period days):
 *   - Guided Q&A: enter a few real statements' billing-period-end + due
 *     dates (read directly off the statement); the app derives payment
 *     due day/grace period and cross-checks them against the account's own
 *     synced transactions.
 *   - Run automatic analysis: the same heuristic the forecast itself uses
 *     when no override is set, surfaced here as a preview.
 *   - Manual entry: type the values directly if already known.
 * All three converge on the same editable fields, which is what actually
 * gets saved.
 */
export const CashFlowConfigModal: React.FC<Props> = ({ account, onClose, onSaved }) => {
  const [tab, setTab] = useState<Tab>('guided');

  const [dueDay, setDueDay] = useState<string>(account.ccPaymentDueDay ? String(account.ccPaymentDueDay) : '');
  const [grace, setGrace] = useState<string>(account.ccGracePeriodDays ? String(account.ccGracePeriodDays) : '');

  const [rows, setRows] = useState<ManualStatementEntry[]>([emptyRow(), emptyRow(), emptyRow()]);
  const [guidedResult, setGuidedResult] = useState<GuidedCycleResult | null>(null);
  const [guidedLoading, setGuidedLoading] = useState(false);
  const [guidedError, setGuidedError] = useState<string | null>(null);

  const [autoResult, setAutoResult] = useState<CCCycleSuggestion | null>(null);
  const [autoLoading, setAutoLoading] = useState(false);
  const [autoError, setAutoError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Lazy-loaded once (not fetched until the first time a result row's
  // window-sum link is clicked), then reused for every subsequent detail
  // drill-down so re-opening doesn't re-fetch.
  const [accountTxns, setAccountTxns] = useState<Transaction[] | null>(null);
  const [txnsLoading, setTxnsLoading] = useState(false);
  const [txnsError, setTxnsError] = useState<string | null>(null);
  const [detailEntry, setDetailEntry] = useState<GuidedCycleResult['entries'][number] | null>(null);

  const accountLabel = account.nickName || account.name;
  const isManualOverrideActive = !!account.ccPaymentDueDay && !!account.ccGracePeriodDays;

  const dueDayNum = parseInt(dueDay, 10);
  const graceNum = parseInt(grace, 10);

  const updateRow = (i: number, patch: Partial<ManualStatementEntry>) => {
    setRows(prev => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    setGuidedResult(null);
  };
  const addRow = () => setRows(prev => (prev.length < 6 ? [...prev, emptyRow()] : prev));
  const removeRow = (i: number) => setRows(prev => prev.filter((_, idx) => idx !== i));

  const filledRows = rows.filter(r => r.closeDate && r.dueDate);
  const canCalculateGuided = filledRows.length >= 2;

  const handleCalculateGuided = async () => {
    setGuidedLoading(true);
    setGuidedError(null);
    setGuidedResult(null);
    try {
      const result = await validateGuidedCycle(account.accountId, filledRows);
      setGuidedResult(result);
    } catch (e: any) {
      setGuidedError(e.response?.data?.error ?? e.message ?? 'Failed to calculate');
    } finally {
      setGuidedLoading(false);
    }
  };

  // "Verify" (Enter Manually tab): runs the same guided-validation routine
  // as "Calculate" above, but instead of asking the user to re-enter dates,
  // it generates them from the currently-entered payment due day + grace
  // period for the last 3 statements relative to today (e.g. due day 4 and
  // today 10/20 checks the 10/4, 9/4, and 8/4 payment-date statements).
  const canVerifyManual = dueDayNum >= 1 && dueDayNum <= 31 && graceNum >= 1 && graceNum <= 60;

  const handleVerifyManual = async () => {
    setGuidedLoading(true);
    setGuidedError(null);
    setGuidedResult(null);
    try {
      const dueDates = recentDueDates(dueDayNum, 3).reverse(); // oldest first
      const entries: ManualStatementEntry[] = dueDates.map(due => ({
        closeDate: toISODate(addDays(due, -graceNum)),
        dueDate: toISODate(due),
      }));
      const result = await validateGuidedCycle(account.accountId, entries);
      setGuidedResult(result);
    } catch (e: any) {
      setGuidedError(e.response?.data?.error ?? e.message ?? 'Failed to verify');
    } finally {
      setGuidedLoading(false);
    }
  };

  // Opens the per-entry drill-down modal, lazily loading this account's own
  // transaction history the first time it's needed (cached afterward so
  // re-opening for a different entry doesn't re-fetch).
  const handleOpenDetail = async (entry: GuidedCycleResult['entries'][number]) => {
    setDetailEntry(entry);
    if (accountTxns !== null || txnsLoading) return;
    setTxnsLoading(true);
    setTxnsError(null);
    try {
      const today = new Date();
      const start = new Date(today);
      start.setMonth(start.getMonth() - 14);
      const txns = await getTransactions({
        accountId: account.accountId,
        startDate: toISODate(start),
        endDate: toISODate(today),
      });
      setAccountTxns(txns);
    } catch (e: any) {
      setTxnsError(e.response?.data?.error ?? e.message ?? 'Failed to load transactions');
    } finally {
      setTxnsLoading(false);
    }
  };

  const handleRunAnalysis = async () => {
    setAutoLoading(true);
    setAutoError(null);
    setAutoResult(null);
    try {
      const result = await getCCCycleSuggestion(account.accountId);
      setAutoResult(result);
    } catch (e: any) {
      setAutoError(e.response?.data?.error ?? e.message ?? 'Failed to run analysis');
    } finally {
      setAutoLoading(false);
    }
  };

  const useGuidedValues = () => {
    if (!guidedResult) return;
    setDueDay(String(guidedResult.suggestedPaymentDueDay));
    setGrace(String(guidedResult.suggestedGracePeriodDays));
  };
  const useAutoValues = () => {
    if (!autoResult) return;
    if (autoResult.confidence === 'high' && autoResult.paymentDueDay && autoResult.gracePeriodDays) {
      setDueDay(String(autoResult.paymentDueDay));
      setGrace(String(autoResult.gracePeriodDays));
    } else if (autoResult.confidence === 'low' && autoResult.fallbackMeanDay) {
      setDueDay(String(autoResult.fallbackMeanDay));
      // Fallback confidence has no grace period concept — leave grace as-is,
      // the user still needs to supply/confirm one manually.
    }
  };

  const canSave = dueDayNum >= 1 && dueDayNum <= 31 && graceNum >= 1 && graceNum <= 60;

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await updateAccount(account.accountId, { ccPaymentDueDay: dueDayNum, ccGracePeriodDays: graceNum });
      onSaved({ ccPaymentDueDay: dueDayNum, ccGracePeriodDays: graceNum, ccCycleConfidence: 'manual' });
      onClose();
    } catch (e: any) {
      setSaveError(e.response?.data?.error ?? e.message ?? 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await updateAccount(account.accountId, { ccCycleReset: true });
      onSaved({ ccPaymentDueDay: undefined, ccGracePeriodDays: undefined, ccCycleConfidence: undefined });
      onClose();
    } catch (e: any) {
      setSaveError(e.response?.data?.error ?? e.message ?? 'Failed to reset');
    } finally {
      setSaving(false);
    }
  };

  const guidedResultBox = guidedResult && (
    <div style={s.resultBox}>
      <p style={s.resultSummary}>
        Suggested: payment due day <strong>{guidedResult.suggestedPaymentDueDay}</strong>, grace period{' '}
        <strong>{guidedResult.suggestedGracePeriodDays}</strong> days —{' '}
        <span style={{ color: guidedResult.matchCount === guidedResult.totalCycles ? '#166534' : '#b45309' }}>
          matches {guidedResult.matchCount} of {guidedResult.totalCycles} entered cycles
        </span>
      </p>
      <div style={s.entryList}>
        {guidedResult.entries.map((e, i) => (
          <div key={i} style={s.entryRow}>
            <span>{fmtDate(e.closeDate)} cycle</span>
            <span>
              window sum{' '}
              <button style={s.windowSumLink} onClick={() => handleOpenDetail(e)} title="See the transactions behind this sum">
                {fmtCurrency(e.windowSum)}
              </button>
            </span>
            <span>
              {e.matchedPaymentDate
                ? `paid ${fmtCurrency(e.matchedPaymentAmount ?? 0)} on ${fmtDate(e.matchedPaymentDate)}`
                : 'no nearby payment found'}
            </span>
            <span style={{ color: e.matched ? '#166534' : '#b91c1c', fontWeight: 600 }}>
              {e.matched ? '✓ matched' : '✕ no match'}
            </span>
          </div>
        ))}
      </div>
      <button style={s.useValuesBtn} onClick={useGuidedValues}>Use these values ↓</button>
    </div>
  );

  return (
    <>
    <div style={s.overlay}>
      <div style={s.modal}>
        <div style={s.header}>
          <h3 style={s.title}>Configure Cash Flow — {accountLabel}</h3>
          <button style={s.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={s.body}>
          <p style={s.desc}>
            Controls how this card's next payment is projected on the Cash Flow page. By default it's
            estimated automatically from this card's own transaction history; use this to override that
            with your card's real payment due day and grace period. The due day is the right thing to
            pin down — issuers are required to keep it fixed every cycle — unlike the statement close
            day, which shifts by a few days depending on how long each month is.
          </p>

          {isManualOverrideActive && (
            <div style={s.currentBox}>
              Currently using a manual override: payment due day <strong>{account.ccPaymentDueDay}</strong>,
              grace period <strong>{account.ccGracePeriodDays}</strong> days.
            </div>
          )}

          <div style={s.tabs}>
            <button style={tab === 'guided' ? s.tabActive : s.tab} onClick={() => setTab('guided')}>
              Guided from statements
            </button>
            <button style={tab === 'auto' ? s.tabActive : s.tab} onClick={() => setTab('auto')}>
              Run automatic analysis
            </button>
            <button style={tab === 'manual' ? s.tabActive : s.tab} onClick={() => setTab('manual')}>
              Enter manually
            </button>
          </div>

          {tab === 'guided' && (
            <div style={s.tabPanel}>
              <p style={s.hint}>
                Look at your last {rows.length} statements and enter the billing period end date and
                payment due date from each (both shown plainly on every statement). We'll derive your
                payment due day and grace period, then check them against transactions we've already synced.
              </p>
              {rows.map((row, i) => (
                <div key={i} style={s.statementRow}>
                  <label style={s.rowField}>
                    Billing period end date
                    <input
                      type="date"
                      style={s.input}
                      value={row.closeDate}
                      onChange={e => updateRow(i, { closeDate: e.target.value })}
                    />
                  </label>
                  <label style={s.rowField}>
                    Payment due date
                    <input
                      type="date"
                      style={s.input}
                      value={row.dueDate}
                      onChange={e => updateRow(i, { dueDate: e.target.value })}
                    />
                  </label>
                  {rows.length > 2 && (
                    <button style={s.removeRowBtn} onClick={() => removeRow(i)} title="Remove this statement">✕</button>
                  )}
                </div>
              ))}
              {rows.length < 6 && (
                <button style={s.addRowBtn} onClick={addRow}>+ Add another statement</button>
              )}

              <button
                style={s.actionBtn}
                onClick={handleCalculateGuided}
                disabled={!canCalculateGuided || guidedLoading}
              >
                {guidedLoading ? 'Calculating…' : 'Calculate'}
              </button>
              {!canCalculateGuided && <p style={s.hint}>Fill in at least 2 statements to calculate.</p>}
              {guidedError && <p style={s.error}>{guidedError}</p>}

              {guidedResultBox}
            </div>
          )}

          {tab === 'auto' && (
            <div style={s.tabPanel}>
              <p style={s.hint}>
                Runs the same automatic heuristic the forecast uses when no override is set, so you can
                preview it before deciding whether to keep it, adjust it, or use the guided method instead.
              </p>
              <button style={s.actionBtn} onClick={handleRunAnalysis} disabled={autoLoading}>
                {autoLoading ? 'Analyzing…' : 'Run Analysis'}
              </button>
              {autoError && <p style={s.error}>{autoError}</p>}
              {autoResult && (
                <div style={s.resultBox}>
                  {autoResult.confidence === 'high' && (
                    <>
                      <p style={s.resultSummary}>
                        <span style={{ color: '#166534' }}>High confidence</span> — payment due day{' '}
                        <strong>{autoResult.paymentDueDay}</strong>, grace period{' '}
                        <strong>{autoResult.gracePeriodDays}</strong> days (fit {autoResult.paymentsFit} of{' '}
                        {autoResult.paymentsConsidered} historical payments).
                      </p>
                      <button style={s.useValuesBtn} onClick={useAutoValues}>Use these values ↓</button>
                    </>
                  )}
                  {autoResult.confidence === 'low' && (
                    <p style={s.resultSummary}>
                      <span style={{ color: '#b45309' }}>Low confidence</span> — no consistent billing cycle
                      found. Approximate mean day-of-month: <strong>{autoResult.fallbackMeanDay}</strong>,
                      mean amount {fmtCurrency(autoResult.fallbackMeanAmount ?? 0)}. Consider the guided
                      statement method instead for a precise override.
                    </p>
                  )}
                  {autoResult.confidence === 'none' && (
                    <p style={s.resultSummary}>
                      Not enough payment history yet to analyze this card automatically.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {tab === 'manual' && (
            <div style={s.tabPanel}>
              <p style={s.hint}>
                Enter the values directly if you already know them, then optionally click Verify to check
                them against your last 3 statements (relative to today's date and the payment due day
                below) using the same routine as the guided method.
              </p>
              <button
                style={s.actionBtn}
                onClick={handleVerifyManual}
                disabled={!canVerifyManual || guidedLoading}
              >
                {guidedLoading ? 'Verifying…' : 'Verify'}
              </button>
              {!canVerifyManual && (
                <p style={s.hint}>Enter a valid payment due day (1–31) and grace period (1–60) below to verify.</p>
              )}
              {guidedError && <p style={s.error}>{guidedError}</p>}
              {guidedResultBox}
            </div>
          )}

          <div style={s.finalFields}>
            <label style={s.rowField}>
              Payment due day (1–31)
              <input
                type="number" min={1} max={31}
                style={s.input}
                value={dueDay}
                onChange={e => setDueDay(e.target.value)}
              />
            </label>
            <label style={s.rowField}>
              Grace period (days)
              <input
                type="number" min={1} max={60}
                style={s.input}
                value={grace}
                onChange={e => setGrace(e.target.value)}
              />
            </label>
          </div>

          {saveError && <p style={s.error}>{saveError}</p>}
        </div>

        <div style={s.footer}>
          {isManualOverrideActive && (
            <button style={s.resetBtn} onClick={handleReset} disabled={saving}>
              Reset to automatic
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button style={s.cancelBtn} onClick={onClose} disabled={saving}>Cancel</button>
          <button style={s.saveBtn} onClick={handleSave} disabled={!canSave || saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>

    {detailEntry && (
      <CCCycleWindowDetailModal
        entry={detailEntry}
        transactions={accountTxns ?? []}
        transactionsLoading={txnsLoading}
        transactionsError={txnsError}
        initialGracePeriodDays={graceNum}
        onApply={({ paymentDueDay, gracePeriodDays }) => {
          setDueDay(String(paymentDueDay));
          setGrace(String(gracePeriodDays));
          setDetailEntry(null);
        }}
        onClose={() => setDetailEntry(null)}
      />
    )}
    </>
  );
};

const s: Record<string, React.CSSProperties> = {
  overlay:   { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' },
  modal:     { background: '#fff', borderRadius: 12, width: '100%', maxWidth: 620, maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.18)', overflow: 'hidden' },
  header:    { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1rem 1.25rem 0.5rem', borderBottom: '1px solid #e2e8f0' },
  title:     { margin: 0, fontSize: '1rem', fontWeight: 600 },
  closeBtn:  { background: 'none', border: 'none', fontSize: '1.1rem', cursor: 'pointer', color: '#6b7280', padding: '2px 6px' },
  body:      { padding: '0.75rem 1.25rem', overflowY: 'auto', flex: 1 },
  desc:      { margin: '0 0 0.75rem', fontSize: '0.85rem', color: '#4a5568', lineHeight: 1.5 },
  currentBox: { background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '0.6rem 0.8rem', fontSize: '0.85rem', color: '#1e3a8a', marginBottom: '0.75rem' },
  tabs:      { display: 'flex', gap: '0.4rem', marginBottom: '0.75rem', flexWrap: 'wrap' },
  tab:       { background: '#fff', color: '#374151', border: '1px solid #d1d5db', borderRadius: 6, padding: '0.4rem 0.8rem', cursor: 'pointer', fontSize: '0.8rem' },
  tabActive: { background: '#0d7a6b', color: '#fff', border: '1px solid #0d7a6b', borderRadius: 6, padding: '0.4rem 0.8rem', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600 },
  tabPanel:  { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.75rem 0.9rem', marginBottom: '0.75rem' },
  hint:      { margin: '0 0 0.6rem', fontSize: '0.78rem', color: '#6b7280', lineHeight: 1.4 },
  statementRow: { display: 'flex', gap: '0.6rem', alignItems: 'flex-end', marginBottom: '0.5rem' },
  rowField:  { display: 'flex', flexDirection: 'column' as const, gap: '0.25rem', fontSize: '0.78rem', color: '#4a5568', fontWeight: 600, flex: 1 },
  input:     { padding: '0.4rem 0.5rem', border: '1px solid #cbd5e0', borderRadius: 5, fontSize: '0.875rem' },
  removeRowBtn: { background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: '0.9rem', padding: '0.4rem' },
  addRowBtn: { background: 'none', border: 'none', color: '#0d7a6b', cursor: 'pointer', fontSize: '0.8rem', padding: '0.2rem 0', textDecoration: 'underline', marginBottom: '0.5rem' },
  actionBtn: { background: '#fff', color: '#0d7a6b', border: '1px solid #0d7a6b', borderRadius: 6, padding: '0.4rem 1rem', cursor: 'pointer', fontSize: '0.85rem' },
  error:     { color: '#dc2626', fontSize: '0.8rem', margin: '0.5rem 0 0' },
  resultBox: { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '0.6rem 0.8rem', marginTop: '0.6rem' },
  resultSummary: { margin: '0 0 0.5rem', fontSize: '0.82rem', color: '#374151', lineHeight: 1.4 },
  entryList: { display: 'flex', flexDirection: 'column' as const, gap: '0.3rem', marginBottom: '0.5rem' },
  entryRow:  { display: 'flex', gap: '0.75rem', fontSize: '0.75rem', color: '#4a5568', flexWrap: 'wrap' as const },
  windowSumLink: { background: 'none', border: 'none', padding: 0, color: '#0d7a6b', textDecoration: 'underline', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600 },
  useValuesBtn: { background: '#0d7a6b', color: '#fff', border: 'none', borderRadius: 6, padding: '0.35rem 0.8rem', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600 },
  finalFields: { display: 'flex', gap: '0.75rem', marginTop: '0.5rem' },
  footer:    { display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.75rem 1.25rem', borderTop: '1px solid #e2e8f0' },
  cancelBtn: { background: 'transparent', color: '#374151', border: '1px solid #d1d5db', borderRadius: 6, padding: '0.4rem 1rem', cursor: 'pointer', fontSize: '0.875rem' },
  saveBtn:   { background: '#0d7a6b', color: '#fff', border: 'none', borderRadius: 6, padding: '0.4rem 1rem', cursor: 'pointer', fontSize: '0.875rem', fontWeight: 600 },
  resetBtn:  { background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: '0.8rem', textDecoration: 'underline' },
};

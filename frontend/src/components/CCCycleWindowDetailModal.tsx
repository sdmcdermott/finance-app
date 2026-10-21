import React, { useMemo, useState } from 'react';
import { Transaction } from '../api/client';
import { fmtCurrency, fmtDate } from '../utils/dates';

export interface CCWindowEntry {
  closeDate: string;
  dueDate: string;
  windowSum: number;
  matchedPaymentDate?: string;
  matchedPaymentAmount?: number;
}

interface Props {
  entry: CCWindowEntry;
  transactions: Transaction[];
  transactionsLoading: boolean;
  transactionsError: string | null;
  initialGracePeriodDays: number;
  onApply: (params: { paymentDueDay: number; gracePeriodDays: number }) => void;
  onClose: () => void;
}

// ── Date helpers (mirror internal/db/cccycle.go's model) ────────────────────

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

function daysInMonth(iso: string): number {
  const d = new Date(iso + 'T00:00:00');
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

// Returns the payment due date exactly one calendar month before the given
// due date, preserving the same day-of-month (clamped for shorter months) —
// the due day is the fixed anchor (see cccycle.go's package doc comment),
// so the previous cycle's due date is always exactly one month earlier.
function prevDueDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  const day = d.getDate();
  const prevMonthFirst = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const lastDay = new Date(prevMonthFirst.getFullYear(), prevMonthFirst.getMonth() + 1, 0).getDate();
  return toISODate(new Date(prevMonthFirst.getFullYear(), prevMonthFirst.getMonth(), Math.min(day, lastDay)));
}

// ── Statement payment detection (mirrors LooksLikeStatementPayment) ─────────

const PAYMENT_KEYWORDS = ['AUTOPAY', 'AUTOMATIC PAYMENT', 'PAYMENT MADE BY'];
function looksLikeStatementPayment(name: string): boolean {
  const upper = name.toUpperCase();
  return PAYMENT_KEYWORDS.some(kw => upper.includes(kw));
}
function isPaymentTxn(t: Transaction): boolean {
  const label = t.merchantName || t.name;
  return t.amount < 0 && looksLikeStatementPayment(label);
}

const TOLERANCE_PCT = 0.01;
const TOLERANCE_MIN = 2;
function withinTolerance(actual: number, expected: number): boolean {
  const tol = Math.max(TOLERANCE_MIN, Math.abs(expected) * TOLERANCE_PCT);
  return Math.abs(actual - expected) <= tol;
}

/**
 * Drill-down for a single guided-cycle entry's window sum: shows the target
 * paid amount, the presumed statement start/end dates, and every
 * transaction in (and just outside) the computed window — highlighted by
 * whether it's actually counted in the sum — so the user can see exactly
 * why a cycle did or didn't match, and interactively adjust the payment due
 * date/grace period while watching the sum recalculate live against the
 * account's own already-loaded transaction history.
 */
export const CCCycleWindowDetailModal: React.FC<Props> = ({
  entry, transactions, transactionsLoading, transactionsError,
  initialGracePeriodDays, onApply, onClose,
}) => {
  const [dueDate, setDueDate] = useState(entry.dueDate);
  const [grace, setGrace] = useState(String(initialGracePeriodDays));

  const graceNum = parseInt(grace, 10) || 0;

  const { statementStart, statementEnd, creditWindowStart, creditWindowEndExclusive, computedSum, rows } = useMemo(() => {
    const close = addDays(dueDate, -graceNum);
    const cycleStart = addDays(close, -(daysInMonth(close) - 1));
    // windowStartExclusive/windowEndInclusive mirror projectNextCycle's
    // lastClose/nextClose in internal/db/cccycle.go. Debits (charges) are
    // counted only within this narrower statement-period window.
    const windowStartExclusive = addDays(cycleStart, -1);
    const windowEndInclusive = close;

    // Credits (refunds/payments-in-kind), on the other hand, appear to get
    // applied against whichever payment is next due regardless of which
    // statement period they technically fall in — a credit posting after
    // the statement closes but before the payment is due still reduces the
    // amount owed. So credits use a wider window keyed to due dates instead
    // of close dates: from the previous due date (inclusive) through just
    // before this due date (exclusive).
    const prevDue = prevDueDate(dueDate);
    const creditStartInclusive = prevDue;
    const creditEndExclusive = dueDate;

    // Display range: union of both windows, padded 6 days on each side, so
    // the table shows everything relevant to either calculation plus
    // immediate context around each boundary.
    const displayStart = (windowStartExclusive < creditStartInclusive ? windowStartExclusive : creditStartInclusive);
    const displayEnd = (windowEndInclusive > creditEndExclusive ? windowEndInclusive : creditEndExclusive);
    const contextStart = addDays(displayStart, -6);
    const contextEnd = addDays(displayEnd, 6);

    let sum = 0;
    const rowsOut: Array<{ date: string; label: string; amount: number; inWindow: boolean; isPayment: boolean }> = [];
    for (const t of transactions) {
      if (t.pending) continue;
      if (t.date < contextStart || t.date > contextEnd) continue;
      const payment = isPaymentTxn(t);
      const isDebitInWindow = !payment && t.amount > 0 && t.date > windowStartExclusive && t.date <= windowEndInclusive;
      const isCreditInWindow = !payment && t.amount < 0 && t.date >= creditStartInclusive && t.date < creditEndExclusive;
      const inWindow = isDebitInWindow || isCreditInWindow;
      if (inWindow) sum += t.amount;
      rowsOut.push({ date: t.date, label: t.merchantName || t.name, amount: t.amount, inWindow, isPayment: payment });
    }
    rowsOut.sort((a, b) => a.date.localeCompare(b.date));

    return {
      statementStart: addDays(windowStartExclusive, 1),
      statementEnd: windowEndInclusive,
      creditWindowStart: creditStartInclusive,
      creditWindowEndExclusive: creditEndExclusive,
      computedSum: sum,
      rows: rowsOut,
    };
  }, [dueDate, graceNum, transactions]);

  const matches = entry.matchedPaymentAmount !== undefined && withinTolerance(computedSum, entry.matchedPaymentAmount);

  const handleApply = () => {
    const d = new Date(dueDate + 'T00:00:00');
    onApply({ paymentDueDay: d.getDate(), gracePeriodDays: graceNum });
  };

  return (
    <div style={s.overlay}>
      <div style={s.modal}>
        <div style={s.header}>
          <h3 style={s.title}>Cycle Detail</h3>
          <button style={s.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={s.body}>
          <div style={s.summaryRow}>
            <div style={s.summaryCell}>
              <div style={s.summaryLabel}>Target paid amount</div>
              <div style={s.summaryValue}>
                {entry.matchedPaymentAmount !== undefined ? fmtCurrency(entry.matchedPaymentAmount) : 'no nearby payment'}
              </div>
              {entry.matchedPaymentDate && <div style={s.small}>on {fmtDate(entry.matchedPaymentDate)}</div>}
            </div>
            <div style={s.summaryCell}>
              <div style={s.summaryLabel}>Presumed statement range (debits)</div>
              <div style={s.summaryValue}>{fmtDate(statementStart)} – {fmtDate(statementEnd)}</div>
            </div>
            <div style={s.summaryCell}>
              <div style={s.summaryLabel}>Credits counted (prior due → this due)</div>
              <div style={s.summaryValue}>{fmtDate(creditWindowStart)} – {fmtDate(addDays(creditWindowEndExclusive, -1))}</div>
            </div>
            <div style={s.summaryCell}>
              <div style={s.summaryLabel}>Computed window sum</div>
              <div style={{ ...s.summaryValue, color: entry.matchedPaymentAmount === undefined ? '#1a202c' : matches ? '#166534' : '#dc2626' }}>
                {fmtCurrency(computedSum)}
              </div>
            </div>
          </div>

          <div style={s.adjustRow}>
            <label style={s.field}>
              Payment due date
              <input type="date" style={s.input} value={dueDate} onChange={e => setDueDate(e.target.value)} />
            </label>
            <label style={s.field}>
              Grace period (days)
              <input type="number" min={1} max={60} style={s.input} value={grace} onChange={e => setGrace(e.target.value)} />
            </label>
          </div>
          <p style={s.hint}>
            Adjust either value above to see the window sum recalculate live against this card's own
            transaction history. Debits (charges) are counted only within the statement period above;
            credits (refunds) are counted separately, from the prior payment's due date up to (but not
            including) this payment's due date — issuers appear to apply late-posting credits against
            whichever payment is next due, not just the statement they technically fall within. Yellow
            rows are counted in the sum; gray rows are shown for context but fall outside both windows.
          </p>

          {transactionsError && <p style={s.error}>{transactionsError}</p>}
          {transactionsLoading ? (
            <p style={s.hint}>Loading transactions…</p>
          ) : rows.length === 0 ? (
            !transactionsError && <p style={s.hint}>No transactions found near this window.</p>
          ) : (
            <div style={s.tableWrap}>
              <table style={s.table}>
                <thead>
                  <tr>
                    <th style={s.th}>Date</th>
                    <th style={s.th}>Transaction</th>
                    <th style={{ ...s.th, textAlign: 'right' }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} style={r.inWindow ? s.trIn : s.trOut}>
                      <td style={r.inWindow ? s.tdIn : s.tdOut}>{fmtDate(r.date)}</td>
                      <td style={{ ...(r.inWindow ? s.tdIn : s.tdOut), ...s.labelCell }}>
                        {r.label}{r.isPayment ? ' (payment — excluded)' : ''}
                      </td>
                      <td style={{
                        ...(r.inWindow ? s.tdIn : s.tdOut),
                        textAlign: 'right',
                        fontVariantNumeric: 'tabular-nums',
                        color: r.amount >= 0 ? '#dc2626' : '#166534',
                        fontWeight: 600,
                      }}>
                        {r.amount >= 0 ? '-' : '+'}{fmtCurrency(r.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div style={s.footer}>
          <button style={s.cancelBtn} onClick={onClose}>Close</button>
          <button style={s.applyBtn} onClick={handleApply}>Use these values ↓</button>
        </div>
      </div>
    </div>
  );
};

const s: Record<string, React.CSSProperties> = {
  overlay:   { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' },
  modal:     { background: '#fff', borderRadius: 12, width: '100%', maxWidth: 680, maxHeight: '88vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.18)', overflow: 'hidden' },
  header:    { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1rem 1.25rem 0.5rem', borderBottom: '1px solid #e2e8f0' },
  title:     { margin: 0, fontSize: '1rem', fontWeight: 600 },
  closeBtn:  { background: 'none', border: 'none', fontSize: '1.1rem', cursor: 'pointer', color: '#6b7280', padding: '2px 6px' },
  body:      { padding: '0.9rem 1.25rem', overflowY: 'auto', flex: 1 },
  summaryRow: { display: 'flex', gap: '1rem', paddingBottom: '0.75rem', borderBottom: '1px solid #e2e8f0', marginBottom: '0.75rem', flexWrap: 'wrap' },
  summaryCell: { flex: 1, minWidth: 150 },
  summaryLabel: { fontSize: '0.72rem', color: '#6b7280', marginBottom: 2 },
  summaryValue: { fontSize: '0.95rem', fontWeight: 600, color: '#1a202c' },
  small:     { fontSize: '0.72rem', color: '#6b7280', marginTop: 2 },
  adjustRow: { display: 'flex', gap: '0.75rem', marginBottom: '0.5rem' },
  field:     { display: 'flex', flexDirection: 'column' as const, gap: '0.25rem', fontSize: '0.78rem', color: '#4a5568', fontWeight: 600, flex: 1 },
  input:     { padding: '0.4rem 0.5rem', border: '1px solid #cbd5e0', borderRadius: 5, fontSize: '0.875rem' },
  hint:      { margin: '0 0 0.6rem', fontSize: '0.75rem', color: '#6b7280', lineHeight: 1.4 },
  error:     { color: '#dc2626', fontSize: '0.8rem', margin: '0 0 0.5rem' },
  tableWrap: { overflowY: 'auto', maxHeight: 320 },
  table:     { width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' },
  th:        { textAlign: 'left', padding: '0.4rem 0.6rem', background: '#f7fafc', borderBottom: '2px solid #e2e8f0', fontWeight: 600, color: '#4a5568', whiteSpace: 'nowrap', position: 'sticky' as const, top: 0 },
  trIn:      { borderBottom: '1px solid #fde68a', background: '#fef9c3' },
  trOut:     { borderBottom: '1px solid #e5e7eb', background: '#f3f4f6' },
  tdIn:      { padding: '0.35rem 0.6rem', color: '#1a202c' },
  tdOut:     { padding: '0.35rem 0.6rem', color: '#6b7280' },
  labelCell: { maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  footer:    { display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', padding: '0.75rem 1.25rem', borderTop: '1px solid #e2e8f0' },
  cancelBtn: { background: 'transparent', color: '#374151', border: '1px solid #d1d5db', borderRadius: 6, padding: '0.4rem 1rem', cursor: 'pointer', fontSize: '0.875rem' },
  applyBtn:  { background: '#0d7a6b', color: '#fff', border: 'none', borderRadius: 6, padding: '0.4rem 1rem', cursor: 'pointer', fontSize: '0.875rem', fontWeight: 600 },
};

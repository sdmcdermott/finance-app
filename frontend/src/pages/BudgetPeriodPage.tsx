import React, { useEffect, useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Budget, BudgetPeriod, BudgetTxn,
  getBudgetPeriods, closeBudgetPeriod,
} from '../api/client';
import { fmtDate } from '../utils/dates';
import { fmtCurrency } from '../utils/dates';

const fmt = fmtCurrency;

// ── Close Period confirmation modal ──────────────────────────────────────────
const surplusDescription = (budget: Budget, period: BudgetPeriod): string => {
  const delta = period.liveDelta;
  const abs = fmt(delta);
  const sign = delta >= 0 ? 'surplus' : 'shortfall';
  const signedAmt = `${sign} of ${abs}`;

  switch (budget.surplusHandling) {
    case 'rollover':
      return delta >= 0
        ? `The ${signedAmt} will be rolled over into the next period, increasing its effective goal.`
        : `The ${signedAmt} will be rolled over into the next period, reducing its effective goal.`;
    case 'transfer': {
      const amount = budget.transferAmount > 0 ? fmt(budget.transferAmount) : abs;
      return `${amount} will be transferred to the configured destination budget.`;
    }
    case 'ignore':
    default:
      return `The ${signedAmt} will be discarded.`;
  }
};

const ClosePeriodModal: React.FC<{
  period: BudgetPeriod;
  budget: Budget;
  onCancel: () => void;
  onConfirm: () => void;
  closing: boolean;
}> = ({ period, budget, onCancel, onConfirm, closing }) => (
  <div style={cm.overlay}>
    <div style={cm.box}>
      <div style={cm.header}>
        <span style={cm.title}>Close Period</span>
        <button style={cm.closeBtn} onClick={onCancel} disabled={closing}>✕</button>
      </div>
      <p style={cm.periodName}>{period.label}</p>
      <p style={cm.body}>
        Closing this period will finalise its totals and apply your configured
        surplus/shortfall handling.
      </p>
      <div style={cm.rule}>
        <span style={cm.ruleLabel}>Surplus handling</span>
        <span style={cm.ruleValue}>
          {budget.surplusHandling || 'ignore'} — {surplusDescription(budget, period)}
        </span>
      </div>
      <p style={cm.warning}>This cannot be undone.</p>
      <div style={cm.actions}>
        <button style={cm.cancelBtn} onClick={onCancel} disabled={closing}>Cancel</button>
        <button style={cm.confirmBtn} onClick={onConfirm} disabled={closing}>
          {closing ? 'Closing…' : 'Close Period'}
        </button>
      </div>
    </div>
  </div>
);

const cm: Record<string, React.CSSProperties> = {
  overlay:    { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' },
  box:        { background: '#fff', borderRadius: 10, padding: '1.25rem 1.5rem', width: '100%', maxWidth: 420, boxShadow: '0 8px 32px rgba(0,0,0,0.18)', display: 'flex', flexDirection: 'column', gap: '0.75rem' },
  header:     { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  title:      { fontWeight: 700, fontSize: '1rem', color: '#2d3748' },
  closeBtn:   { background: 'none', border: 'none', cursor: 'pointer', color: '#718096', fontSize: '1rem', padding: 0 },
  periodName: { margin: 0, fontWeight: 600, color: '#0d7a6b', fontSize: '0.95rem' },
  body:       { margin: 0, fontSize: '0.875rem', color: '#4a5568' },
  rule:       { background: '#f7f8fc', border: '1px solid #e2e8f0', borderRadius: 6, padding: '0.6rem 0.75rem', fontSize: '0.82rem', display: 'flex', flexDirection: 'column', gap: '0.2rem' },
  ruleLabel:  { color: '#718096', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: '0.72rem' },
  ruleValue:  { color: '#2d3748' },
  warning:    { margin: 0, fontSize: '0.8rem', color: '#c53030' },
  actions:    { display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.25rem' },
  cancelBtn:  { background: 'none', border: '1px solid #0d7a6b', borderRadius: 6, padding: '0.4rem 0.9rem', cursor: 'pointer', fontSize: '0.875rem', color: '#0d7a6b' },
  confirmBtn: { background: '#e53e3e', color: '#fff', border: 'none', borderRadius: 6, padding: '0.4rem 1rem', cursor: 'pointer', fontSize: '0.875rem', fontWeight: 600 },
};

const ReClosePeriodModal: React.FC<{
  period: BudgetPeriod;
  onCancel: () => void;
  onConfirm: () => void;
  closing: boolean;
}> = ({ period, onCancel, onConfirm, closing }) => (
  <div style={cm.overlay}>
    <div style={cm.box}>
      <div style={cm.header}>
        <span style={cm.title}>Re-close Period</span>
        <button style={cm.closeBtn} onClick={onCancel} disabled={closing}>✕</button>
      </div>
      <p style={cm.periodName}>{period.label}</p>
      <p style={cm.body}>
        This will recompute the delta using current transactions and update the
        next period's carry-in amount to match.
      </p>
      <p style={cm.warning}>This will overwrite the next period's carried-in amount.</p>
      <div style={cm.actions}>
        <button style={cm.cancelBtn} onClick={onCancel} disabled={closing}>Cancel</button>
        <button style={cm.confirmBtn} onClick={onConfirm} disabled={closing}>
          {closing ? 'Re-closing…' : 'Re-close Period'}
        </button>
      </div>
    </div>
  </div>
);


type SortKey = 'date' | 'amount';
type SortDir = 'asc' | 'desc';

const TransactionTable: React.FC<{
  txns: BudgetTxn[];
  isGoal: boolean;
  effectiveGoal: number;
  goalDirection: string;
}> = ({ txns, isGoal, effectiveGoal, goalDirection }) => {
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const sorted = useMemo(() => {
    return txns.slice().sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'date') cmp = a.date.localeCompare(b.date);
      else cmp = a.amount - b.amount;
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [txns, sortKey, sortDir]);

  // Running total in date-asc order (always), regardless of current sort
  const dateSorted = useMemo(() =>
    txns.slice().sort((a, b) => a.date.localeCompare(b.date)),
    [txns]
  );
  const runningTotals = useMemo(() => {
    const map: Record<string, number> = {};
    let running = 0;
    dateSorted.forEach((t) => {
      running += t.amount > 0 ? t.amount : 0; // only debits toward goal
      map[t.dateTransactionId + t.date + t.amount] = running;
    });
    return map;
  }, [dateSorted]);

  const toggle = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  const arrow = (key: SortKey) => sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';

  if (txns.length === 0) return <div style={ts.empty}>No transactions in this period.</div>;

  return (
    <div style={ts.wrap}>
      <table style={ts.table}>
        <thead>
          <tr>
            <th style={ts.th} onClick={() => toggle('date')} className="sortable-th">
              Date{arrow('date')}
            </th>
            <th style={ts.th}>Name</th>
            <th style={{ ...ts.th, textAlign: 'right' }} onClick={() => toggle('amount')} className="sortable-th">
              Amount{arrow('amount')}
            </th>
            {isGoal && <th style={{ ...ts.th, textAlign: 'right' }}>Running Total</th>}
            {isGoal && <th style={{ ...ts.th, textAlign: 'right' }}>Remaining</th>}
          </tr>
        </thead>
        <tbody>
          {sorted.map((t, i) => {
            const key = t.dateTransactionId + t.date + t.amount;
            const running = runningTotals[key] ?? 0;
            const remaining = effectiveGoal > 0 ? effectiveGoal - running : 0;
            const remainPct = effectiveGoal > 0 ? (remaining / effectiveGoal) * 100 : 0;
            const isDebit = t.amount > 0;
            return (
              <tr key={i} style={i % 2 === 0 ? ts.rowEven : ts.rowOdd}>
                <td style={ts.td}>{fmtDate(t.date)}</td>
                <td style={ts.td}>
                  {t.name}
                  {t.isSplit && <span style={ts.splitBadge}>split</span>}
                </td>
                <td style={{ ...ts.td, textAlign: 'right', color: isDebit ? '#e53e3e' : '#38a169', fontVariantNumeric: 'tabular-nums' }}>
                  {isDebit ? '' : '+'}{fmt(t.amount)}
                </td>
                {isGoal && (
                  <td style={{ ...ts.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {fmt(running)}
                  </td>
                )}
                {isGoal && (
                  <td style={{ ...ts.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    <span style={{ color: remaining <= 0 ? '#e53e3e' : '#38a169' }}>
                      {remaining <= 0 ? `-${fmtCurrency(Math.abs(remaining))}` : fmt(remaining)}
                    </span>
                    {effectiveGoal > 0 && (
                      <span style={{ color: '#718096', fontSize: '0.78rem', marginLeft: 4 }}>
                        ({remainPct.toFixed(0)}%)
                      </span>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

const ts: Record<string, React.CSSProperties> = {
  wrap: { overflowX: 'auto', marginTop: '1rem' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' },
  th: { padding: '0.45rem 0.6rem', textAlign: 'left', borderBottom: '2px solid #e2e8f0', color: '#4a5568', fontWeight: 600, whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none' },
  td: { padding: '0.4rem 0.6rem', borderBottom: '1px solid #f0f0f0', verticalAlign: 'middle' },
  rowEven: { background: '#fff' },
  rowOdd: { background: '#f9fafb' },
  splitBadge: { background: '#e9d8fd', color: '#553c9a', borderRadius: 8, padding: '0 5px', fontSize: '0.7rem', marginLeft: 5, verticalAlign: 'middle' },
  empty: { color: '#718096', fontSize: '0.875rem', marginTop: '0.75rem' },
};

const GoalBar: React.FC<{ debits: number; goal: number; direction: string }> = ({ debits, goal, direction }) => {
  if (goal <= 0) return null;
  const pct = Math.min((debits / goal) * 100, 100);
  const over = debits > goal;
  const barColor = direction === 'limit'
    ? (over ? '#e53e3e' : pct > 80 ? '#dd6b20' : '#38a169')
    : (over ? '#38a169' : '#0d7a6b');

  return (
    <div style={bar.wrap}>
      <div style={bar.track}>
        <div style={{ ...bar.fill, width: `${pct}%`, background: barColor }} />
      </div>
      <div style={bar.labels}>
        <span style={{ color: barColor, fontWeight: 600 }}>{fmt(debits)} spent</span>
        <span style={{ color: '#718096' }}>goal: {fmt(goal)}</span>
      </div>
    </div>
  );
};

const bar: Record<string, React.CSSProperties> = {
  wrap: { marginBottom: '0.5rem' },
  track: { height: 10, background: '#e2e8f0', borderRadius: 5, overflow: 'hidden', marginBottom: '0.3rem' },
  fill: { height: '100%', borderRadius: 5, transition: 'width 0.3s' },
  labels: { display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' },
};

const BudgetPeriodPage: React.FC = () => {
  const { budgetId } = useParams<{ budgetId: string }>();
  const navigate = useNavigate();

  const [budget, setBudget] = useState<Budget | null>(null);
  const [periods, setPeriods] = useState<BudgetPeriod[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [closeMsg, setCloseMsg] = useState<string | null>(null);
  const [confirmingClose, setConfirmingClose] = useState<BudgetPeriod | null>(null);
  const [reCloseTarget, setReCloseTarget] = useState<BudgetPeriod | null>(null);

  useEffect(() => {
    if (budgetId) load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [budgetId]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await getBudgetPeriods(budgetId!);
      setBudget(resp.budget);
      setPeriods(resp.periods);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleClose = async (p: BudgetPeriod) => {
    setConfirmingClose(p);
  };

  const handleReClose = (p: BudgetPeriod) => {
    setReCloseTarget(p);
  };

  const executeClose = async (force = false) => {
    const p = force ? reCloseTarget : confirmingClose;
    if (!p) return;
    setClosing(p.startDate);
    setCloseMsg(null);
    setError(null);
    try {
      const result = await closeBudgetPeriod(budgetId!, p.startDate, force);
      const sign = result.delta >= 0 ? '+' : '';
      setCloseMsg(`Period ${force ? 're-closed' : 'closed'}. Delta: ${sign}${fmt(result.delta)}.`);
      setConfirmingClose(null);
      setReCloseTarget(null);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setClosing(null);
    }
  };

  if (loading) return <div className="page"><div style={s.empty}>Loading...</div></div>;
  if (!budget) return <div className="page"><div style={s.empty}>Budget not found.</div></div>;

  return (
    <div className="page">
      {confirmingClose && budget && (
        <ClosePeriodModal
          period={confirmingClose}
          budget={budget}
          onCancel={() => setConfirmingClose(null)}
          onConfirm={() => executeClose(false)}
          closing={closing === confirmingClose.startDate}
        />
      )}
      {reCloseTarget && budget && (
        <ReClosePeriodModal
          period={reCloseTarget}
          onCancel={() => setReCloseTarget(null)}
          onConfirm={() => executeClose(true)}
          closing={closing === reCloseTarget.startDate}
        />
      )}
      <div style={s.breadcrumb}>
        <button style={s.backBtn} onClick={() => navigate('/budgets')}>← Budgets</button>
      </div>

      <div className="page-header">
        <div>
          <h2 style={s.title}>{budget.name}</h2>
          <span style={budget.budgetType === 'goal' ? s.badgeGoal : s.badgeCheck}>{budget.budgetType}</span>
          <span style={s.periodBadge}>{budget.period}</span>
        </div>
      </div>

      {error && <div style={s.error}>{error}</div>}
      {closeMsg && <div style={s.success}>{closeMsg}</div>}

      {periods.length === 0 ? (
        <div style={s.empty}>No periods yet. They are created automatically when you view this page.</div>
      ) : (
        <div className="period-list">
          {periods.map((p) => (
            <div key={p.startDate} className="period-card" style={{ opacity: p.closed ? 0.7 : 1 }}>
              <div className="period-header">
                <div>
                  <div style={s.periodLabel}>{p.label}</div>
                  <div style={s.periodDates}>{fmtDate(p.startDate)} → {fmtDate(p.endDate)}</div>
                </div>
                <div style={s.periodStatus}>
                  {p.closed
                    ? <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <span style={s.closedBadge}>Closed</span>
                        <button
                          style={s.reCloseBtn}
                          onClick={() => handleReClose(p)}
                          disabled={closing === p.startDate}
                          title="Recompute delta and update next period's carry-in"
                        >
                          {closing === p.startDate ? 'Re-closing…' : 'Re-close'}
                        </button>
                      </div>
                    : <button
                        style={s.closeBtn}
                        className="close-btn-mobile"
                        onClick={() => handleClose(p)}
                        disabled={closing === p.startDate}
                      >
                        {closing === p.startDate ? 'Closing...' : 'Close Period'}
                      </button>
                  }
                </div>
              </div>

              {budget.budgetType === 'goal' ? (
                <div style={s.stats}>
                  {p.closed && p.staleWarning && (
                    <div style={s.staleWarning}>
                      Late transactions arrived after this period was closed. Totals may be incorrect.{' '}
                      <button style={s.staleReCloseBtn} onClick={() => handleReClose(p)}>Re-close now</button>
                    </div>
                  )}
                  <GoalBar debits={p.debitTotal} goal={p.effectiveGoal} direction={budget.goalDirection} />
                  <div className="stat-row">
                    <StatBox label="Debits" value={fmt(p.debitTotal)} color="#e53e3e" />
                    <StatBox label="Effective Goal" value={fmt(p.effectiveGoal)} color="#0d7a6b" />
                    {p.rolledOverAmount !== 0 && (
                      <StatBox
                        label="Carried In"
                        value={(p.rolledOverAmount >= 0 ? '+' : '') + fmt(p.rolledOverAmount)}
                        color="#0d7a6b"
                      />
                    )}
                    {p.closed && budget.surplusHandling === 'rollover' && (
                      <StatBox
                        label="Rolled Out"
                        value={(p.liveDelta >= 0 ? '+' : '-') + fmt(p.liveDelta)}
                        color={p.liveDelta >= 0 ? '#38a169' : '#e53e3e'}
                      />
                    )}
                    {p.transferredOut !== 0 && <StatBox label="Transferred Out" value={fmt(p.transferredOut)} color="#718096" />}
                  </div>
                  <TransactionTable
                    txns={p.transactions ?? []}
                    isGoal={true}
                    effectiveGoal={p.effectiveGoal}
                    goalDirection={budget.goalDirection}
                  />
                </div>
              ) : (
                <div style={s.stats}>
                  {p.closed && p.staleWarning && (
                    <div style={s.staleWarning}>
                      Late transactions arrived after this period was closed. Totals may be incorrect.{' '}
                      <button style={s.staleReCloseBtn} onClick={() => handleReClose(p)}>Re-close now</button>
                    </div>
                  )}
                  <div style={s.balanceDisplay}>
                    <span style={{ color: p.balance >= 0 ? '#38a169' : '#e53e3e', fontSize: '1.5rem', fontWeight: 700 }}>
                      {p.balance >= 0 ? '' : '-'}{fmt(p.balance)}
                    </span>
                    <span style={{ color: '#718096', fontSize: '0.85rem', marginLeft: 8 }}>balance</span>
                  </div>
                  <div className="stat-row">
                    <StatBox label="Credits" value={fmt(p.creditTotal)} color="#38a169" />
                    <StatBox label="Debits" value={fmt(p.debitTotal)} color="#e53e3e" />
                    {p.rolledOverAmount !== 0 && (
                      <StatBox
                        label="Carried In"
                        value={(p.rolledOverAmount >= 0 ? '+' : '') + fmt(p.rolledOverAmount)}
                        color="#0d7a6b"
                      />
                    )}
                    {p.closed && budget.surplusHandling === 'rollover' && (
                      <StatBox
                        label="Rolled Out"
                        value={(p.liveDelta >= 0 ? '+' : '-') + fmt(p.liveDelta)}
                        color={p.liveDelta >= 0 ? '#38a169' : '#e53e3e'}
                      />
                    )}
                    {p.transferredOut !== 0 && <StatBox label="Transferred Out" value={fmt(p.transferredOut)} color="#718096" />}
                  </div>
                  <TransactionTable
                    txns={p.transactions ?? []}
                    isGoal={false}
                    effectiveGoal={0}
                    goalDirection=""
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const StatBox: React.FC<{ label: string; value: string; color: string }> = ({ label, value, color }) => (
  <div className="stat-box">
    <div style={{ fontSize: '1.05rem', fontWeight: 700, color }}>{value}</div>
    <div style={{ fontSize: '0.75rem', color: '#718096', marginTop: 2 }}>{label}</div>
  </div>
);

const s: Record<string, React.CSSProperties> = {
  breadcrumb: { marginBottom: '0.75rem' },
  backBtn: { background: 'none', border: 'none', color: '#0d7a6b', cursor: 'pointer', fontSize: '0.875rem', padding: 0 },
  title: { margin: '0 0 0.4rem', fontSize: '1.2rem', fontWeight: 700 },
  badgeGoal: { background: '#fef9e7', color: '#856a00', borderRadius: 12, padding: '0.1rem 0.6rem', fontSize: '0.78rem', fontWeight: 600, marginRight: 6 },
  badgeCheck: { background: '#f0fff4', color: '#276749', borderRadius: 12, padding: '0.1rem 0.6rem', fontSize: '0.78rem', fontWeight: 600, marginRight: 6 },
  periodBadge: { background: '#edf2f7', color: '#4a5568', borderRadius: 12, padding: '0.1rem 0.6rem', fontSize: '0.78rem' },
  periodLabel: { fontWeight: 600, fontSize: '0.95rem', marginBottom: 2 },
  periodDates: { fontSize: '0.8rem', color: '#718096' },
  periodStatus: { display: 'flex', alignItems: 'center' },
  closeBtn: { background: '#0d7a6b', color: '#fff', border: 'none', borderRadius: 6, padding: '0.35rem 0.85rem', cursor: 'pointer', fontSize: '0.8rem', whiteSpace: 'nowrap' },
  closedBadge: { background: '#e2e8f0', color: '#718096', borderRadius: 12, padding: '0.15rem 0.6rem', fontSize: '0.78rem' },
  reCloseBtn: { background: 'none', border: '1px solid #cbd5e0', borderRadius: 6, padding: '0.25rem 0.6rem', cursor: 'pointer', fontSize: '0.75rem', color: '#718096' },
  stats: { marginTop: '0.5rem' },
  balanceDisplay: { display: 'flex', alignItems: 'baseline', marginBottom: '0.5rem' },
  empty: { textAlign: 'center', color: '#718096', marginTop: '3rem' },
  error: { background: '#fff5f5', color: '#c53030', border: '1px solid #feb2b2', borderRadius: 6, padding: '0.75rem 1rem', marginBottom: '1rem' },
  success: { background: '#f0fff4', color: '#276749', border: '1px solid #9ae6b4', borderRadius: 6, padding: '0.75rem 1rem', marginBottom: '1rem' },
  staleWarning: { background: '#fffbeb', color: '#92400e', border: '1px solid #fcd34d', borderRadius: 6, padding: '0.6rem 0.85rem', marginBottom: '0.75rem', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' as const },
  staleReCloseBtn: { background: 'none', border: '1px solid #92400e', borderRadius: 5, padding: '0.2rem 0.6rem', cursor: 'pointer', fontSize: '0.8rem', color: '#92400e', fontWeight: 600, whiteSpace: 'nowrap' as const },
};

export default BudgetPeriodPage;

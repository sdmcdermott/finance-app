import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Budget, BudgetPeriod,
  getBudgetPeriods, closeBudgetPeriod,
} from '../api/client';

const fmt = (n: number) => `$${Math.abs(n).toFixed(2)}`;

const GoalBar: React.FC<{ debits: number; goal: number; direction: string }> = ({ debits, goal, direction }) => {
  if (goal <= 0) return null;
  const pct = Math.min((debits / goal) * 100, 100);
  const over = debits > goal;
  const barColor = direction === 'limit'
    ? (over ? '#e53e3e' : pct > 80 ? '#dd6b20' : '#38a169')
    : (over ? '#38a169' : '#4f46e5');

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
    if (!window.confirm(`Close period "${p.label}"? This will apply the configured surplus/shortfall handling.`)) return;
    setClosing(p.startDate);
    setCloseMsg(null);
    setError(null);
    try {
      const result = await closeBudgetPeriod(budgetId!, p.startDate);
      const sign = result.delta >= 0 ? '+' : '';
      setCloseMsg(`Period closed. Delta: ${sign}${fmt(result.delta)}.`);
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
                  <div style={s.periodDates}>{p.startDate} → {p.endDate}</div>
                </div>
                <div style={s.periodStatus}>
                  {p.closed
                    ? <span style={s.closedBadge}>Closed</span>
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
                  <GoalBar debits={p.debitTotal} goal={p.effectiveGoal} direction={budget.goalDirection} />
                  <div className="stat-row">
                    <StatBox label="Debits" value={fmt(p.debitTotal)} color="#e53e3e" />
                    <StatBox label="Effective Goal" value={fmt(p.effectiveGoal)} color="#4f46e5" />
                    {p.rolledOverAmount !== 0 && (
                      <StatBox
                        label="Rolled Over"
                        value={(p.rolledOverAmount >= 0 ? '+' : '') + fmt(p.rolledOverAmount)}
                        color={p.rolledOverAmount >= 0 ? '#38a169' : '#e53e3e'}
                      />
                    )}
                    {p.transferredOut !== 0 && <StatBox label="Transferred Out" value={fmt(p.transferredOut)} color="#718096" />}
                  </div>
                </div>
              ) : (
                <div style={s.stats}>
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
                        color="#4f46e5"
                      />
                    )}
                    {p.transferredOut !== 0 && <StatBox label="Transferred Out" value={fmt(p.transferredOut)} color="#718096" />}
                  </div>
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
  backBtn: { background: 'none', border: 'none', color: '#4f46e5', cursor: 'pointer', fontSize: '0.875rem', padding: 0 },
  title: { margin: '0 0 0.4rem', fontSize: '1.2rem', fontWeight: 700 },
  badgeGoal: { background: '#ebf4ff', color: '#2b6cb0', borderRadius: 12, padding: '0.1rem 0.6rem', fontSize: '0.78rem', fontWeight: 600, marginRight: 6 },
  badgeCheck: { background: '#f0fff4', color: '#276749', borderRadius: 12, padding: '0.1rem 0.6rem', fontSize: '0.78rem', fontWeight: 600, marginRight: 6 },
  periodBadge: { background: '#edf2f7', color: '#4a5568', borderRadius: 12, padding: '0.1rem 0.6rem', fontSize: '0.78rem' },
  periodLabel: { fontWeight: 600, fontSize: '0.95rem', marginBottom: 2 },
  periodDates: { fontSize: '0.8rem', color: '#718096' },
  periodStatus: { display: 'flex', alignItems: 'center' },
  closeBtn: { background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 6, padding: '0.35rem 0.85rem', cursor: 'pointer', fontSize: '0.8rem', whiteSpace: 'nowrap' },
  closedBadge: { background: '#e2e8f0', color: '#718096', borderRadius: 12, padding: '0.15rem 0.6rem', fontSize: '0.78rem' },
  stats: { marginTop: '0.5rem' },
  balanceDisplay: { display: 'flex', alignItems: 'baseline', marginBottom: '0.5rem' },
  empty: { textAlign: 'center', color: '#718096', marginTop: '3rem' },
  error: { background: '#fff5f5', color: '#c53030', border: '1px solid #feb2b2', borderRadius: 6, padding: '0.75rem 1rem', marginBottom: '1rem' },
  success: { background: '#f0fff4', color: '#276749', border: '1px solid #9ae6b4', borderRadius: 6, padding: '0.75rem 1rem', marginBottom: '1rem' },
};

export default BudgetPeriodPage;

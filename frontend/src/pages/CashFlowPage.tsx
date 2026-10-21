import React, { useEffect, useState, useCallback } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from 'recharts';
import { getCashFlowForecast, CashFlowForecast, CashFlowEvent } from '../api/client';
import { fmtCurrency, fmtDate } from '../utils/dates';
import { CreditCardPaymentDetailModal } from '../components/CreditCardPaymentDetailModal';

const HORIZON_OPTIONS = [30, 60, 90];

const TYPE_LABELS: Record<CashFlowEvent['type'], string> = {
  income: 'Income',
  fixedCost: 'Fixed cost',
  creditCardPayment: 'Credit card payment',
};

const TYPE_COLORS: Record<CashFlowEvent['type'], string> = {
  income: '#0d7a6b',
  fixedCost: '#dc2626',
  creditCardPayment: '#b45309',
};

// Splits a credit card payment label like "Chase ...1234 payment est" into
// its base text and the trailing "est"/"approx"/"manual" qualifier, so the
// qualifier can be rendered as a clickable chip instead of plain text.
const LABEL_SUFFIX_RE = /^(.*?)\s*(est|approx|manual)\s*$/;
function splitLabel(label: string): { base: string; suffix: string | null } {
  const m = label.match(LABEL_SUFFIX_RE);
  return m ? { base: m[1], suffix: m[2] } : { base: label, suffix: null };
}

const CashFlowPage: React.FC = () => {
  const [horizon, setHorizon] = useState(60);
  const [forecast, setForecast] = useState<CashFlowForecast | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detailEvent, setDetailEvent] = useState<CashFlowEvent | null>(null);

  const load = useCallback(async (days: number) => {
    setLoading(true);
    setError(null);
    try {
      const result = await getCashFlowForecast(days);
      setForecast(result);
    } catch (e: any) {
      setError(e.response?.data?.error ?? e.message ?? 'Failed to load forecast');
      setForecast(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(horizon); }, [horizon, load]);

  const chartData = (forecast?.series ?? []).map(p => ({ date: p.date, balance: p.balance }));
  const minBalance = chartData.length > 0 ? Math.min(...chartData.map(p => p.balance)) : 0;
  const goesNegative = minBalance < 0;

  return (
    <div style={s.page}>
      <div style={s.header}>
        <h2 style={s.title}>Cash Flow Forecast</h2>
        <div style={s.horizonGroup}>
          {HORIZON_OPTIONS.map(h => (
            <button
              key={h}
              style={horizon === h ? s.horizonBtnActive : s.horizonBtn}
              onClick={() => setHorizon(h)}
            >
              {h} days
            </button>
          ))}
        </div>
      </div>

      {loading && <p style={s.muted}>Loading forecast…</p>}
      {error && (
        <div style={s.errorBox}>
          {error}
          {error.toLowerCase().includes('cash account') && (
            <p style={{ margin: '0.5rem 0 0' }}>
              Go to the <a href="/accounts">Accounts page</a> and designate one account as your
              "cash account" to enable forecasting.
            </p>
          )}
        </div>
      )}

      {!loading && !error && forecast && (
        <>
          <div style={s.summaryBar}>
            <div style={s.summaryCell}>
              <div style={s.summaryLabel}>Starting balance</div>
              <div style={s.summaryValue}>{fmtCurrency(forecast.startingBalance)}</div>
              <div style={s.balanceAsOf}>
                {forecast.balanceUpdatedAt ? `as of ${fmtDate(forecast.balanceUpdatedAt)}` : 'balance not yet synced'}
              </div>
            </div>
            <div style={s.summaryCell}>
              <div style={s.summaryLabel}>Projected in {forecast.horizonDays} days</div>
              <div style={{ ...s.summaryValue, color: goesNegative ? '#dc2626' : '#0d7a6b' }}>
                {fmtCurrency(chartData.length > 0 ? chartData[chartData.length - 1].balance : forecast.startingBalance)}
              </div>
            </div>
            <div style={s.summaryCell}>
              <div style={s.summaryLabel}>Lowest projected point</div>
              <div style={{ ...s.summaryValue, color: goesNegative ? '#dc2626' : '#374151' }}>
                {fmtCurrency(minBalance)}
              </div>
            </div>
          </div>

          {goesNegative && (
            <div style={s.warningBanner}>
              ⚠ Your projected balance goes negative within this window — review the events below.
            </div>
          )}

          <div style={s.chartCard}>
            <ResponsiveContainer width="100%" height={320}>
              <AreaChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="balanceFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#0d7a6b" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#0d7a6b" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis
                  dataKey="date"
                  tickFormatter={d => fmtDate(d)}
                  tick={{ fontSize: 11, fill: '#718096' }}
                  minTickGap={30}
                />
                <YAxis
                  tickFormatter={v => fmtCurrency(v)}
                  tick={{ fontSize: 11, fill: '#718096' }}
                  width={80}
                />
                <Tooltip
                  formatter={(v: any) => fmtCurrency(Number(v))}
                  labelFormatter={d => fmtDate(String(d))}
                />
                {goesNegative && <ReferenceLine y={0} stroke="#dc2626" strokeDasharray="4 4" />}
                <Area
                  type="stepAfter"
                  dataKey="balance"
                  stroke="#0d7a6b"
                  strokeWidth={2}
                  fill="url(#balanceFill)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <h3 style={s.eventsHeading}>Projected events</h3>
          {forecast.events.length === 0 ? (
            <p style={s.muted}>
              No projected income, fixed costs, or credit card payments found. Add fixed costs on the
              Master Budget page, and make sure your income sources have a match rule or a "next pay
              date" set.
            </p>
          ) : (
            <div style={s.eventsTableWrap}>
              <table style={s.table}>
                <thead>
                  <tr>
                    <th style={s.th}>Date</th>
                    <th style={s.th}>Type</th>
                    <th style={s.th}>Label</th>
                    <th style={{ ...s.th, textAlign: 'right' }}>Amount</th>
                    <th style={{ ...s.th, textAlign: 'right' }}>Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {forecast.events.map((e, i) => {
                    // series[0] is the starting balance (today); each event
                    // maps 1:1 to series[i+1], the running balance after it.
                    const runningBalance = forecast.series[i + 1]?.balance;
                    return (
                    <tr key={i} style={s.tr}>
                      <td style={s.td}>{fmtDate(e.date)}</td>
                      <td style={s.td}>
                        <span style={{ ...s.typeBadge, color: TYPE_COLORS[e.type], borderColor: TYPE_COLORS[e.type] }}>
                          {TYPE_LABELS[e.type]}
                        </span>
                      </td>
                      <td style={s.td}>
                        {e.creditCardDetail ? (
                          (() => {
                            const { base, suffix } = splitLabel(e.label);
                            return (
                              <>
                                {base}{' '}
                                {suffix && (
                                  <button style={s.detailChip} onClick={() => setDetailEvent(e)}>
                                    {suffix}
                                  </button>
                                )}
                              </>
                            );
                          })()
                        ) : e.label}
                      </td>
                      <td style={{ ...s.td, textAlign: 'right', color: e.amount >= 0 ? '#0d7a6b' : '#dc2626', fontVariantNumeric: 'tabular-nums' }}>
                        {e.amount >= 0 ? '+' : ''}{fmtCurrency(e.amount)}
                      </td>
                      <td style={{ ...s.td, textAlign: 'right', color: (runningBalance ?? 0) < 0 ? '#dc2626' : '#1a202c', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                        {runningBalance !== undefined ? fmtCurrency(runningBalance) : '—'}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {detailEvent && (
        <CreditCardPaymentDetailModal event={detailEvent} onClose={() => setDetailEvent(null)} />
      )}
    </div>
  );
};

const s: Record<string, React.CSSProperties> = {
  page:      { padding: '1.5rem 1rem', maxWidth: 1000, margin: '0 auto' },
  header:    { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '0.75rem' },
  title:     { margin: 0, fontSize: '1.4rem', fontWeight: 700 },
  horizonGroup: { display: 'flex', gap: '0.4rem' },
  horizonBtn:       { background: '#fff', color: '#374151', border: '1px solid #d1d5db', borderRadius: 6, padding: '0.4rem 0.9rem', cursor: 'pointer', fontSize: '0.85rem' },
  horizonBtnActive: { background: '#0d7a6b', color: '#fff', border: '1px solid #0d7a6b', borderRadius: 6, padding: '0.4rem 0.9rem', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600 },
  muted:     { color: '#6b7280' },
  errorBox:  { background: '#fee2e2', color: '#b91c1c', borderRadius: 8, padding: '0.9rem 1.1rem', marginBottom: '1rem' },
  summaryBar: { display: 'flex', gap: '1rem', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '1rem 1.5rem', marginBottom: '1rem', flexWrap: 'wrap' },
  summaryCell: { flex: 1, minWidth: 140, textAlign: 'center' },
  summaryLabel: { fontSize: '0.78rem', color: '#6b7280', marginBottom: 4 },
  balanceAsOf: { fontSize: '0.7rem', color: '#9ca3af', marginTop: 4 },
  summaryValue: { fontSize: '1.15rem', fontWeight: 700, color: '#1a202c' },
  warningBanner: { background: '#fffbeb', border: '1px solid #fcd34d', color: '#92400e', borderRadius: 8, padding: '0.65rem 1rem', marginBottom: '1rem', fontSize: '0.85rem' },
  chartCard: { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '1rem', marginBottom: '1.5rem' },
  eventsHeading: { fontSize: '1rem', fontWeight: 600, margin: '0 0 0.75rem' },
  eventsTableWrap: { overflowX: 'auto' },
  table:     { width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' },
  th:        { textAlign: 'left', padding: '0.5rem 0.75rem', background: '#f7fafc', borderBottom: '2px solid #e2e8f0', fontWeight: 600, color: '#4a5568', whiteSpace: 'nowrap' },
  tr:        { borderBottom: '1px solid #e2e8f0' },
  td:        { padding: '0.5rem 0.75rem', color: '#2d3748', verticalAlign: 'middle' },
  typeBadge: { fontSize: '0.72rem', border: '1px solid', borderRadius: 999, padding: '1px 8px', whiteSpace: 'nowrap' },
  detailChip: { fontSize: '0.72rem', border: '1px solid #b45309', color: '#b45309', background: '#fffbeb', borderRadius: 999, padding: '1px 8px', cursor: 'pointer', whiteSpace: 'nowrap' },
};

export default CashFlowPage;

import React from 'react';
import { CashFlowEvent } from '../api/client';
import { fmtCurrency, fmtDate } from '../utils/dates';

interface Props {
  event: CashFlowEvent;
  onClose: () => void;
}

/**
 * Shows how a projected credit card payment amount was derived: the payment
 * date, the billing window it's based on, and the individual charge/credit
 * transactions posted in that window. High confidence (automatic
 * reconstruction) and manual (user-configured close day/grace period) both
 * sum exactly to the projected amount. Low confidence shows everything
 * posted since the last detected payment for context, even though it won't
 * necessarily sum to the historical-average projected amount.
 */
export const CreditCardPaymentDetailModal: React.FC<Props> = ({ event, onClose }) => {
  const detail = event.creditCardDetail;
  if (!detail) return null;

  let running = 0;
  const rows = detail.transactions.map(t => {
    running += t.amount;
    return { ...t, running };
  });

  return (
    <div style={s.overlay}>
      <div style={s.modal}>
        <div style={s.header}>
          <h3 style={s.title}>{event.label.replace(/\s*(est|approx|manual)\s*$/, '')}</h3>
          <button style={s.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={s.summaryRow}>
          <div style={s.summaryCell}>
            <div style={s.summaryLabel}>Payment date</div>
            <div style={s.summaryValue}>{fmtDate(event.date)}</div>
          </div>
          <div style={s.summaryCell}>
            <div style={s.summaryLabel}>{detail.confidence === 'low' ? 'Since last payment' : 'Billing date range'}</div>
            <div style={s.summaryValue}>
              {detail.billingStart && detail.billingEnd
                ? `${fmtDate(detail.billingStart)} – ${fmtDate(detail.billingEnd)}`
                : 'Not yet determined'}
            </div>
          </div>
          <div style={s.summaryCell}>
            <div style={s.summaryLabel}>Projected amount</div>
            <div style={{ ...s.summaryValue, color: '#dc2626' }}>{fmtCurrency(Math.abs(event.amount))}</div>
          </div>
        </div>

        {detail.confidence === 'low' && (
          <p style={s.note}>
            No consistent statement cycle was detected for this card, so the projected amount above is
            a historical average of past payments, not a reconstructed statement total. The transactions
            below are what's actually posted since your last detected payment through today — they won't
            necessarily add up to the projected amount, since the current cycle may not be finished yet.
          </p>
        )}
        {detail.confidence === 'manual' && (
          <p style={s.note}>
            Using your manually configured statement close day and grace period instead of automatic
            detection. The transactions below are the actual charges/credits summed to produce the
            projected amount above.
          </p>
        )}

        <div style={s.tableWrap}>
          {rows.length === 0 ? (
            <p style={s.muted}>No transactions available.</p>
          ) : (
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>Date</th>
                  <th style={s.th}>Transaction</th>
                  <th style={{ ...s.th, textAlign: 'right' }}>Amount</th>
                  <th style={{ ...s.th, textAlign: 'right' }}>Running total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={s.tr}>
                    <td style={s.td}>{fmtDate(r.date)}</td>
                    <td style={{ ...s.td, ...s.labelCell }}>{r.label}</td>
                    <td style={{ ...s.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {fmtCurrency(r.amount)}
                    </td>
                    <td style={{ ...s.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                      {fmtCurrency(r.running)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div style={s.footer}>
          <button style={s.closeFooterBtn} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
};

const s: Record<string, React.CSSProperties> = {
  overlay:   { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' },
  modal:     { background: '#fff', borderRadius: 12, width: '100%', maxWidth: 560, maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.18)', overflow: 'hidden' },
  header:    { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1rem 1.25rem 0.5rem', borderBottom: '1px solid #e2e8f0' },
  title:     { margin: 0, fontSize: '1rem', fontWeight: 600 },
  closeBtn:  { background: 'none', border: 'none', fontSize: '1.1rem', cursor: 'pointer', color: '#6b7280', padding: '2px 6px' },
  summaryRow: { display: 'flex', gap: '1rem', padding: '0.9rem 1.25rem', borderBottom: '1px solid #e2e8f0', flexWrap: 'wrap' },
  summaryCell: { flex: 1, minWidth: 140 },
  summaryLabel: { fontSize: '0.72rem', color: '#6b7280', marginBottom: 2 },
  summaryValue: { fontSize: '0.95rem', fontWeight: 600, color: '#1a202c' },
  note:      { margin: '0.75rem 1.25rem 0', fontSize: '0.8rem', color: '#92400e', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: '0.6rem 0.8rem', lineHeight: 1.4 },
  tableWrap: { padding: '0.75rem 1.25rem', overflowY: 'auto' },
  muted:     { color: '#6b7280', fontSize: '0.85rem' },
  table:     { width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' },
  th:        { textAlign: 'left', padding: '0.4rem 0.6rem', background: '#f7fafc', borderBottom: '2px solid #e2e8f0', fontWeight: 600, color: '#4a5568', whiteSpace: 'nowrap' },
  tr:        { borderBottom: '1px solid #e2e8f0' },
  td:        { padding: '0.4rem 0.6rem', color: '#2d3748' },
  labelCell: { maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  footer:    { display: 'flex', justifyContent: 'flex-end', padding: '0.75rem 1.25rem', borderTop: '1px solid #e2e8f0' },
  closeFooterBtn: { background: 'transparent', color: '#374151', border: '1px solid #d1d5db', borderRadius: 6, padding: '0.4rem 1rem', cursor: 'pointer', fontSize: '0.875rem' },
};

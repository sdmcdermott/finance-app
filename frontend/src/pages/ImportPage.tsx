import React, { useRef, useState } from 'react';
import {
  importAmazonCsv,
  confirmAmazonImport,
  ImportReport,
  MatchResult,
  ConfirmedMatch,
  Transaction,
} from '../api/client';

const ImportPage: React.FC = () => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // For each order (by orderId), which transaction (dateTransactionId) was chosen
  const [choices, setChoices] = useState<Record<string, string>>({});
  // Which orders are checked (by orderId)
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true);
    setError(null);
    setReport(null);
    setSuccessMsg(null);
    setChoices({});
    setSelected(new Set());
    try {
      const csvText = await file.text();
      const result = await importAmazonCsv(csvText);
      setReport(result);
      // Pre-select all confident matches
      const preSelected = new Set<string>();
      result.results.forEach((m) => {
        if (m.status === 'confident') preSelected.add(m.order.orderId);
      });
      setSelected(preSelected);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const toggleSelected = (orderId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId); else next.add(orderId);
      return next;
    });
  };

  const handleConfirm = async () => {
    if (!report) return;
    setConfirming(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const confirmed: ConfirmedMatch[] = [];
      report.results.forEach((m) => {
        if (!selected.has(m.order.orderId)) return;

        let txn: Transaction | undefined;
        if (m.status === 'confident' && m.candidates.length === 1) {
          txn = m.candidates[0];
        } else if (m.status === 'ambiguous') {
          const chosenId = choices[m.order.orderId];
          txn = m.candidates.find((c) => c.dateTransactionId === chosenId);
        }
        if (!txn) return;

        confirmed.push({
          accountId: txn.accountId,
          dateTransactionId: txn.dateTransactionId,
          referenceUrl: m.order.orderUrl,
          referenceNote: `Amazon Order #${m.order.orderId}${m.order.titles.length ? ' \u2014 ' + m.order.titles[0] : ''}`,
        });
      });

      const result = await confirmAmazonImport(confirmed);
      setSuccessMsg(
        `${result.saved} transaction(s) updated with Amazon order references.` +
        (result.errors.length ? ' Some errors: ' + result.errors.join(', ') : '')
      );
      setReport(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setConfirming(false);
    }
  };

  const statusBadge = (status: MatchResult['status']) => {
    const colors: Record<string, string> = {
      confident: '#38a169',
      ambiguous: '#d69e2e',
      unmatched: '#718096',
    };
    return (
      <span style={{ ...styles.badge, background: colors[status] || '#718096' }}>
        {status}
      </span>
    );
  };

  const confirmableCount = report?.results.filter((m) => {
    if (!selected.has(m.order.orderId)) return false;
    if (m.status === 'confident') return m.candidates.length === 1;
    if (m.status === 'ambiguous') return !!choices[m.order.orderId];
    return false;
  }).length ?? 0;

  return (
    <div className="page">
      <h2 style={styles.heading}>Amazon Order Import</h2>
      <p style={styles.subtext}>
        Upload your Amazon Order History CSV to match orders to transactions and attach reference links.
      </p>

      {error && <div style={styles.error}>{error}</div>}
      {successMsg && <div style={styles.success}>{successMsg}</div>}

      <div style={styles.uploadRow}>
        <input
          ref={fileRef}
          type="file"
          accept=".csv"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
        <button style={styles.uploadBtn} onClick={() => fileRef.current?.click()} disabled={loading}>
          {loading ? 'Parsing...' : 'Choose CSV File'}
        </button>
        {report && (
          <span style={styles.summary}>
            {report.results.filter((m) => m.status === 'confident').length} confident &nbsp;&middot;&nbsp;
            {report.results.filter((m) => m.status === 'ambiguous').length} ambiguous &nbsp;&middot;&nbsp;
            {report.results.filter((m) => m.status === 'unmatched').length} unmatched
            &nbsp;&middot;&nbsp;{report.orderCount} orders / {report.txnPool} txns checked
          </span>
        )}
      </div>

      {report && report.results.length > 0 && (
        <>
          <div className="import-table-wrap">
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}></th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Order Date</th>
                <th style={styles.th}>Order ID</th>
                <th style={styles.th}>Title</th>
                <th style={{ ...styles.th, textAlign: 'right' }}>Amount</th>
                <th style={styles.th}>Transaction Match</th>
              </tr>
            </thead>
            <tbody>
              {report.results.map((m) => (
                <tr key={m.order.orderId} style={styles.tr}>
                  <td style={styles.td}>
                    {m.status !== 'unmatched' && (
                      <input
                        type="checkbox"
                        checked={selected.has(m.order.orderId)}
                        onChange={() => toggleSelected(m.order.orderId)}
                      />
                    )}
                  </td>
                  <td style={styles.td}>{statusBadge(m.status)}</td>
                  <td style={styles.td}>{m.order.orderDate}</td>
                  <td style={styles.td}>
                    <a href={m.order.orderUrl} target="_blank" rel="noreferrer" style={styles.orderLink}>
                      {m.order.orderId}
                    </a>
                  </td>
                  <td style={styles.td}>
                    <span style={styles.titleText}>{m.order.titles.slice(0, 2).join('; ')}</span>
                  </td>
                  <td style={{ ...styles.td, textAlign: 'right' }}>
                    ${m.order.amount.toFixed(2)}
                  </td>
                  <td style={styles.td}>
                    {m.status === 'confident' && m.candidates.length === 1 && (
                      <span style={styles.txnInfo}>
                        {m.candidates[0].date} &mdash; {m.candidates[0].merchantName || m.candidates[0].name}
                        &nbsp;(${Math.abs(m.candidates[0].amount).toFixed(2)})
                      </span>
                    )}
                    {m.status === 'ambiguous' && (
                      <select
                        value={choices[m.order.orderId] || ''}
                        onChange={(e) =>
                          setChoices((prev) => ({ ...prev, [m.order.orderId]: e.target.value }))
                        }
                        style={styles.select}
                      >
                        <option value="">— choose transaction —</option>
                        {m.candidates.map((c) => (
                          <option key={c.dateTransactionId} value={c.dateTransactionId}>
                            {c.date} &mdash; {c.merchantName || c.name} (${Math.abs(c.amount).toFixed(2)})
                          </option>
                        ))}
                      </select>
                    )}
                    {m.status === 'unmatched' && (
                      <span style={styles.unmatchedText}>No matching transaction</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>

          <div style={styles.confirmRow}>
            <button
              style={styles.confirmBtn}
              onClick={handleConfirm}
              disabled={confirming || confirmableCount === 0}
            >
              {confirming ? 'Saving...' : `Confirm ${confirmableCount} Match${confirmableCount !== 1 ? 'es' : ''}`}
            </button>
          </div>
        </>
      )}

      {report && report.results.length === 0 && (
        <div style={styles.empty}>No orders found in the CSV or no matching transactions.</div>
      )}
    </div>
  );
};

export default ImportPage;

// ── Styles ────────────────────────────────────────────────────────────────────
const styles: Record<string, React.CSSProperties> = {
  heading: { fontSize: '1.25rem', fontWeight: 700, color: '#1a202c', marginBottom: '0.25rem' },
  subtext: { color: '#718096', fontSize: '0.875rem', marginBottom: '1.25rem' },
  uploadRow: { display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.25rem', flexWrap: 'wrap' },
  uploadBtn: { background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 6, padding: '0.5rem 1.25rem', cursor: 'pointer', fontSize: '0.875rem' },
  summary: { color: '#4a5568', fontSize: '0.85rem' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' },
  th: { textAlign: 'left', padding: '0.6rem 0.75rem', background: '#f7fafc', borderBottom: '2px solid #e2e8f0', fontWeight: 600, color: '#4a5568' },
  tr: { borderBottom: '1px solid #e2e8f0' },
  td: { padding: '0.55rem 0.75rem', color: '#2d3748', verticalAlign: 'middle' },
  badge: { color: '#fff', borderRadius: 12, padding: '0.15rem 0.6rem', fontSize: '0.75rem', whiteSpace: 'nowrap' },
  orderLink: { color: '#4f46e5', fontSize: '0.8rem' },
  titleText: { fontSize: '0.8rem', color: '#4a5568' },
  txnInfo: { fontSize: '0.8rem', color: '#4a5568' },
  unmatchedText: { fontSize: '0.8rem', color: '#a0aec0', fontStyle: 'italic' },
  select: { border: '1px solid #cbd5e0', borderRadius: 4, padding: '0.2rem 0.4rem', fontSize: '0.8rem', maxWidth: 300 },
  confirmRow: { marginTop: '1rem', display: 'flex', justifyContent: 'flex-end' },
  confirmBtn: { background: '#38a169', color: '#fff', border: 'none', borderRadius: 6, padding: '0.5rem 1.5rem', cursor: 'pointer', fontSize: '0.875rem' },
  empty: { textAlign: 'center', color: '#718096', marginTop: '3rem' },
  error: { background: '#fff5f5', color: '#c53030', border: '1px solid #feb2b2', borderRadius: 6, padding: '0.75rem 1rem', marginBottom: '1rem' },
  success: { background: '#f0fff4', color: '#276749', border: '1px solid #9ae6b4', borderRadius: 6, padding: '0.75rem 1rem', marginBottom: '1rem' },
};

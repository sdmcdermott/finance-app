import React, { useEffect, useState } from 'react';
import { Account, deleteAccount } from '../api/client';
import { usePlaidConnect } from '../hooks/usePlaidConnect';
import { useData } from '../auth/DataContext';
import { fmtDate } from '../utils/dates';

const AccountsPage: React.FC = () => {
  const { accounts, setAccounts, loading } = useData();
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Account | null>(null);
  const [deleting, setDeleting] = useState(false);

  const { fetchLinkToken, open, ready, loading: linkLoading } = usePlaidConnect({
    onSuccess: (newAccounts) => {
      setAccounts(prev => [...prev, ...newAccounts]);
    },
  });

  const handleConnectClick = () => {
    if (ready) {
      open();
    } else {
      fetchLinkToken();
    }
  };

  useEffect(() => {
    if (ready) open();
  }, [ready, open]);

  const handleDeleteConfirm = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await deleteAccount(confirmDelete.accountId);
      setAccounts(prev => prev.filter(a => a.accountId !== confirmDelete.accountId));
      setConfirmDelete(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h2 style={styles.title}>Accounts</h2>
        <button style={styles.btn} onClick={handleConnectClick} disabled={linkLoading}>
          {linkLoading ? 'Connecting...' : '+ Connect Account'}
        </button>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {loading ? (
        <p style={styles.muted}>Loading accounts…</p>
      ) : accounts.length === 0 ? (
        <div style={styles.empty}>
          <p>No accounts connected yet.</p>
          <p>Use &ldquo;+ Connect Account&rdquo; to link your bank or credit card via Plaid.</p>
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <table style={styles.table} className="accounts-table">
            <thead>
              <tr>
                <th style={styles.th}>Institution</th>
                <th style={styles.th}>Name</th>
                <th style={styles.th}>Type</th>
                <th style={styles.th}>Subtype</th>
                <th style={styles.th}>Last Synced</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {accounts.map(a => (
                <tr key={a.accountId} style={styles.tr}>
                  <td style={styles.td}>{a.institution}</td>
                  <td style={styles.td}>{a.name}</td>
                  <td style={styles.td}>{a.type}</td>
                  <td style={styles.td}>{a.subtype}</td>
                  <td style={styles.td}>{fmtDate(a.lastSynced)}</td>
                  <td style={styles.td}>
                    <button style={styles.deleteBtn} title="Delete account" onClick={() => setConfirmDelete(a)}>
                      🗑
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Mobile cards */}
          <div className="accounts-cards">
            {accounts.map(a => (
              <div key={a.accountId} style={styles.card}>
                <div style={styles.cardRow}>
                  <span style={styles.cardLabel}>Institution</span>
                  <span>{a.institution}</span>
                </div>
                <div style={styles.cardRow}>
                  <span style={styles.cardLabel}>Name</span>
                  <span>{a.name}</span>
                </div>
                <div style={styles.cardRow}>
                  <span style={styles.cardLabel}>Type</span>
                  <span>{a.type} / {a.subtype}</span>
                </div>
                <div style={styles.cardRow}>
                  <span style={styles.cardLabel}>Last Synced</span>
                  <span>{fmtDate(a.lastSynced)}</span>
                </div>
                <div style={{ ...styles.cardRow, justifyContent: 'flex-end' }}>
                  <button style={styles.deleteBtn} onClick={() => setConfirmDelete(a)}>
                    🗑 Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Delete confirmation modal */}
      {confirmDelete && (
        <div style={styles.overlay}>
          <div style={styles.modal}>
            <h3 style={{ marginTop: 0 }}>Delete Account?</h3>
            <p>
              Remove <strong>{confirmDelete.name}</strong> ({confirmDelete.institution})?
              This will not delete any transactions already synced.
            </p>
            <div style={styles.modalActions}>
              <button style={styles.cancelBtn} onClick={() => setConfirmDelete(null)} disabled={deleting}>
                Cancel
              </button>
              <button style={styles.confirmBtn} onClick={handleDeleteConfirm} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  page:         { padding: '1.5rem', maxWidth: '900px', margin: '0 auto' },
  header:       { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '0.5rem' },
  title:        { margin: 0, fontSize: '1.4rem', fontWeight: 700 },
  btn:          { background: '#0d7a6b', color: '#fff', border: 'none', borderRadius: '6px', padding: '0.5rem 1rem', cursor: 'pointer', fontSize: '0.9rem' },
  error:        { background: '#fee2e2', color: '#b91c1c', borderRadius: '6px', padding: '0.75rem 1rem', marginBottom: '1rem' },
  muted:        { color: '#6b7280' },
  empty:        { color: '#6b7280', lineHeight: 1.8 },
  table:        { width: '100%', borderCollapse: 'collapse' },
  th:           { textAlign: 'left', padding: '0.6rem 0.75rem', borderBottom: '2px solid #e5e7eb', fontSize: '0.8rem', textTransform: 'uppercase', color: '#6b7280', whiteSpace: 'nowrap' },
  tr:           { borderBottom: '1px solid #f3f4f6' },
  td:           { padding: '0.65rem 0.75rem', fontSize: '0.9rem', verticalAlign: 'middle' },
  deleteBtn:    { background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontSize: '1rem', padding: '0.25rem 0.5rem' },
  card:         { background: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '0.875rem 1rem', marginBottom: '0.75rem' },
  cardRow:      { display: 'flex', justifyContent: 'space-between', padding: '0.2rem 0', fontSize: '0.9rem' },
  cardLabel:    { color: '#6b7280', fontWeight: 600 },
  overlay:      { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modal:        { background: '#fff', borderRadius: '10px', padding: '1.5rem', maxWidth: '420px', width: '90%', boxShadow: '0 20px 40px rgba(0,0,0,0.2)' },
  modalActions: { display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1.25rem' },
  cancelBtn:    { padding: '0.5rem 1rem', borderRadius: '6px', border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' },
  confirmBtn:   { padding: '0.5rem 1rem', borderRadius: '6px', border: 'none', background: '#ef4444', color: '#fff', cursor: 'pointer' },
};

export default AccountsPage;

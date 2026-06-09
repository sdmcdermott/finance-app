import React, { useState } from 'react';
import { Account, updateAccount } from '../api/client';
import { usePlaidConnect } from '../hooks/usePlaidConnect';
import { useData } from '../auth/DataContext';
import { fmtDate } from '../utils/dates';

// ── Toggle (reuse pattern from MasterBudgetPage) ─────────────────────────────
const Toggle: React.FC<{ on: boolean; onChange: (v: boolean) => void; disabled?: boolean }> = ({ on, onChange, disabled }) => (
  <button
    role="switch"
    aria-checked={on}
    disabled={disabled}
    onClick={() => onChange(!on)}
    style={{
      position: 'relative', display: 'inline-block',
      width: 40, height: 22, borderRadius: 11,
      background: on ? '#0d7a6b' : '#d1d5db',
      border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
      transition: 'background 0.2s', flexShrink: 0,
      opacity: disabled ? 0.5 : 1,
    }}
  >
    <span style={{
      position: 'absolute', top: 3,
      left: on ? 21 : 3,
      width: 16, height: 16, borderRadius: '50%',
      background: '#fff',
      transition: 'left 0.2s',
      boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
    }} />
  </button>
);

// Group accounts by institution + itemId
interface InstitutionGroup {
  key: string;        // itemId (stable; institution name can drift)
  institution: string;
  accounts: Account[];
}

function groupByInstitution(accounts: Account[]): InstitutionGroup[] {
  const map = new Map<string, InstitutionGroup>();
  for (const acct of accounts) {
    const key = acct.itemId || acct.institution; // fallback for legacy records without itemId
    if (!map.has(key)) {
      map.set(key, { key, institution: acct.institution, accounts: [] });
    }
    map.get(key)!.accounts.push(acct);
  }
  return Array.from(map.values());
}

const AccountsPage: React.FC = () => {
  const { accounts, setAccounts, loading } = useData();
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  // Track which institution groups are expanded (default: all expanded)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const { fetchLinkToken, open, ready, loading: linkLoading } = usePlaidConnect({
    onSuccess: (newAccounts) => {
      setAccounts(prev => [...prev, ...newAccounts]);
    },
  });

  const handleConnectClick = () => {
    if (ready) open();
    else fetchLinkToken();
  };

  React.useEffect(() => {
    if (ready) open();
  }, [ready, open]);

  const handleToggleEnabled = async (acct: Account, enabled: boolean) => {
    setToggling(prev => new Set(prev).add(acct.accountId));
    try {
      await updateAccount(acct.accountId, { enabled });
      setAccounts(prev => prev.map(a =>
        a.accountId === acct.accountId ? { ...a, enabled } : a
      ));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setToggling(prev => { const s = new Set(prev); s.delete(acct.accountId); return s; });
    }
  };

  const toggleCollapse = (key: string) => {
    setCollapsed(prev => {
      const s = new Set(prev);
      if (s.has(key)) s.delete(key);
      else s.add(key);
      return s;
    });
  };

  const isEnabled = (acct: Account) => acct.enabled !== false;

  const groups = groupByInstitution(accounts);

  return (
    <div style={s.page}>
      <div style={s.header}>
        <h2 style={s.title}>Accounts</h2>
        <button style={s.btn} onClick={handleConnectClick} disabled={linkLoading}>
          {linkLoading ? 'Connecting...' : '+ Connect Account'}
        </button>
      </div>

      {error && <div style={s.error}>{error}</div>}

      {loading ? (
        <p style={s.muted}>Loading accounts…</p>
      ) : accounts.length === 0 ? (
        <div style={s.empty}>
          <p>No accounts connected yet.</p>
          <p>Use &ldquo;+ Connect Account&rdquo; to link your bank or credit card via Plaid.</p>
        </div>
      ) : (
        <div style={s.tree}>
          {groups.map(group => {
            const isCollapsed = collapsed.has(group.key);
            const allEnabled = group.accounts.every(isEnabled);
            const anyEnabled = group.accounts.some(isEnabled);
            // institution-level enabled state: all=on, none=off, mixed=indeterminate (show as on)
            const institutionEnabled = anyEnabled;

            return (
              <div key={group.key} style={s.institutionBlock}>
                {/* ── Institution row (branch) ── */}
                <div style={s.institutionRow}>
                  <button style={s.chevronBtn} onClick={() => toggleCollapse(group.key)} title={isCollapsed ? 'Expand' : 'Collapse'}>
                    <span style={{ ...s.chevron, transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▼</span>
                  </button>
                  <span style={s.institutionName}>{group.institution}</span>
                  <span style={s.accountCount}>{group.accounts.length} account{group.accounts.length !== 1 ? 's' : ''}</span>
                  {!allEnabled && anyEnabled && (
                    <span style={s.mixedBadge}>partial</span>
                  )}
                </div>

                {/* ── Account rows (leaves) ── */}
                {!isCollapsed && (
                  <div style={s.leaves}>
                    {/* Desktop table */}
                    <table style={s.table} className="accounts-table">
                      <thead>
                        <tr>
                          <th style={s.th}>Name</th>
                          <th style={s.th}>Type</th>
                          <th style={s.th}>Subtype</th>
                          <th style={s.th}>Last Synced</th>
                          <th style={{ ...s.th, textAlign: 'center' }}>Sync enabled</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.accounts.map(acct => (
                          <tr key={acct.accountId} style={{ ...s.tr, opacity: isEnabled(acct) ? 1 : 0.5 }}>
                            <td style={s.td}>{acct.name}</td>
                            <td style={s.td}>{acct.type}</td>
                            <td style={s.td}>{acct.subtype}</td>
                            <td style={s.td}>{fmtDate(acct.lastSynced)}</td>
                            <td style={{ ...s.td, textAlign: 'center' }}>
                              <Toggle
                                on={isEnabled(acct)}
                                onChange={v => handleToggleEnabled(acct, v)}
                                disabled={toggling.has(acct.accountId)}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    {/* Mobile cards */}
                    <div className="accounts-cards">
                      {group.accounts.map(acct => (
                        <div key={acct.accountId} style={{ ...s.card, opacity: isEnabled(acct) ? 1 : 0.5 }}>
                          <div style={s.cardRow}>
                            <span style={s.cardLabel}>Name</span>
                            <span>{acct.name}</span>
                          </div>
                          <div style={s.cardRow}>
                            <span style={s.cardLabel}>Type</span>
                            <span>{acct.type} / {acct.subtype}</span>
                          </div>
                          <div style={s.cardRow}>
                            <span style={s.cardLabel}>Last Synced</span>
                            <span>{fmtDate(acct.lastSynced)}</span>
                          </div>
                          <div style={{ ...s.cardRow, alignItems: 'center' }}>
                            <span style={s.cardLabel}>Sync enabled</span>
                            <Toggle
                              on={isEnabled(acct)}
                              onChange={v => handleToggleEnabled(acct, v)}
                              disabled={toggling.has(acct.accountId)}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const s: Record<string, React.CSSProperties> = {
  page:            { padding: '1.5rem', maxWidth: '900px', margin: '0 auto' },
  header:          { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '0.5rem' },
  title:           { margin: 0, fontSize: '1.4rem', fontWeight: 700 },
  btn:             { background: '#0d7a6b', color: '#fff', border: 'none', borderRadius: '6px', padding: '0.5rem 1rem', cursor: 'pointer', fontSize: '0.9rem' },
  error:           { background: '#fee2e2', color: '#b91c1c', borderRadius: '6px', padding: '0.75rem 1rem', marginBottom: '1rem' },
  muted:           { color: '#6b7280' },
  empty:           { color: '#6b7280', lineHeight: 1.8 },
  tree:            { display: 'flex', flexDirection: 'column', gap: '0.75rem' },
  institutionBlock:{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', overflow: 'hidden' },
  institutionRow:  { display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.75rem 1rem', background: '#f7fafc', borderBottom: '1px solid #e2e8f0', cursor: 'default' },
  chevronBtn:      { background: 'none', border: 'none', cursor: 'pointer', padding: '0 0.15rem', lineHeight: 1, color: '#4a5568' },
  chevron:         { display: 'inline-block', fontSize: '0.7rem', transition: 'transform 0.15s', color: '#4a5568' },
  institutionName: { fontWeight: 700, fontSize: '1rem', color: '#2d3748', flex: 1 },
  accountCount:    { fontSize: '0.8rem', color: '#6b7280' },
  mixedBadge:      { fontSize: '0.7rem', background: '#fef3c7', color: '#92400e', borderRadius: '999px', padding: '1px 8px', fontWeight: 600 },
  leaves:          { padding: '0' },
  table:           { width: '100%', borderCollapse: 'collapse' },
  th:              { textAlign: 'left', padding: '0.5rem 1rem', background: '#f7fafc', color: '#4a5568', fontSize: '0.78rem', textTransform: 'uppercase', borderBottom: '2px solid #e2e8f0', whiteSpace: 'nowrap' },
  tr:              { borderBottom: '1px solid #e2e8f0' },
  td:              { padding: '0.65rem 1rem', fontSize: '0.9rem', verticalAlign: 'middle', color: '#2d3748' },
  card:            { background: '#fff', borderTop: '1px solid #e2e8f0', padding: '0.875rem 1rem' },
  cardRow:         { display: 'flex', justifyContent: 'space-between', padding: '0.2rem 0', fontSize: '0.9rem' },
  cardLabel:       { color: '#6b7280', fontWeight: 600 },
};

export default AccountsPage;

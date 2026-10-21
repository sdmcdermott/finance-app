import React, { useState, useEffect } from 'react';
import { useData } from '../auth/DataContext';
import { usePlaidConnect } from '../hooks/usePlaidConnect';
import { Account } from '../api/client';

// Groups accounts needing Plaid re-authentication by their Plaid Item, since
// the reauth flag lives at the item level and can affect multiple accounts
// under one institution connection at once.
interface ReauthGroup {
  itemId: string;
  accountNames: string[];
}

function groupReauthAccounts(accounts: Account[]): ReauthGroup[] {
  const map = new Map<string, ReauthGroup>();
  for (const a of accounts) {
    // Sync-disabled accounts are intentionally not being kept up to date —
    // don't nag the user to reconnect something they've opted out of.
    if (!a.needsReauth || a.enabled === false) continue;
    if (!map.has(a.itemId)) {
      map.set(a.itemId, { itemId: a.itemId, accountNames: [] });
    }
    map.get(a.itemId)!.accountNames.push(a.nickName || a.name);
  }
  return Array.from(map.values());
}

function joinNames(names: string[]): string {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

/**
 * Renders a warning banner (with a one-click "Reconnect" button) for any
 * account whose Plaid connection needs re-authentication. Intended to be
 * dropped into pages beyond the Accounts page so users who don't think to
 * check there still notice a broken sync.
 */
export const ReauthBanner: React.FC = () => {
  const { accounts, refreshAll } = useData();
  const [reconnectingItemId, setReconnectingItemId] = useState<string | null>(null);

  const { fetchLinkToken, open, ready, loading, error: linkError } = usePlaidConnect({
    onSuccess: async () => {
      try {
        await refreshAll();
      } finally {
        setReconnectingItemId(null);
      }
    },
  });

  useEffect(() => {
    if (ready) open();
  }, [ready, open]);

  // If Link exits with an error, clear the "Reconnecting…" state on whichever
  // item was in flight so the button resets and the error banner can show.
  useEffect(() => {
    if (linkError) setReconnectingItemId(null);
  }, [linkError]);

  const groups = groupReauthAccounts(accounts);
  if (groups.length === 0) return null;

  const handleReconnect = (itemId: string) => {
    setReconnectingItemId(itemId);
    fetchLinkToken(itemId);
  };

  return (
    <>
      {groups.map(g => {
        const names = joinNames(g.accountNames);
        const verb = g.accountNames.length > 1 ? 'have' : 'has';
        const isReconnecting = reconnectingItemId === g.itemId && loading;
        return (
          <div key={g.itemId} style={s.banner}>
            <div style={s.text}>
              <strong>{names}</strong> {verb} stopped syncing and need{g.accountNames.length > 1 ? '' : 's'} to be
              re-authenticated with your bank — this commonly happens after a password change, MFA
              reset, or periodic security re-verification. Click <strong>Reconnect</strong> to fix it;
              your account settings and transaction history will be preserved.
            </div>
            <button
              style={s.reconnectBtn}
              onClick={() => handleReconnect(g.itemId)}
              disabled={loading}
            >
              {isReconnecting ? 'Reconnecting…' : 'Reconnect'}
            </button>
          </div>
        );
      })}
      {linkError && (
        <div style={s.errorBanner}>{linkError}</div>
      )}
    </>
  );
};

const s: Record<string, React.CSSProperties> = {
  banner: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem',
    fontSize: '0.85rem', color: '#7f1d1d', background: '#fef2f2', border: '1px solid #fecaca',
    borderRadius: 8, padding: '0.65rem 1rem', marginBottom: '0.75rem', lineHeight: 1.5, flexWrap: 'wrap',
  },
  text: { flex: 1, minWidth: 240 },
  reconnectBtn: {
    background: '#b91c1c', color: '#fff', border: 'none', borderRadius: 6,
    padding: '0.35rem 0.8rem', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600, whiteSpace: 'nowrap',
  },
  errorBanner: {
    fontSize: '0.85rem', color: '#7f1d1d', background: '#fff7ed', border: '1px solid #fed7aa',
    borderRadius: 8, padding: '0.65rem 1rem', marginBottom: '0.75rem', lineHeight: 1.5,
  },
};

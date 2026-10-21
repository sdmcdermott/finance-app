import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePlaidLink, PlaidLinkOptions, PlaidLinkOnSuccess, PlaidLinkOnExit } from 'react-plaid-link';
import { exchangeToken } from '../api/client';
import { useData } from '../auth/DataContext';
import { PLAID_LINK_TOKEN_STORAGE_KEY } from '../hooks/usePlaidConnect';

/**
 * Dedicated page Plaid redirects back to after a user completes an
 * institution's OAuth login (e.g. for OAuth-based banks like U.S. Bank/Elan).
 * This URL must exactly match an entry in the Plaid Dashboard's Allowed
 * redirect URIs.
 *
 * Per Plaid's OAuth guide, reinitializing Link here with the SAME token used
 * to start the flow (plus `receivedRedirectUri`) is required whenever a
 * popup can't be used to complete the flow in place (popup blockers, mobile
 * webviews, or institutions that force a top-level redirect).
 */
const PlaidOAuthReturnPage: React.FC = () => {
  const navigate = useNavigate();
  const { refreshAll } = useData();
  const [status, setStatus] = useState<'resuming' | 'success' | 'error' | 'missing'>('resuming');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Captured once — reading it again after we clear it on success/error
  // would otherwise flip the UI back to the "no pending connection" state.
  const [storedToken] = useState<string | null>(() => localStorage.getItem(PLAID_LINK_TOKEN_STORAGE_KEY));

  const onSuccess: PlaidLinkOnSuccess = useCallback(async (publicToken, metadata) => {
    try {
      const institutionName = metadata.institution?.name ?? 'Unknown';
      await exchangeToken(publicToken, institutionName);
      localStorage.removeItem(PLAID_LINK_TOKEN_STORAGE_KEY);
      await refreshAll();
      setStatus('success');
      setTimeout(() => navigate('/accounts'), 1200);
    } catch (e: any) {
      setStatus('error');
      setErrorMsg(e.message ?? 'Failed to complete connection');
    }
  }, [navigate, refreshAll]);

  const onExit: PlaidLinkOnExit = useCallback((plaidError, metadata) => {
    localStorage.removeItem(PLAID_LINK_TOKEN_STORAGE_KEY);
    if (plaidError) {
      // eslint-disable-next-line no-console
      console.error('[Plaid Link OAuth return] exited with error:', plaidError, metadata);
      const parts = [plaidError.error_code, plaidError.display_message || plaidError.error_message]
        .filter(Boolean)
        .join(' — ');
      setStatus('error');
      setErrorMsg(`Plaid error${parts ? `: ${parts}` : ''} (request_id: ${metadata.request_id || 'n/a'})`);
    } else {
      setStatus('error');
      setErrorMsg('Connection was cancelled.');
    }
  }, []);

  const config: PlaidLinkOptions = {
    token: storedToken,
    // The full URL Plaid redirected back to, including its ?oauth_state_id=
    // query param — required to resume the exact same Link session.
    receivedRedirectUri: window.location.href,
    onSuccess,
    onExit,
  };

  const { open, ready } = usePlaidLink(config);

  useEffect(() => {
    if (ready) open();
  }, [ready, open]);

  if (!storedToken) {
    return (
      <div style={s.wrap}>
        <p>No pending bank connection found.</p>
        <p style={s.muted}>
          This page is only meant to be reached automatically while connecting or reconnecting a bank account.
        </p>
        <button style={s.btn} onClick={() => navigate('/accounts')}>Go to Accounts</button>
      </div>
    );
  }

  return (
    <div style={s.wrap}>
      {status === 'resuming' && <p>Finishing your bank connection…</p>}
      {status === 'success' && <p>&#10003; Connected successfully! Redirecting…</p>}
      {status === 'error' && (
        <>
          <p style={s.error}>{errorMsg}</p>
          <button style={s.btn} onClick={() => navigate('/accounts')}>Back to Accounts</button>
        </>
      )}
    </div>
  );
};

const s: Record<string, React.CSSProperties> = {
  wrap: { padding: '3rem 1.5rem', textAlign: 'center', maxWidth: 480, margin: '0 auto' },
  muted: { color: '#6b7280', fontSize: '0.9rem' },
  error: { color: '#b91c1c' },
  btn: { background: '#0d7a6b', color: '#fff', border: 'none', borderRadius: 6, padding: '0.5rem 1.25rem', cursor: 'pointer', fontSize: '0.9rem', marginTop: '1rem' },
};

export default PlaidOAuthReturnPage;

import { useState, useCallback } from 'react';
import { usePlaidLink, PlaidLinkOptions, PlaidLinkOnSuccess, PlaidLinkOnExit, PlaidLinkOnEvent } from 'react-plaid-link';
import { createLinkToken, exchangeToken, Account } from '../api/client';

// Persisted so a dedicated OAuth-return page (see PlaidOAuthReturnPage.tsx)
// can reinitialize Link with the SAME token after the browser navigates away
// to the bank's OAuth page and back — required by Plaid whenever a popup
// can't be used (mobile webviews, popup blockers, or institutions that force
// a top-level redirect instead of a popup).
export const PLAID_LINK_TOKEN_STORAGE_KEY = 'plaid_link_token';

interface UsePlaidConnectOptions {
  onSuccess: (accounts: Account[]) => void;
}

export const usePlaidConnect = ({ onSuccess }: UsePlaidConnectOptions) => {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pass an itemId to request Plaid Link's "update mode" — used to
  // re-authenticate an existing connection (e.g. after ITEM_LOGIN_REQUIRED)
  // rather than creating a brand-new Item.
  const fetchLinkToken = useCallback(async (itemId?: string) => {
    setLoading(true);
    setError(null);
    try {
      const token = await createLinkToken(itemId);
      setLinkToken(token);
      localStorage.setItem(PLAID_LINK_TOKEN_STORAGE_KEY, token);
    } catch (e: any) {
      setError(e.message ?? 'Failed to initialize Plaid Link');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSuccess: PlaidLinkOnSuccess = useCallback(
    async (publicToken, metadata) => {
      setLoading(true);
      setError(null);
      try {
        const institutionName = metadata.institution?.name ?? 'Unknown';
        const { accounts } = await exchangeToken(publicToken, institutionName);
        localStorage.removeItem(PLAID_LINK_TOKEN_STORAGE_KEY);
        onSuccess(accounts);
      } catch (e: any) {
        setError(e.message ?? 'Failed to connect account');
      } finally {
        setLoading(false);
      }
    },
    [onSuccess]
  );

  // Fires whenever Link closes without success — including user-cancel and
  // hard failures like the generic "Something went wrong" screen. `error` is
  // null on a plain user-cancel; non-null on an actual failure, and carries
  // Plaid's error_code/error_message/display_message plus a request_id you
  // can hand to Plaid support to look up server-side details.
  const handleExit: PlaidLinkOnExit = useCallback((plaidError, metadata) => {
    localStorage.removeItem(PLAID_LINK_TOKEN_STORAGE_KEY);
    if (plaidError) {
      // eslint-disable-next-line no-console
      console.error('[Plaid Link] exited with error:', plaidError, metadata);
      const parts = [plaidError.error_code, plaidError.display_message || plaidError.error_message]
        .filter(Boolean)
        .join(' — ');
      setError(
        `Plaid Link error${parts ? `: ${parts}` : ''} (request_id: ${metadata.request_id || 'n/a'})`
      );
    } else {
      // eslint-disable-next-line no-console
      console.log('[Plaid Link] exited without error (user cancelled)', metadata);
    }
    setLoading(false);
  }, []);

  // Logs every Link lifecycle event (OPEN, SELECT_INSTITUTION, TRANSITION_VIEW,
  // HANDOFF, ERROR, EXIT, etc.) so we can see exactly which step failed —
  // e.g. whether it errors immediately on open vs. specifically during the
  // handoff to the institution's OAuth page.
  const handleEvent: PlaidLinkOnEvent = useCallback((eventName, metadata) => {
    // eslint-disable-next-line no-console
    console.debug('[Plaid Link] event:', eventName, metadata);
  }, []);

  const config: PlaidLinkOptions = {
    token: linkToken,
    onSuccess: handleSuccess,
    onExit: handleExit,
    onEvent: handleEvent,
  };

  const { open, ready } = usePlaidLink(config);

  return { fetchLinkToken, open, ready: ready && !!linkToken, loading, error };
};

import { useState, useCallback } from 'react';
import { usePlaidLink, PlaidLinkOptions, PlaidLinkOnSuccess } from 'react-plaid-link';
import { createLinkToken, exchangeToken, Account } from '../api/client';

interface UsePlaidConnectOptions {
  onSuccess: (accounts: Account[]) => void;
}

export const usePlaidConnect = ({ onSuccess }: UsePlaidConnectOptions) => {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLinkToken = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await createLinkToken();
      setLinkToken(token);
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
        onSuccess(accounts);
      } catch (e: any) {
        setError(e.message ?? 'Failed to connect account');
      } finally {
        setLoading(false);
      }
    },
    [onSuccess]
  );

  const config: PlaidLinkOptions = {
    token: linkToken,
    onSuccess: handleSuccess,
  };

  const { open, ready } = usePlaidLink(config);

  return { fetchLinkToken, open, ready: ready && !!linkToken, loading, error };
};

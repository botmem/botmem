import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';

interface ApiKey {
  id: string;
  name: string;
  lastFour: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export function useApiKeys() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchKeys = useCallback(async () => {
    try {
      setError(null);
      const data = await api.listApiKeys();
      setKeys(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const createKey = async (name: string, expiresAt?: string) => {
    const result = await api.createApiKey(name, expiresAt);
    await fetchKeys();
    return result.key;
  };

  const revokeKey = async (id: string) => {
    await api.revokeApiKey(id);
    await fetchKeys();
  };

  return { keys, loading, error, createKey, revokeKey };
}

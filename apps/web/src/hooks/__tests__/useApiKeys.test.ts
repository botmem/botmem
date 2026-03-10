import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

// Mock the api module
vi.mock('../../lib/api', () => ({
  api: {
    listApiKeys: vi.fn(),
    createApiKey: vi.fn(),
    revokeApiKey: vi.fn(),
  },
}));

import { api } from '../../lib/api';
import { useApiKeys } from '../useApiKeys';

const mockKeys = [
  { id: 'k1', name: 'Key 1', lastFour: 'abcd', createdAt: '2025-01-01', expiresAt: null, revokedAt: null },
  { id: 'k2', name: 'Key 2', lastFour: 'efgh', createdAt: '2025-01-02', expiresAt: '2026-01-01', revokedAt: null },
];

describe('useApiKeys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches keys on mount', async () => {
    vi.mocked(api.listApiKeys).mockResolvedValue(mockKeys as any);

    const { result } = renderHook(() => useApiKeys());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.keys).toEqual(mockKeys);
    expect(result.current.error).toBeNull();
  });

  it('sets error when fetch fails', async () => {
    vi.mocked(api.listApiKeys).mockRejectedValue(new Error('Unauthorized'));

    const { result } = renderHook(() => useApiKeys());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('Unauthorized');
    expect(result.current.keys).toEqual([]);
  });

  it('createKey calls API and refreshes list', async () => {
    vi.mocked(api.listApiKeys).mockResolvedValue(mockKeys as any);
    vi.mocked(api.createApiKey).mockResolvedValue({ key: 'bm_sk_newkey', id: 'k3', name: 'New Key', lastFour: 'ijkl' } as any);

    const { result } = renderHook(() => useApiKeys());

    await waitFor(() => expect(result.current.loading).toBe(false));

    let rawKey: string = '';
    await act(async () => {
      rawKey = await result.current.createKey('New Key', '2026-12-31', ['bank-1']);
    });

    expect(rawKey).toBe('bm_sk_newkey');
    expect(api.createApiKey).toHaveBeenCalledWith('New Key', '2026-12-31', ['bank-1']);
    expect(api.listApiKeys).toHaveBeenCalledTimes(2); // initial + after create
  });

  it('revokeKey calls API and refreshes list', async () => {
    vi.mocked(api.listApiKeys).mockResolvedValue(mockKeys as any);
    vi.mocked(api.revokeApiKey).mockResolvedValue(undefined as any);

    const { result } = renderHook(() => useApiKeys());

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.revokeKey('k1');
    });

    expect(api.revokeApiKey).toHaveBeenCalledWith('k1');
    expect(api.listApiKeys).toHaveBeenCalledTimes(2);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ApiKeysTab } from '../ApiKeysTab';
import { useApiKeys } from '../../../hooks/useApiKeys';

vi.mock('../../../hooks/useApiKeys', () => ({
  useApiKeys: vi.fn(),
}));

describe('ApiKeysTab', () => {
  it('marks expired keys and excludes them from the active count', () => {
    vi.mocked(useApiKeys).mockReturnValue({
      keys: [
        {
          id: 'active',
          name: 'Active Key',
          lastFour: 'abcd',
          createdAt: '2026-01-01T00:00:00.000Z',
          expiresAt: null,
          revokedAt: null,
        },
        {
          id: 'expired',
          name: 'Expired Key',
          lastFour: 'efgh',
          createdAt: '2025-01-01T00:00:00.000Z',
          expiresAt: '2020-01-01T00:00:00.000Z',
          revokedAt: null,
        },
      ],
      loading: false,
      error: null,
      createKey: vi.fn(async () => 'bm_sk_new'),
      revokeKey: vi.fn(async () => undefined),
    });

    render(<ApiKeysTab />);

    expect(screen.getByText('API KEYS (1/10)')).toBeInTheDocument();
    expect(screen.getByText('EXPIRED')).toBeInTheDocument();
    expect(screen.getByText('Expired Key')).toBeInTheDocument();
    expect(screen.getAllByText('REVOKE')[1]).toBeDisabled();
  });
});

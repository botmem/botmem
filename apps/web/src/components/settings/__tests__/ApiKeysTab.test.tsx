import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeysTab } from '../ApiKeysTab';

const useApiKeys = vi.fn();

vi.mock('../../../hooks/useApiKeys', () => ({
  useApiKeys: () => useApiKeys(),
}));

describe('ApiKeysTab', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-13T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('excludes expired keys from the active count and labels them', () => {
    useApiKeys.mockReturnValue({
      keys: [
        {
          id: 'active',
          name: 'Active key',
          lastFour: '1234',
          createdAt: '2026-01-01T00:00:00Z',
          expiresAt: '2027-01-01T00:00:00Z',
          revokedAt: null,
        },
        {
          id: 'expired',
          name: 'Expired key',
          lastFour: '9999',
          createdAt: '2025-01-01T00:00:00Z',
          expiresAt: '2026-01-01T00:00:00Z',
          revokedAt: null,
        },
      ],
      loading: false,
      error: null,
      createKey: vi.fn(),
      revokeKey: vi.fn(),
    });

    render(<ApiKeysTab />);

    expect(screen.getByText('API KEYS (1/10)')).toBeInTheDocument();
    expect(screen.getByText('Active key')).toBeInTheDocument();
    expect(screen.getByText('Expired key')).toBeInTheDocument();
    expect(screen.getByText('Expired')).toBeInTheDocument();
  });
});

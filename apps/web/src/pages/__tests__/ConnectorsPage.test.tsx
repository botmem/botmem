import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ConnectorAccount } from '@botmem/shared';
import { ConnectorsPage } from '../ConnectorsPage';

const mockUseConnectors = vi.hoisted(() => vi.fn());

vi.mock('../../hooks/useConnectors', () => ({
  useConnectors: mockUseConnectors,
}));

vi.mock('../../lib/api', () => ({
  api: {
    getConnectorStatus: vi.fn(),
  },
}));

vi.mock('../../lib/ws', () => ({
  sharedWs: {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    onMessage: vi.fn(),
    offMessage: vi.fn(),
  },
}));

const account: ConnectorAccount = {
  id: 'gmail-1',
  type: 'gmail',
  identifier: 'you@gmail.com',
  status: 'connected',
  schedule: 'manual',
  lastSync: null,
  memoriesIngested: 0,
  contactsCount: 0,
  groupsCount: 0,
  lastError: null,
};

function connectorsState(accounts: ConnectorAccount[]) {
  return {
    accounts,
    manifests: [
      {
        id: 'gmail',
        name: 'Gmail',
        description: 'Import emails',
        color: '#FF6B9D',
        authType: 'oauth2',
        sync: { configurable: true },
      },
    ],
    removeAccount: vi.fn(),
    syncNow: vi.fn(),
    syncAll: vi.fn(),
    syncingAll: false,
    fetchAccounts: vi.fn(),
    error: null,
    clearError: vi.fn(),
  };
}

describe('ConnectorsPage', () => {
  beforeEach(() => {
    mockUseConnectors.mockReturnValue(connectorsState([account]));
  });

  it('expands connector rows from the URL', () => {
    render(
      <MemoryRouter initialEntries={['/connectors?expanded=gmail']}>
        <ConnectorsPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('you@gmail.com')).toBeInTheDocument();
  });

  it('auto-expands connectors with active jobs', () => {
    mockUseConnectors.mockReturnValueOnce(
      connectorsState([
        {
          ...account,
          status: 'queued',
          syncHealth: {
            phase: 'Queued for sync',
            lastActivityAt: null,
            activeJobId: null,
            queuedJobId: 'job-1',
            progress: null,
            total: null,
            recoveryAction: null,
            recoveryReason: null,
          },
        },
      ]),
    );

    render(
      <MemoryRouter initialEntries={['/connectors']}>
        <ConnectorsPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('you@gmail.com')).toBeInTheDocument();
    expect(screen.getByText('Queued for sync')).toBeInTheDocument();
  });
});

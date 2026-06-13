import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectorsPage } from '../ConnectorsPage';

const connectorStore = vi.hoisted(() => ({
  accounts: [
    {
      id: 'a1',
      type: 'gmail',
      identifier: 'you@gmail.com',
      status: 'error',
      schedule: 'manual',
      lastSync: null,
      memoriesIngested: 0,
      contactsCount: 0,
      groupsCount: 0,
      lastError: 'OAuth expired',
    },
  ],
  manifests: [
    {
      id: 'gmail',
      name: 'Gmail',
      description: 'Import emails',
      color: '#FF6B9D',
      icon: 'mail',
      authType: 'oauth2',
      configSchema: {},
      entities: [],
      pipeline: {},
      trustScore: 0.9,
    },
  ],
  removeAccount: vi.fn(),
  syncNow: vi.fn(),
  syncAll: vi.fn(),
  syncingAll: false,
  fetchAccounts: vi.fn(),
  error: null,
  clearError: vi.fn(),
}));

vi.mock('../../hooks/useConnectors', () => ({
  useConnectors: () => connectorStore,
}));

vi.mock('../../lib/api', () => ({
  api: { getConnectorStatus: vi.fn() },
}));

vi.mock('../../lib/ws', () => ({
  sharedWs: {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    onMessage: vi.fn(),
    offMessage: vi.fn(),
  },
}));

vi.mock('../../store/authStore', () => ({
  useAuthStore: vi.fn(() => null),
}));

vi.mock('../../components/connectors/ConnectorSetupModal', () => ({
  ConnectorSetupModal: () => null,
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <ConnectorsPage />
    </MemoryRouter>,
  );
}

describe('ConnectorsPage', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it('shows collapsed status, pluralizes account count, and restores accordion state', () => {
    const first = renderPage();

    expect(screen.getByText('1 account')).toBeInTheDocument();
    expect(screen.getByText('error')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Gmail connector' }));
    expect(screen.getByRole('button', { name: 'Collapse Gmail connector' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(sessionStorage.getItem('botmem.connectorAccordion')).toBe('["gmail"]');

    first.unmount();
    renderPage();
    expect(screen.getByRole('button', { name: 'Collapse Gmail connector' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConnectorSetupModal } from '../connectors/ConnectorSetupModal';
import { useConnectorStore } from '../../store/connectorStore';

vi.mock('../../lib/api', () => ({
  api: {
    getConnectorSchema: vi.fn().mockRejectedValue(new Error('not available')),
    initiateAuth: vi.fn().mockResolvedValue({ type: 'complete' }),
    hasCredentials: vi.fn().mockResolvedValue({ hasSavedCredentials: false }),
    listConnectors: vi.fn().mockResolvedValue({ connectors: [] }),
    listAccounts: vi.fn().mockResolvedValue({ accounts: [] }),
  },
}));

// Allow tests to control isFirebaseMode
let mockIsFirebaseMode = false;
vi.mock('../../store/authStore', async () => {
  const actual = await vi.importActual('../../store/authStore');
  return {
    ...actual,
    get isFirebaseMode() {
      return mockIsFirebaseMode;
    },
  };
});

describe('ConnectorSetupModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConnectorStore.setState({
      manifests: [
        {
          id: 'gmail',
          name: 'Gmail',
          description: 'Import emails',
          color: '#FF6B9D',
          icon: 'mail',
          authType: 'oauth2',
          configSchema: {
            type: 'object',
            properties: {
              clientId: { type: 'string', title: 'Client ID' },
              clientSecret: { type: 'string', title: 'Client Secret' },
            },
            required: ['clientId', 'clientSecret'],
          },
          entities: ['person', 'message', 'file'],
          pipeline: { clean: true, embed: true, enrich: true },
          trustScore: 0.95,
        },
      ],
    });
  });

  it('renders nothing when not open', () => {
    const { container } = render(
      <ConnectorSetupModal open={false} onClose={vi.fn()} connectorType="gmail" onConnect={vi.fn()} />
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders modal with title when open', () => {
    render(
      <ConnectorSetupModal open={true} onClose={vi.fn()} connectorType="gmail" onConnect={vi.fn()} />
    );
    expect(screen.getByText('Connect GMAIL')).toBeInTheDocument();
  });

  it('renders form fields from manifest schema', async () => {
    render(
      <ConnectorSetupModal open={true} onClose={vi.fn()} connectorType="gmail" onConnect={vi.fn()} />
    );
    // Wait for fields to render
    expect(await screen.findByText('Client ID')).toBeInTheDocument();
    expect(await screen.findByText('Client Secret')).toBeInTheDocument();
  });

  it('renders CONNECT button', async () => {
    render(
      <ConnectorSetupModal open={true} onClose={vi.fn()} connectorType="gmail" onConnect={vi.fn()} />
    );
    expect(await screen.findByText('CONNECT')).toBeInTheDocument();
  });

  describe('Firebase mode field hiding', () => {
    beforeEach(() => {
      mockIsFirebaseMode = true;
    });

    afterEach(() => {
      mockIsFirebaseMode = false;
    });

    it('hides clientId and clientSecret fields in Firebase mode', async () => {
      render(
        <ConnectorSetupModal open={true} onClose={vi.fn()} connectorType="gmail" onConnect={vi.fn()} />
      );
      // Should still render the connect button
      expect(await screen.findByText('CONNECT')).toBeInTheDocument();
      // But should NOT show the OAuth fields
      expect(screen.queryByText('Client ID')).not.toBeInTheDocument();
      expect(screen.queryByText('Client Secret')).not.toBeInTheDocument();
    });

    it('still renders the modal title in Firebase mode', async () => {
      render(
        <ConnectorSetupModal open={true} onClose={vi.fn()} connectorType="gmail" onConnect={vi.fn()} />
      );
      expect(screen.getByText('Connect GMAIL')).toBeInTheDocument();
    });
  });

  describe('Local mode field visibility', () => {
    beforeEach(() => {
      mockIsFirebaseMode = false;
    });

    it('shows clientId and clientSecret fields in local mode', async () => {
      render(
        <ConnectorSetupModal open={true} onClose={vi.fn()} connectorType="gmail" onConnect={vi.fn()} />
      );
      expect(await screen.findByText('Client ID')).toBeInTheDocument();
      expect(await screen.findByText('Client Secret')).toBeInTheDocument();
    });
  });
});

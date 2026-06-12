import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConnectorSetupModal } from '../connectors/ConnectorSetupModal';
import { useConnectorStore } from '../../store/connectorStore';

const mockApi = vi.hoisted(() => ({
  getConnectorSchema: vi.fn().mockRejectedValue(new Error('not available')),
  initiateAuth: vi.fn().mockResolvedValue({ type: 'complete' }),
  hasCredentials: vi.fn().mockResolvedValue({ hasSavedCredentials: false }),
  listConnectors: vi.fn().mockResolvedValue({ connectors: [] }),
  listAccounts: vi.fn().mockResolvedValue({ accounts: [] }),
  getBridgeStatus: vi.fn().mockResolvedValue({ connected: false }),
  triggerSync: vi.fn().mockResolvedValue({ job: { id: 'j1' } }),
}));

vi.mock('../../lib/api', () => ({
  api: mockApi,
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
    mockApi.getConnectorSchema.mockRejectedValue(new Error('not available'));
    mockApi.initiateAuth.mockResolvedValue({ type: 'complete' });
    mockApi.hasCredentials.mockResolvedValue({ hasSavedCredentials: false });
    mockApi.listConnectors.mockResolvedValue({ connectors: [] });
    mockApi.listAccounts.mockResolvedValue({ accounts: [] });
    mockApi.getBridgeStatus.mockResolvedValue({ connected: false });
    mockApi.triggerSync.mockResolvedValue({ job: { id: 'j1' } });
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
      <ConnectorSetupModal
        open={false}
        onClose={vi.fn()}
        connectorType="gmail"
        onConnect={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders modal with title when open', () => {
    render(
      <ConnectorSetupModal
        open={true}
        onClose={vi.fn()}
        connectorType="gmail"
        onConnect={vi.fn()}
      />,
    );
    expect(screen.getByText('Connect GMAIL')).toBeInTheDocument();
  });

  it('renders form fields from manifest schema', async () => {
    render(
      <ConnectorSetupModal
        open={true}
        onClose={vi.fn()}
        connectorType="gmail"
        onConnect={vi.fn()}
      />,
    );
    // Wait for fields to render
    expect(await screen.findByText('Client ID')).toBeInTheDocument();
    expect(await screen.findByText('Client Secret')).toBeInTheDocument();
  });

  it('renders CONNECT button', async () => {
    render(
      <ConnectorSetupModal
        open={true}
        onClose={vi.fn()}
        connectorType="gmail"
        onConnect={vi.fn()}
      />,
    );
    expect(await screen.findByText('CONNECT')).toBeInTheDocument();
  });

  it('shows an error when auth completes without a backend account', async () => {
    mockApi.initiateAuth.mockResolvedValue({ type: 'complete' });
    const onConnect = vi.fn();
    render(
      <ConnectorSetupModal
        open={true}
        onClose={vi.fn()}
        connectorType="gmail"
        onConnect={onConnect}
      />,
    );

    fireEvent.change(await screen.findByLabelText('Client ID'), {
      target: { value: 'client' },
    });
    fireEvent.change(screen.getByLabelText('Client Secret'), {
      target: { value: 'secret' },
    });
    fireEvent.click(screen.getByText('CONNECT'));

    expect(
      await screen.findByText('Connection did not return a connected account'),
    ).toBeInTheDocument();
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('shows auth initiation errors', async () => {
    mockApi.initiateAuth.mockRejectedValue(new Error('OAuth denied'));
    render(
      <ConnectorSetupModal
        open={true}
        onClose={vi.fn()}
        connectorType="gmail"
        onConnect={vi.fn()}
      />,
    );

    fireEvent.change(await screen.findByLabelText('Client ID'), {
      target: { value: 'client' },
    });
    fireEvent.change(screen.getByLabelText('Client Secret'), {
      target: { value: 'secret' },
    });
    fireEvent.click(screen.getByText('CONNECT'));

    expect(await screen.findByText('OAuth denied')).toBeInTheDocument();
  });

  it('renders Apple pairing copy without web-owned source controls', () => {
    useConnectorStore.setState({
      manifests: [
        {
          id: 'apple',
          name: 'Apple',
          description: 'Import Apple data',
          color: '#4ECDC4',
          icon: 'smartphone',
          authType: 'local-tool',
          configSchema: { type: 'object', properties: {}, required: [] },
          entities: ['person', 'message'],
          pipeline: { clean: false, embed: true, enrich: false },
          trustScore: 0.8,
        },
      ],
    });

    render(
      <ConnectorSetupModal
        open={true}
        onClose={vi.fn()}
        connectorType="apple"
        onConnect={vi.fn()}
      />,
    );

    expect(screen.getByText(/Apple sources and permissions are configured/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Contacts' })).not.toBeInTheDocument();
  });

  it('shows GitHub app setup and advanced CLI after generating Apple bridge config', async () => {
    mockApi.initiateAuth.mockResolvedValue({
      type: 'complete',
      account: { id: 'acct-1', bridgeToken: 'token-1' },
    });
    useConnectorStore.setState({
      manifests: [
        {
          id: 'apple',
          name: 'Apple',
          description: 'Import Apple data',
          color: '#4ECDC4',
          icon: 'smartphone',
          authType: 'local-tool',
          configSchema: { type: 'object', properties: {}, required: [] },
          entities: ['person', 'message'],
          pipeline: { clean: false, embed: true, enrich: false },
          trustScore: 0.8,
        },
      ],
    });

    render(
      <ConnectorSetupModal
        open={true}
        onClose={vi.fn()}
        connectorType="apple"
        onConnect={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Your Email or Phone'), {
      target: { value: 'you@icloud.com' },
    });
    fireEvent.click(screen.getByText('PAIR BRIDGE'));

    expect(await screen.findByText('App Setup')).toBeInTheDocument();
    expect(screen.getByText('GitHub Releases')).toHaveAttribute(
      'href',
      'https://github.com/botmem/botmem/releases/latest',
    );
    await waitFor(() => {
      expect(screen.getByText(/--sources=contacts,imessages/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Full Disk Access is only required/)).toBeInTheDocument();
  });

  it('tells users source choices live in the bridge app or CLI', async () => {
    mockApi.initiateAuth.mockResolvedValue({
      type: 'complete',
      account: { id: 'acct-1', bridgeToken: 'token-1' },
    });
    useConnectorStore.setState({
      manifests: [
        {
          id: 'apple',
          name: 'Apple',
          description: 'Import Apple data',
          color: '#4ECDC4',
          icon: 'smartphone',
          authType: 'local-tool',
          configSchema: { type: 'object', properties: {}, required: [] },
          entities: ['person', 'message'],
          pipeline: { clean: false, embed: true, enrich: false },
          trustScore: 0.8,
        },
      ],
    });

    render(
      <ConnectorSetupModal
        open={true}
        onClose={vi.fn()}
        connectorType="apple"
        onConnect={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Your Email or Phone'), {
      target: { value: 'you@icloud.com' },
    });
    fireEvent.click(screen.getByText('PAIR BRIDGE'));

    expect(await screen.findByText('App Setup')).toBeInTheDocument();
    expect(
      screen.getByText(/Choose Contacts and\/or Messages in the bridge app/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Use the same --sources list/)).toBeInTheDocument();
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
        <ConnectorSetupModal
          open={true}
          onClose={vi.fn()}
          connectorType="gmail"
          onConnect={vi.fn()}
        />,
      );
      // Should still render the connect button
      expect(await screen.findByText('CONNECT')).toBeInTheDocument();
      // But should NOT show the OAuth fields
      expect(screen.queryByText('Client ID')).not.toBeInTheDocument();
      expect(screen.queryByText('Client Secret')).not.toBeInTheDocument();
    });

    it('still renders the modal title in Firebase mode', async () => {
      render(
        <ConnectorSetupModal
          open={true}
          onClose={vi.fn()}
          connectorType="gmail"
          onConnect={vi.fn()}
        />,
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
        <ConnectorSetupModal
          open={true}
          onClose={vi.fn()}
          connectorType="gmail"
          onConnect={vi.fn()}
        />,
      );
      expect(await screen.findByText('Client ID')).toBeInTheDocument();
      expect(await screen.findByText('Client Secret')).toBeInTheDocument();
    });
  });
});

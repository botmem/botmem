import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

// Pin the tunnel URL to the prod-rewritten api host so the deep link the
// Connect button builds is asserted against the host the bridge must reach.
// (The app->api host rewrite itself is unit-tested in lib/__tests__/urls.test.ts.)
vi.mock('../../lib/urls', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/urls')>();
  return {
    ...actual,
    appleTunnelUrl: () => 'wss://api.botmem.xyz/apple-tunnel',
  };
});

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
    vi.useRealTimers();
    vi.clearAllMocks();
    mockIsFirebaseMode = false;
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
    const onClose = vi.fn();
    render(
      <ConnectorSetupModal
        open={true}
        onClose={onClose}
        connectorType="gmail"
        onConnect={vi.fn()}
      />,
    );
    expect(screen.getByText('Connect GMAIL')).toBeInTheDocument();
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
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

  it('opens OAuth redirects in a new tab', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    mockApi.initiateAuth.mockResolvedValue({
      type: 'redirect',
      url: 'https://accounts.example/auth',
    });

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

    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        'https://accounts.example/auth',
        '_blank',
        'noopener,noreferrer',
      ),
    );
    open.mockRestore();
  });

  const appleManifest = {
    id: 'apple' as const,
    name: 'Apple',
    description: 'Import Apple data',
    color: '#4ECDC4',
    icon: 'smartphone',
    authType: 'local-tool' as const,
    configSchema: { type: 'object', properties: {}, required: [] },
    entities: ['person', 'message'] as ('person' | 'message')[],
    pipeline: { clean: false, embed: true, enrich: false },
    trustScore: 0.8,
  };

  // Advance the linear flow: Download -> Connect (provision) -> Status.
  const advanceAppleToConnect = () => {
    fireEvent.click(screen.getByText('NEXT'));
  };
  const provisionAppleBridge = () => {
    advanceAppleToConnect();
    fireEvent.change(screen.getByLabelText('Your Email or Phone'), {
      target: { value: 'you@icloud.com' },
    });
    fireEvent.click(screen.getByText('CONNECT'));
  };

  it('leads with a Download step and no web-owned source controls', () => {
    useConnectorStore.setState({ manifests: [appleManifest] });

    render(
      <ConnectorSetupModal
        open={true}
        onClose={vi.fn()}
        connectorType="apple"
        onConnect={vi.fn()}
      />,
    );

    expect(screen.getByText('Download Botmem for Mac')).toHaveAttribute(
      'href',
      'https://github.com/botmem/botmem/releases/latest',
    );
    expect(screen.getByText(/Install it, then come back and click Connect/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Contacts' })).not.toBeInTheDocument();
  });

  it('Connect builds a deep link with the api host and starts status polling', async () => {
    mockApi.initiateAuth.mockResolvedValue({
      type: 'complete',
      account: { id: 'acct-1', bridgeToken: 'token-1' },
    });
    useConnectorStore.setState({ manifests: [appleManifest] });

    render(
      <ConnectorSetupModal
        open={true}
        onClose={vi.fn()}
        connectorType="apple"
        onConnect={vi.fn()}
      />,
    );

    provisionAppleBridge();

    // Status step renders the manual "Reopen the app" deep link with the api host.
    const reopen = (await screen.findByText('Reopen the app')) as HTMLAnchorElement;
    const href = reopen.getAttribute('href') || '';
    expect(href).toContain('botmem-apple-bridge://connect');
    expect(href).toContain('server=wss%3A%2F%2Fapi.botmem.xyz%2Fapple-tunnel');
    expect(href).toContain('token=token-1');
    expect(href).toContain('accountId=acct-1');
    expect(href).toContain('sources=contacts%2Cimessages');

    expect(screen.getByText(/Waiting for the app/)).toBeInTheDocument();
  });

  it('flips to connected and shows source chips with a Done affordance', async () => {
    vi.useFakeTimers();
    try {
      mockApi.initiateAuth.mockResolvedValue({
        type: 'complete',
        account: { id: 'acct-1', bridgeToken: 'token-1' },
      });
      mockApi.getBridgeStatus.mockResolvedValue({
        connected: true,
        accountId: 'acct-1',
        sources: { contacts: true, imessages: true },
        lastSeenAt: '2026-06-16T00:00:00Z',
        lastError: null,
      });
      useConnectorStore.setState({ manifests: [appleManifest] });

      render(
        <ConnectorSetupModal
          open={true}
          onClose={vi.fn()}
          connectorType="apple"
          onConnect={vi.fn()}
        />,
      );

      await act(async () => {
        fireEvent.click(screen.getByText('NEXT'));
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Your Email or Phone'), {
          target: { value: 'you@icloud.com' },
        });
        fireEvent.click(screen.getByText('CONNECT'));
      });
      expect(screen.getByText(/Waiting for the app/)).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      expect(screen.getByText(/Connected · live search active/)).toBeInTheDocument();
      expect(screen.getByText('Contacts')).toBeInTheDocument();
      expect(screen.getByText('Messages')).toBeInTheDocument();
      expect(screen.getByText('DONE')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the terminal command tucked behind an advanced disclosure', async () => {
    mockApi.initiateAuth.mockResolvedValue({
      type: 'complete',
      account: { id: 'acct-1', bridgeToken: 'token-1' },
    });
    useConnectorStore.setState({ manifests: [appleManifest] });

    render(
      <ConnectorSetupModal
        open={true}
        onClose={vi.fn()}
        connectorType="apple"
        onConnect={vi.fn()}
      />,
    );

    advanceAppleToConnect();
    // The advanced disclosure exists on the Connect step but is collapsed.
    expect(screen.getByText('Advanced: run from terminal')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Your Email or Phone'), {
      target: { value: 'you@icloud.com' },
    });
    fireEvent.click(screen.getByText('CONNECT'));

    // On the status step the command is available inside the disclosure.
    await waitFor(() => {
      expect(screen.getByText(/--sources=contacts,imessages/)).toBeInTheDocument();
    });
    expect(screen.getByText(/--server=wss:\/\/api.botmem.xyz\/apple-tunnel/)).toBeInTheDocument();
  });

  it('backs off Apple bridge status polling while waiting', async () => {
    vi.useFakeTimers();
    try {
      mockApi.initiateAuth.mockResolvedValue({
        type: 'complete',
        account: { id: 'acct-1', bridgeToken: 'token-1' },
      });
      useConnectorStore.setState({ manifests: [appleManifest] });

      render(
        <ConnectorSetupModal
          open={true}
          onClose={vi.fn()}
          connectorType="apple"
          onConnect={vi.fn()}
        />,
      );

      await act(async () => {
        fireEvent.click(screen.getByText('NEXT'));
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Your Email or Phone'), {
          target: { value: 'you@icloud.com' },
        });
        fireEvent.click(screen.getByText('CONNECT'));
      });
      expect(screen.getByText(/Waiting for the app/)).toBeInTheDocument();
      expect(mockApi.getBridgeStatus).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(mockApi.getBridgeStatus).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(mockApi.getBridgeStatus).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(mockApi.getBridgeStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
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
      expect(await screen.findByText('CONTINUE TO GOOGLE')).toBeInTheDocument();
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

  it('shows an OAuth preflight instead of redirecting on open', async () => {
    mockIsFirebaseMode = true;
    mockApi.hasCredentials.mockResolvedValue({ hasSavedCredentials: true });

    render(
      <ConnectorSetupModal
        open={true}
        onClose={vi.fn()}
        connectorType="gmail"
        onConnect={vi.fn()}
      />,
    );

    expect(await screen.findByText('Authorization Preview')).toBeInTheDocument();
    expect(screen.getByText('CONTINUE TO GOOGLE')).toBeInTheDocument();
    expect(mockApi.initiateAuth).not.toHaveBeenCalled();
    mockIsFirebaseMode = false;
  });

  it('starts reconnect on the Connect step with the identifier prefilled', async () => {
    mockApi.initiateAuth.mockResolvedValue({
      type: 'complete',
      account: { id: 'acct-1', bridgeToken: 'token-1' },
    });
    useConnectorStore.setState({ manifests: [appleManifest] });

    render(
      <ConnectorSetupModal
        open={true}
        onClose={vi.fn()}
        connectorType="apple"
        editAccountId="acct-1"
        editIdentifier="you@icloud.com"
        onConnect={vi.fn()}
      />,
    );

    // Reconnect skips Download — lands on Connect with the identifier prefilled.
    expect((screen.getByLabelText('Your Email or Phone') as HTMLInputElement).value).toBe(
      'you@icloud.com',
    );
    fireEvent.click(screen.getByText('CONNECT'));
    await waitFor(() => {
      expect(mockApi.initiateAuth).toHaveBeenCalledWith(
        'apple',
        expect.objectContaining({ myIdentifier: 'you@icloud.com' }),
      );
    });
    expect(await screen.findByText('Reopen the app')).toBeInTheDocument();
  });

  it('copies the tucked-away terminal command with copied feedback', async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    mockApi.initiateAuth.mockResolvedValue({
      type: 'complete',
      account: { id: 'acct-1', bridgeToken: 'token-1' },
    });
    useConnectorStore.setState({ manifests: [appleManifest] });

    render(
      <ConnectorSetupModal
        open={true}
        onClose={vi.fn()}
        connectorType="apple"
        onConnect={vi.fn()}
      />,
    );

    provisionAppleBridge();

    await screen.findByText(/--token=token-1/);
    vi.useFakeTimers();
    fireEvent.click(screen.getByText('COPY'));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('--token=token-1'));
    expect(screen.getByText('COPIED')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText('COPY')).toBeInTheDocument();
    vi.useRealTimers();
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

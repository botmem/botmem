import { act, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionsWorkspace } from './ConnectionsWorkspace.js';
import type { BotmemWebClient } from './data-client.js';

const WORKSPACE_ID = '8e5ffcc7-8e8f-4aaa-9c77-b87a979c60cf';
const ACCOUNT_ID = 'ae9af62a-c77a-43f7-b4c3-b8b0dd2b76f7';

describe('ConnectionsWorkspace', () => {
  it('gmailConnect_startsStateBoundOAuthAndNavigatesToTheReturnedProviderUrl', async () => {
    const client = fakeClient();
    client.beginOAuthConnection = vi.fn<BotmemWebClient['beginOAuthConnection']>(async () => ({
      version: 2 as const,
      connector: 'gmail',
      accountId: ACCOUNT_ID,
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque',
      expiresAt: '2026-07-13T10:10:00.000Z',
    }));
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(
      <ConnectionsWorkspace
        client={client}
        workspaceId={WORKSPACE_ID}
        navigateExternal={navigate}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'Connect Gmail' }));

    expect(client.beginOAuthConnection).toHaveBeenCalledWith(WORKSPACE_ID, {
      version: 2,
      connector: 'gmail',
    });
    expect(navigate).toHaveBeenCalledWith(
      'https://accounts.google.com/o/oauth2/v2/auth?state=opaque',
    );
  });

  it('ownTracksConnect_sendsCredentialsOnceAndClearsThePasswordField', async () => {
    const client = fakeClient();
    client.connectOwnTracks = vi.fn<BotmemWebClient['connectOwnTracks']>(async () => ({
      version: 2 as const,
      connection: {
        id: ACCOUNT_ID,
        connector: 'owntracks' as const,
        authType: 'basic' as const,
        label: 'recorder.example.test',
        state: 'syncing' as const,
        source: {
          connector: 'owntracks' as const,
          readiness: 'indexing' as const,
          searchable: false,
        },
      },
    }));
    const user = userEvent.setup();
    render(<ConnectionsWorkspace client={client} workspaceId={WORKSPACE_ID} />);

    await user.type(
      await screen.findByLabelText('Recorder URL'),
      'https://recorder.example.test/api/0/locations',
    );
    await user.type(screen.getByLabelText('Username'), 'owner');
    const password = screen.getByLabelText('Password');
    await user.type(password, 'secret-value');
    await user.click(screen.getByRole('button', { name: 'Connect OwnTracks' }));

    await waitFor(() => {
      expect(client.connectOwnTracks).toHaveBeenCalledWith(WORKSPACE_ID, {
        version: 2,
        endpoint: 'https://recorder.example.test/api/0/locations',
        username: 'owner',
        password: 'secret-value',
      });
    });
    expect(password).toHaveValue('');
  });

  it('syncingConnection_pollsUntilSearchableAndStopsAfterUnmount', async () => {
    vi.useFakeTimers();
    try {
      const client = fakeClient();
      vi.mocked(client.listConnections)
        .mockResolvedValueOnce({ version: 2, items: [gmailConnection('syncing', false)] })
        .mockResolvedValueOnce({ version: 2, items: [gmailConnection('ready', true)] });
      const view = render(
        <ConnectionsWorkspace
          client={client}
          workspaceId={WORKSPACE_ID}
          connectionNotice={{ connector: 'gmail', status: 'connected' }}
        />,
      );
      await act(async () => {
        await Promise.resolve();
      });

      expect(screen.getByText('Gmail authorization returned.')).toBeVisible();
      expect(screen.getByText(/Initial sync is running/u)).toBeVisible();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(screen.getByText('Initial sync is ready for search.')).toBeVisible();
      expect(client.listConnections).toHaveBeenCalledTimes(2);

      view.unmount();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(client.listConnections).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps healthy hosted controls when the Mac device read fails', async () => {
    const client = fakeClient();
    vi.mocked(client.listDevices).mockRejectedValue(new Error('device status unavailable'));
    render(<ConnectionsWorkspace client={client} workspaceId={WORKSPACE_ID} />);

    expect(await screen.findByRole('button', { name: 'Connect Gmail' })).toBeEnabled();
    expect(screen.getByText('device status unavailable')).toBeVisible();
    expect(screen.queryByText('No Mac is paired.')).not.toBeInTheDocument();
  });
});

function gmailConnection(state: 'syncing' | 'ready', searchable: boolean) {
  return {
    id: ACCOUNT_ID,
    connector: 'gmail' as const,
    authType: 'oauth2' as const,
    label: 'owner@example.test',
    state,
    source: {
      connector: 'gmail' as const,
      readiness: searchable ? ('ready' as const) : ('indexing' as const),
      searchable,
    },
  };
}

function fakeClient(): BotmemWebClient {
  return {
    startEmailLogin: vi.fn<BotmemWebClient['startEmailLogin']>(),
    getPublicReleases: vi.fn<BotmemWebClient['getPublicReleases']>(),
    completeEmailLogin: vi.fn<BotmemWebClient['completeEmailLogin']>(),
    getBillingPrice: vi.fn<BotmemWebClient['getBillingPrice']>(async () => billingPrice()),
    createBillingCheckout: vi.fn<BotmemWebClient['createBillingCheckout']>(),
    getBillingCheckoutStatus: vi.fn<BotmemWebClient['getBillingCheckoutStatus']>(),
    getBillingStatus: vi.fn<BotmemWebClient['getBillingStatus']>(),
    createBillingPortal: vi.fn<BotmemWebClient['createBillingPortal']>(),
    search: vi.fn(),
    listSourceStatuses: vi.fn(async () => []),
    listConnections: vi.fn<BotmemWebClient['listConnections']>(async () => ({
      version: 2,
      items: [],
    })),
    beginOAuthConnection: vi.fn(),
    connectOwnTracks: vi.fn(),
    actOnConnection: vi.fn(),
    listDevices: vi.fn<BotmemWebClient['listDevices']>(async () => ({ version: 2, items: [] })),
    issuePairingCode: vi.fn<BotmemWebClient['issuePairingCode']>(),
    issueDeviceSetup: vi.fn<BotmemWebClient['issueDeviceSetup']>(),
    listPersonalAccessTokens: vi.fn<BotmemWebClient['listPersonalAccessTokens']>(async () => ({
      version: 2,
      items: [],
    })),
    issuePersonalAccessToken: vi.fn<BotmemWebClient['issuePersonalAccessToken']>(),
    revokePersonalAccessToken: vi.fn<BotmemWebClient['revokePersonalAccessToken']>(),
    listLifecycleJobs: vi.fn<BotmemWebClient['listLifecycleJobs']>(async () => ({
      version: 2,
      items: [],
    })),
    requestWorkspaceExport: vi.fn<BotmemWebClient['requestWorkspaceExport']>(),
    requestWorkspaceDeletion: vi.fn<BotmemWebClient['requestWorkspaceDeletion']>(),
    signOut: vi.fn<BotmemWebClient['signOut']>(),
    downloadWorkspaceExport: vi.fn<BotmemWebClient['downloadWorkspaceExport']>(),
  };
}

function billingPrice() {
  return {
    version: 2 as const,
    currency: 'usd',
    unitAmountMinor: 1900,
    interval: 'month' as const,
    intervalCount: 1,
    checkoutAvailable: true as const,
  };
}

import {
  SourceStatusSchema,
  SearchResponseSchema,
  type SearchResponse,
  type SourceStatus,
} from '@botmem-v2/contracts';
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import type { BotmemWebClient } from './data-client.js';

const WORKSPACE_ID = 'workspace-1';
const DEVICE_ID = 'df381211-58ea-4558-a36f-a2a3202bc682';
const ACCOUNT_ID = 'ae9af62a-c77a-43f7-b4c3-b8b0dd2b76f7';

describe('Botmem search page', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('search_whenAResultHasLowScore_rendersItWithProvenanceAndRanking', async () => {
    const response = searchResponse({
      items: [
        {
          ref: 'gmail:sentinel',
          sourceId: 'sentinel',
          revision: '1',
          origin: { placement: 'hosted', connector: 'gmail', accountId: ACCOUNT_ID },
          kind: 'email',
          occurredAt: '2026-07-13T10:00:00.000Z',
          title: 'Launch decision',
          text: 'The sentinel result must remain visible even at a low score.',
          participants: [],
          media: [],
          citation: 'botmem://memory/gmail:sentinel',
          ranking: { rank: 1, score: 0.01, matchedLanes: ['hosted'] },
        },
      ],
      found: 1,
    });
    const client = fakeClient([readyGmail()], response);
    const user = userEvent.setup();
    render(<App client={client} workspaceId={WORKSPACE_ID} />);

    await user.type(screen.getByLabelText('Search your memory'), 'launch decision');
    await user.click(screen.getByRole('button', { name: 'Search memory' }));

    const result = await screen.findByRole('article', { name: 'Launch decision' });
    expect(
      within(result).getByText('The sentinel result must remain visible even at a low score.'),
    ).toBeVisible();
    expect(within(result).getByText('Gmail')).toBeVisible();
    expect(within(result).getByText('HOSTED')).toBeVisible();
    expect(within(result).getByText('1.0%')).toBeVisible();
    expect(within(result).getByText('botmem://memory/gmail:sentinel')).toBeVisible();
    const completion = screen.getByRole('heading', { name: '1 memory found' });
    await waitFor(() => expect(completion).toHaveFocus());
    expect(document.title).toBe('Botmem — 1 result');
  });

  it('search_whenDeviceIsOffline_keepsResultsAndShowsExplicitPartialWarning', async () => {
    const response = searchResponse({
      partial: true,
      lanes: [
        completeHostedLane(),
        {
          laneId: `device:${DEVICE_ID}`,
          placement: 'device',
          deviceId: DEVICE_ID,
          status: 'offline',
          retryable: true,
          returned: 0,
          tookMs: 0,
          reasonCode: 'device_disconnected',
        },
      ],
    });
    const client = fakeClient([readyGmail()], response);
    const user = userEvent.setup();
    render(<App client={client} workspaceId={WORKSPACE_ID} />);

    await user.type(screen.getByLabelText('Search your memory'), 'sentinel');
    await user.keyboard('{Enter}');

    const warningHeading = await screen.findByText('Search coverage is partial.');
    const warning = warningHeading.closest('section');
    expect(warning).not.toBeNull();
    if (!warning) throw new Error('partial coverage section is missing');
    expect(within(warning).getByText('Search coverage is partial.')).toBeVisible();
    expect(within(warning).getByText('Offline')).toBeVisible();
    expect(within(warning).getByText('device_disconnected')).toBeVisible();
  });

  it('sources_whenMacPermissionIsMissing_showsPermissionRequired', async () => {
    const permissionRequired = SourceStatusSchema.parse({
      connector: 'imessage',
      readiness: 'locked',
      detail: 'permission_required',
      searchable: false,
      reasonCode: 'full_disk_access_required',
    });
    render(
      <App
        client={fakeClient([permissionRequired], searchResponse())}
        workspaceId={WORKSPACE_ID}
      />,
    );

    expect(await screen.findByText('Permission required')).toBeVisible();
    expect(screen.getByText('full_disk_access_required')).toBeVisible();
  });

  it('search_whenEnterIsPressed_submitsCanonicalQuery', async () => {
    const client = fakeClient([], searchResponse());
    const user = userEvent.setup();
    render(<App client={client} workspaceId={WORKSPACE_ID} />);

    await user.type(screen.getByLabelText('Search your memory'), '  launch notes  {Enter}');

    await waitFor(() => {
      expect(client.search).toHaveBeenCalledWith(WORKSPACE_ID, {
        version: 2,
        query: 'launch notes',
      });
    });
  });

  it('sources_whenOnlyHeartbeatIsConnected_neverClaimsReady', async () => {
    const heartbeatOnly = SourceStatusSchema.parse({
      connector: 'whatsapp',
      readiness: 'connected',
      searchable: false,
      lastProbeAt: '2026-07-13T12:00:00.000Z',
    });
    render(
      <App client={fakeClient([heartbeatOnly], searchResponse())} workspaceId={WORKSPACE_ID} />,
    );

    expect(await screen.findByText('Connected · not searchable')).toBeVisible();
    expect(screen.queryByText('Ready')).not.toBeInTheDocument();
    expect(screen.getByText(/heartbeat means connected—not searchable/i)).toBeVisible();
  });

  it('accountNavigation_exposesOwnerControls', async () => {
    const user = userEvent.setup();
    render(<App client={fakeClient([], searchResponse())} workspaceId={WORKSPACE_ID} />);

    await user.click(screen.getByRole('button', { name: 'Account' }));

    expect(await screen.findByRole('heading', { name: 'Own the off-switch.' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Agent access' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Delete workspace' })).toBeVisible();
  });

  it('navigation_keepsTheAuthenticatedSkipLinkTargetValidInEveryWorkspace', async () => {
    const user = userEvent.setup();
    render(<App client={fakeClient([], searchResponse())} workspaceId={WORKSPACE_ID} />);

    const skipLink = screen.getByRole('link', { name: 'Skip to workspace' });
    expect(skipLink).toHaveAttribute('href', '#main-content');

    for (const view of ['Connections', 'Mac device', 'Billing', 'Account', 'Search']) {
      await user.click(screen.getByRole('button', { name: view }));
      const main = screen.getByRole('main');
      expect(main).toHaveAttribute('id', 'main-content');
      expect(main).toHaveAttribute('tabindex', '-1');
      await waitFor(() => expect(main).toHaveFocus());
      expect(document.title).toBe(`Botmem — ${view}`);
      expect(screen.getByText(`${view} workspace`)).toBeInTheDocument();
    }
  });

  it('macDevice_whenVerifiedReleaseIsConfigured_exposesImmutableDMGAndDigest', async () => {
    const user = userEvent.setup();
    const sha256 = 'a'.repeat(64);
    render(
      <App
        client={fakeClient([], searchResponse())}
        workspaceId={WORKSPACE_ID}
        releases={{
          version: 2,
          apiBaseUrl: 'https://api.botmem.test/',
          macos: {
            available: true,
            url: 'https://github.com/botmem/botmem/releases/download/botmem-v2-v2.4.1/Botmem.dmg',
            releaseVersion: '2.4.1',
            sha256,
          },
          cli: { available: false },
        }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Mac device' }));

    expect(screen.getByRole('link', { name: 'Download signed DMG · v2.4.1' })).toHaveAttribute(
      'href',
      'https://github.com/botmem/botmem/releases/download/botmem-v2-v2.4.1/Botmem.dmg',
    );
    expect(screen.getByText(sha256)).toBeVisible();
  });

  it('macDevice_withoutVerifiedRelease_neverOffersAnUnsignedFallback', async () => {
    const user = userEvent.setup();
    render(<App client={fakeClient([], searchResponse())} workspaceId={WORKSPACE_ID} />);

    await user.click(screen.getByRole('button', { name: 'Mac device' }));

    expect(screen.getByText(/verified Mac download is temporarily unavailable/i)).toBeVisible();
    expect(screen.queryByRole('link', { name: /download/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate Mac setup' })).toBeEnabled();
  });

  it('oauthCallback_opensConnectionsAndShowsInitialSyncProgress', async () => {
    window.history.replaceState(null, '', '/connections?connector=gmail&status=connected');
    const client = fakeClient([], searchResponse());
    vi.mocked(client.listConnections).mockResolvedValue({
      version: 2,
      items: [
        {
          id: ACCOUNT_ID,
          connector: 'gmail',
          authType: 'oauth2',
          label: 'owner@example.test',
          state: 'syncing',
          source: { connector: 'gmail', readiness: 'indexing', searchable: false },
        },
      ],
    });

    render(<App client={client} workspaceId={WORKSPACE_ID} />);

    expect(await screen.findByRole('heading', { name: 'Connect the evidence.' })).toBeVisible();
    expect(screen.getByText('Gmail authorization return received.')).toBeVisible();
    expect(screen.getByText(/Initial sync is running/u)).toBeVisible();
    expect(window.location.pathname).toBe('/connections');
    expect(window.location.search).toBe('');
    expect(screen.getByRole('button', { name: 'Connections' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('oauthCallback_withoutDurableRecord_neverClaimsAuthorizationSucceeded', async () => {
    window.history.replaceState(null, '', '/connections?connector=gmail&status=connected');
    render(<App client={fakeClient([], searchResponse())} workspaceId={WORKSPACE_ID} />);

    expect(await screen.findByText('Gmail authorization return received.')).toBeVisible();
    expect(screen.getByText(/Waiting for Botmem to confirm the connection record/u)).toBeVisible();
    expect(screen.queryByText(/Authorization succeeded/u)).not.toBeInTheDocument();
    expect(window.location.href).not.toContain('status=connected');
  });
});

function fakeClient(
  sources: readonly SourceStatus[],
  response: SearchResponse,
): BotmemWebClient & {
  search: ReturnType<typeof vi.fn<BotmemWebClient['search']>>;
} {
  return {
    startEmailLogin: vi.fn<BotmemWebClient['startEmailLogin']>(),
    getPublicReleases: vi.fn<BotmemWebClient['getPublicReleases']>(),
    completeEmailLogin: vi.fn<BotmemWebClient['completeEmailLogin']>(),
    getBillingPrice: vi.fn<BotmemWebClient['getBillingPrice']>(async () => billingPrice()),
    createBillingCheckout: vi.fn<BotmemWebClient['createBillingCheckout']>(),
    getBillingCheckoutStatus: vi.fn<BotmemWebClient['getBillingCheckoutStatus']>(),
    getBillingStatus: vi.fn<BotmemWebClient['getBillingStatus']>(),
    createBillingPortal: vi.fn<BotmemWebClient['createBillingPortal']>(),
    search: vi.fn<BotmemWebClient['search']>(async () => response),
    listSourceStatuses: vi.fn<BotmemWebClient['listSourceStatuses']>(async () => sources),
    listConnections: vi.fn<BotmemWebClient['listConnections']>(async () => ({
      version: 2,
      items: [],
    })),
    beginOAuthConnection: vi.fn<BotmemWebClient['beginOAuthConnection']>(),
    connectOwnTracks: vi.fn<BotmemWebClient['connectOwnTracks']>(),
    actOnConnection: vi.fn<BotmemWebClient['actOnConnection']>(),
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

function readyGmail(): SourceStatus {
  return SourceStatusSchema.parse({
    connector: 'gmail',
    readiness: 'ready',
    searchable: true,
    indexedCount: 1,
    checkpointAt: '2026-07-13T11:59:00.000Z',
    lastProbeAt: '2026-07-13T12:00:00.000Z',
  });
}

function completeHostedLane() {
  return {
    laneId: 'hosted',
    placement: 'hosted' as const,
    status: 'complete' as const,
    retryable: false,
    returned: 0,
    tookMs: 3,
  };
}

function searchResponse(
  overrides: {
    readonly items?: SearchResponse['items'];
    readonly found?: number;
    readonly partial?: boolean;
    readonly lanes?: SearchResponse['coverage']['lanes'];
  } = {},
): SearchResponse {
  return SearchResponseSchema.parse({
    version: 2,
    queryId: '52b2ecba-3d9a-4c9d-89c8-e06c7916eec1',
    items: overrides.items ?? [],
    coverage: {
      partial: overrides.partial ?? false,
      lanes: overrides.lanes ?? [completeHostedLane()],
    },
    found: overrides.found ?? 0,
    tookMs: 7,
  });
}

import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AccountWorkspace } from './AccountWorkspace.js';
import type { BotmemWebClient } from './data-client.js';

const WORKSPACE_ID = '8e5ffcc7-8e8f-4aaa-9c77-b87a979c60cf';
const TOKEN = `bmp_v2.${'A'.repeat(43)}`;

describe('AccountWorkspace', () => {
  it('issuesAOneTimeAgentToken_withExplicitReadOnlyScopes', async () => {
    const client = fakeClient();
    const user = userEvent.setup();
    render(
      <AccountWorkspace
        client={client}
        workspaceId={WORKSPACE_ID}
        releases={{
          version: 2,
          apiBaseUrl: 'https://api.botmem.test/',
          macos: { available: false },
          cli: {
            available: true,
            url: 'https://github.com/botmem/botmem/releases/download/botmem-v2-v2.4.1/botmem-v2-cli-2.4.1.tgz',
            releaseVersion: '2.4.1',
            sha256: 'a'.repeat(64),
          },
        }}
      />,
    );
    await screen.findByRole('heading', { name: 'Agent access' });

    await user.type(screen.getByLabelText('Token label'), 'Codex desktop');
    await user.click(screen.getByRole('button', { name: 'Create 30-day token' }));

    await waitFor(() =>
      expect(client.issuePersonalAccessToken).toHaveBeenCalledWith(WORKSPACE_ID, {
        version: 2,
        label: 'Codex desktop',
        ttlSeconds: 30 * 86_400,
        scopes: ['botmem:search', 'botmem:connections:read', 'botmem:devices:read'],
      }),
    );
    expect(await screen.findByLabelText('New personal access token')).toHaveValue(TOKEN);
    expect(screen.getByText(/will not show this token again/u)).toBeVisible();
    expect(screen.getByLabelText('Install verified CLI v2.4.1')).toHaveValue(
      "npm install --global 'https://github.com/botmem/botmem/releases/download/botmem-v2-v2.4.1/botmem-v2-cli-2.4.1.tgz'",
    );
    const cliSetup = screen.getByLabelText<HTMLTextAreaElement>('CLI setup and first search');
    const mcpConfig = screen.getByLabelText<HTMLTextAreaElement>('MCP client config');
    expect(cliSetup.value).toContain(`botmem search --workspace '${WORKSPACE_ID}'`);
    expect(mcpConfig.value).toContain(`https://api.botmem.test/v2/workspaces/${WORKSPACE_ID}/mcp`);
    expect(cliSetup.value).not.toContain(TOKEN);
    expect(mcpConfig.value).not.toContain(TOKEN);
  });

  it('deletion_requiresTypedAndHumanConfirmation_beforeQueuing', async () => {
    const client = fakeClient();
    const confirmDeletion = vi.fn(() => true);
    const user = userEvent.setup();
    render(
      <AccountWorkspace
        client={client}
        workspaceId={WORKSPACE_ID}
        confirmDeletion={confirmDeletion}
      />,
    );
    await screen.findByRole('heading', { name: 'Delete workspace' });
    const deleteButton = screen.getByRole('button', { name: 'Delete this workspace' });
    expect(deleteButton).toBeDisabled();

    await user.type(
      screen.getByLabelText(new RegExp(`DELETE ${WORKSPACE_ID}`, 'u')),
      `DELETE ${WORKSPACE_ID}`,
    );
    await user.click(deleteButton);

    expect(confirmDeletion).toHaveBeenCalledOnce();
    expect(client.requestWorkspaceDeletion).toHaveBeenCalledWith(
      WORKSPACE_ID,
      `DELETE ${WORKSPACE_ID}`,
    );
  });

  it('keeps lifecycle and sign-out controls available when token listing fails', async () => {
    const client = fakeClient();
    vi.mocked(client.listPersonalAccessTokens).mockRejectedValue(
      new Error('token list unavailable'),
    );
    render(<AccountWorkspace client={client} workspaceId={WORKSPACE_ID} />);

    expect(await screen.findByText(/Agent tokens: token list unavailable/u)).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Hosted export' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Delete workspace' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled();
  });
});

function fakeClient(): BotmemWebClient & {
  issuePersonalAccessToken: ReturnType<typeof vi.fn<BotmemWebClient['issuePersonalAccessToken']>>;
  requestWorkspaceDeletion: ReturnType<typeof vi.fn<BotmemWebClient['requestWorkspaceDeletion']>>;
} {
  const issuedAt = '2026-07-13T10:00:00.000Z';
  return {
    startEmailLogin: vi.fn<BotmemWebClient['startEmailLogin']>(),
    getPublicReleases: vi.fn<BotmemWebClient['getPublicReleases']>(),
    completeEmailLogin: vi.fn<BotmemWebClient['completeEmailLogin']>(),
    getBillingPrice: vi.fn<BotmemWebClient['getBillingPrice']>(async () => billingPrice()),
    createBillingCheckout: vi.fn<BotmemWebClient['createBillingCheckout']>(),
    getBillingCheckoutStatus: vi.fn<BotmemWebClient['getBillingCheckoutStatus']>(),
    getBillingStatus: vi.fn<BotmemWebClient['getBillingStatus']>(),
    createBillingPortal: vi.fn<BotmemWebClient['createBillingPortal']>(),
    search: vi.fn<BotmemWebClient['search']>(),
    listSourceStatuses: vi.fn<BotmemWebClient['listSourceStatuses']>(),
    listConnections: vi.fn<BotmemWebClient['listConnections']>(),
    beginOAuthConnection: vi.fn<BotmemWebClient['beginOAuthConnection']>(),
    connectOwnTracks: vi.fn<BotmemWebClient['connectOwnTracks']>(),
    actOnConnection: vi.fn<BotmemWebClient['actOnConnection']>(),
    listDevices: vi.fn<BotmemWebClient['listDevices']>(),
    issuePairingCode: vi.fn<BotmemWebClient['issuePairingCode']>(),
    issueDeviceSetup: vi.fn<BotmemWebClient['issueDeviceSetup']>(),
    listPersonalAccessTokens: vi.fn<BotmemWebClient['listPersonalAccessTokens']>(async () => ({
      version: 2,
      items: [],
    })),
    issuePersonalAccessToken: vi.fn<BotmemWebClient['issuePersonalAccessToken']>(async () => ({
      version: 2,
      credentialId: '10000000-0000-4000-8000-000000000001',
      accessToken: TOKEN,
      expiresAt: '2026-08-12T10:00:00.000Z',
    })),
    revokePersonalAccessToken: vi.fn<BotmemWebClient['revokePersonalAccessToken']>(),
    listLifecycleJobs: vi.fn<BotmemWebClient['listLifecycleJobs']>(async () => ({
      version: 2,
      items: [],
    })),
    requestWorkspaceExport: vi.fn<BotmemWebClient['requestWorkspaceExport']>(),
    requestWorkspaceDeletion: vi.fn<BotmemWebClient['requestWorkspaceDeletion']>(async () => ({
      version: 2,
      job: {
        version: 2,
        jobId: '10000000-0000-4000-8000-000000000002',
        kind: 'deletion',
        state: 'queued',
        requestedAt: issuedAt,
        attempts: 0,
        availableUntil: null,
        completedAt: null,
        failureCode: null,
        localDelete: { delivered: 0, unreachable: 1, pending: 1 },
      },
    })),
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

import { connectorAccountId, tenantId } from '@botmem-v2/connector-domain';
import { describe, expect, it, vi } from 'vitest';
import type { GmailOAuthService } from '../connectors/gmail/index.js';
import type { OutlookOAuthService } from '../connectors/outlook/index.js';
import type { OwnTracksEndpointPolicy } from '../connectors/owntracks/index.js';
import {
  HostedConnectionsService,
  type ConnectionAccountRecord,
  type ConnectionAccountRepository,
  type ConnectorCredentialVault,
} from './index.js';

const TENANT_ID = tenantId('10000000-0000-4000-8000-000000000001');
const ACCOUNT_ID = connectorAccountId('20000000-0000-4000-8000-000000000001');
const NEW_REF = 'vault:v1:51000000-0000-4000-8000-000000000001';

function record(overrides: Partial<ConnectionAccountRecord> = {}): ConnectionAccountRecord {
  return {
    tenantId: TENANT_ID,
    accountId: ACCOUNT_ID,
    connector: 'gmail',
    authKind: 'oauth2',
    providerSubjectHash: 'a'.repeat(64),
    credentialRef: NEW_REF,
    status: 'ready',
    displayLabel: 'owner@example.test',
    connectionConfig: {},
    activeSync: false,
    lastSyncAt: null,
    failureCode: null,
    ...overrides,
  };
}

function harness(existing: ConnectionAccountRecord | null = null) {
  let current = existing;
  const accounts: ConnectionAccountRepository = {
    reserveAccountId: vi.fn().mockResolvedValue(ACCOUNT_ID),
    completeConnection: vi.fn().mockImplementation(async (command) => {
      current = record({
        connector: command.connector,
        authKind: command.authKind,
        providerSubjectHash: command.providerSubjectHash,
        credentialRef: command.credentialRef,
        displayLabel: command.displayLabel,
        connectionConfig: command.connectionConfig,
      });
      return current;
    }),
    list: vi.fn().mockImplementation(async () => (current ? [current] : [])),
    get: vi.fn().mockImplementation(async () => current),
    disconnect: vi.fn().mockImplementation(async () => {
      current = record({ ...(current ?? {}), status: 'disconnected' });
      return current;
    }),
  };
  const vault: ConnectorCredentialVault = {
    store: vi.fn().mockResolvedValue(NEW_REF),
    read: vi.fn(),
    rotate: vi.fn(),
    rewrapToCurrentKey: vi.fn(),
    revoke: vi.fn().mockResolvedValue(undefined),
  };
  const gmail = {
    beginAuthorization: vi.fn().mockResolvedValue({
      authorizationUrl: 'https://accounts.google.test/authorize',
      expiresAt: '2026-07-13T10:10:00.000Z',
    }),
    completeAuthorization: vi.fn().mockResolvedValue({
      tenantId: TENANT_ID,
      accountId: ACCOUNT_ID,
      credentialRef: NEW_REF,
      providerSubjectHash: 'b'.repeat(64),
      emailAddress: 'owner@example.test',
      initialCursor: {
        connector: 'gmail',
        version: 1,
        mode: 'full',
        pageToken: null,
        anchorHistoryId: null,
      },
    }),
  } as unknown as GmailOAuthService;
  const outlook = {
    beginAuthorization: vi.fn(),
    completeAuthorization: vi.fn(),
  } as unknown as OutlookOAuthService;
  const scheduler = { enqueue: vi.fn().mockResolvedValue(undefined) };
  const endpointPolicy = {
    configure: vi.fn().mockResolvedValue({
      endpoint: 'https://recorder.example.test/api/0/locations',
      allowedPorts: [443],
    }),
  } as unknown as OwnTracksEndpointPolicy;
  const service = new HostedConnectionsService({
    accounts,
    vault,
    gmail,
    outlook,
    ownTracksEndpointPolicy: endpointPolicy,
    sourceStatuses: { list: vi.fn().mockResolvedValue([]) },
    scheduler,
    crypto: { sha256Hex: vi.fn().mockResolvedValue('c'.repeat(64)) },
    now: () => '2026-07-13T10:00:00.000Z',
  });
  return { service, accounts, vault, gmail, scheduler };
}

describe('HostedConnectionsService', () => {
  it('beginOAuthConnection_reservesTenantAccountBeforeIssuingState', async () => {
    const { service, accounts, gmail } = harness();
    const result = await service.beginOAuthConnection(TENANT_ID, {
      version: 2,
      connector: 'gmail',
    });

    expect(accounts.reserveAccountId).toHaveBeenCalledWith(TENANT_ID, 'gmail');
    expect(gmail.beginAuthorization).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      accountId: ACCOUNT_ID,
    });
    expect(result.accountId).toBe(ACCOUNT_ID);
  });

  it('completeGmail_reconnectsBoundAccountAndSchedulesSync', async () => {
    const old = record({ credentialRef: 'vault:v1:51000000-0000-4000-8000-000000000099' });
    const { service, accounts, scheduler } = harness(old);
    const result = await service.completeGmail({ state: 'state-fixture-long', code: 'code' });

    expect(accounts.completeConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        accountId: ACCOUNT_ID,
        connector: 'gmail',
        credentialRef: NEW_REF,
        providerSubjectHash: 'b'.repeat(64),
      }),
    );
    expect(scheduler.enqueue).toHaveBeenCalledOnce();
    expect(result.connection.state).toBe('syncing');
  });

  it('connectOwnTracks_returnsNoBasicCredentialMaterial', async () => {
    const { service, vault } = harness();
    const response = await service.connectOwnTracks(TENANT_ID, {
      version: 2,
      endpoint: 'https://recorder.example.test/api/0/locations',
      username: 'private-user',
      password: 'private-password',
    });

    expect(vault.store).toHaveBeenCalledWith(
      { tenantId: TENANT_ID, accountId: ACCOUNT_ID, connector: 'owntracks' },
      {
        kind: 'owntracks_basic',
        value: { username: 'private-user', password: 'private-password' },
      },
    );
    expect(JSON.stringify(response)).not.toContain('private-user');
    expect(JSON.stringify(response)).not.toContain('private-password');
  });

  it('listConnections_whenProbeUnavailable_reportsHonestConnectedNotReady', async () => {
    const { service } = harness(record());
    const response = await service.listConnections(TENANT_ID);

    expect(response.items[0]).toMatchObject({
      state: 'ready',
      source: {
        connector: 'gmail',
        readiness: 'connected',
        searchable: false,
        reasonCode: 'first_checkpoint_pending',
      },
    });
  });

  it('disconnect_marksAccountBeforeRevokingItsExactCredential', async () => {
    const existing = record();
    const { service, accounts, vault } = harness(existing);
    const response = await service.actOnConnection(TENANT_ID, ACCOUNT_ID, {
      version: 2,
      action: 'disconnect',
    });

    expect(accounts.disconnect).toHaveBeenCalledWith(
      TENANT_ID,
      ACCOUNT_ID,
      '2026-07-13T10:00:00.000Z',
    );
    expect(vault.revoke).toHaveBeenCalledWith(
      { tenantId: TENANT_ID, accountId: ACCOUNT_ID, connector: 'gmail' },
      existing.credentialRef,
    );
    expect(response.connection.state).toBe('disconnected');
  });
});

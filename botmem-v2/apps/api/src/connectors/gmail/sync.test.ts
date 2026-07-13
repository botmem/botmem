import { describe, expect, it, vi } from 'vitest';
import {
  connectorAccountId,
  syncId,
  tenantId,
  type CloseSyncCommand,
  type CommitSyncPageCommand,
  type ConnectorAccountSnapshot,
  type HostedIngestionUseCase,
  type StartSyncCommand,
} from '@botmem-v2/connector-domain';
import {
  GMAIL_READONLY_SCOPE,
  GmailFullResyncRequiredError,
  GmailProviderError,
  GmailReconnectRequiredError,
  GmailSyncService,
  type GmailApiPort,
  type GmailAuthorizationSession,
  type GmailCredentialVaultPort,
  type GmailMessage,
  type GmailRequestPolicy,
  type OAuthTokenSet,
} from './index.js';

const TENANT_ID = tenantId('10000000-0000-4000-8000-000000000001');
const ACCOUNT_ID = connectorAccountId('20000000-0000-4000-8000-000000000001');
const SYNC_ID = syncId('30000000-0000-4000-8000-000000000001');
const STARTED_AT = '2026-07-13T10:00:00.000Z';
const LEASE_EXPIRES_AT = '2026-07-13T10:30:00.000Z';
const TOKENS: OAuthTokenSet = Object.freeze({
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: '2026-07-13T11:00:00.000Z',
  grantedScopes: [GMAIL_READONLY_SCOPE],
  tokenType: 'Bearer',
});

class RecordingIngestion implements HostedIngestionUseCase {
  public readonly starts: StartSyncCommand[] = [];
  public readonly commits: CommitSyncPageCommand[] = [];
  public readonly closes: CloseSyncCommand[] = [];

  public constructor(private account: ConnectorAccountSnapshot) {}

  public async startSync(command: StartSyncCommand) {
    this.starts.push(command);
    this.account = Object.freeze({
      ...this.account,
      aggregateVersion: this.account.aggregateVersion + 1,
      activeSync: Object.freeze({
        id: command.syncId,
        startedAt: command.startedAt,
        leaseExpiresAt: command.leaseExpiresAt,
      }),
    });
    return this.account;
  }

  public async commitPage(command: CommitSyncPageCommand) {
    this.commits.push(command);
    this.account = Object.freeze({
      ...this.account,
      aggregateVersion: this.account.aggregateVersion + 1,
      cursorVersion: this.account.cursorVersion + 1,
      cursor: command.nextCursor,
    });
    return Object.freeze({
      account: this.account,
      insertedRevisionIds: [],
      duplicateRevisionCount: 0,
    });
  }

  public async closeSync(command: CloseSyncCommand) {
    this.closes.push(command);
    this.account = Object.freeze({
      ...this.account,
      aggregateVersion: this.account.aggregateVersion + 1,
      status: command.outcome === 'completed' ? 'ready' : 'degraded',
      activeSync: null,
    });
    return this.account;
  }
}

function account(cursor: ConnectorAccountSnapshot['cursor'] = {}): ConnectorAccountSnapshot {
  return Object.freeze({
    id: ACCOUNT_ID,
    tenantId: TENANT_ID,
    connector: 'gmail',
    authKind: 'oauth2',
    credentialRef: 'vault://gmail/account-1',
    status: 'ready',
    aggregateVersion: 0,
    cursorVersion: 0,
    cursor,
    activeSync: null,
  });
}

function fixtureMessage(id: string, historyId: string): GmailMessage {
  return {
    id,
    threadId: 'thread-1',
    historyId,
    internalDate: '1718447400000',
    labelIds: ['CATEGORY_PROMOTIONS', 'SPAM', 'UNREAD'],
    snippet: 'Your one-time password is 843991 — unsubscribe footer preserved',
    sizeEstimate: 3210,
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'Subject', value: 'Limited offer + OTP' },
        { name: 'From', value: 'sender@example.test' },
        { name: 'X-Custom-Provider-Header', value: 'preserve-me' },
      ],
      parts: [
        {
          partId: '0',
          mimeType: 'text/plain',
          body: { data: 'Ym9keS13aXRoLXVuc3Vic2NyaWJl', size: 21 },
        },
        {
          partId: '1',
          mimeType: 'text/html',
          body: { data: 'PHA+Ym9keTwvcD4=', size: 11 },
        },
      ],
    },
    raw: 'cmF3LWZpeHR1cmU=',
  };
}

function createApi(): GmailApiPort {
  return {
    getIdentity: vi.fn(),
    getProfile: vi.fn().mockResolvedValue({
      emailAddress: 'owner@example.test',
      historyId: 'H100',
      messagesTotal: 2,
    }),
    listMessages: vi.fn().mockResolvedValue({ messages: [], nextPageToken: null }),
    listHistory: vi.fn().mockResolvedValue({
      history: [],
      historyId: 'H100',
      nextPageToken: null,
    }),
    getMessage: vi.fn().mockResolvedValue(null),
  };
}

function createHarness(cursor: ConnectorAccountSnapshot['cursor'] = {}) {
  const ingestion = new RecordingIngestion(account(cursor));
  const api = createApi();
  const vault: GmailCredentialVaultPort = {
    store: vi.fn(),
    read: vi.fn().mockResolvedValue(TOKENS),
    rotate: vi.fn().mockResolvedValue(undefined),
    revoke: vi.fn(),
  };
  const service = new GmailSyncService(
    ingestion,
    api,
    vault,
    {
      sha256Hex: async (value) => (value.includes('tombstone') ? 'b'.repeat(64) : 'a'.repeat(64)),
    },
    { now: () => STARTED_AT },
  );
  return { service, ingestion, api, vault };
}

function run(service: GmailSyncService) {
  return service.run({
    tenantId: TENANT_ID,
    accountId: ACCOUNT_ID,
    syncId: SYNC_ID,
    credentialRef: 'vault://gmail/account-1',
    startedAt: STARTED_AT,
    leaseExpiresAt: LEASE_EXPIRES_AT,
  });
}

describe('GmailSyncService', () => {
  it('run_fullPagination_commitsEachPageWithItsCursorAndPreservesEveryMessageField', async () => {
    const { service, ingestion, api } = createHarness();
    const message1 = fixtureMessage('message-1', 'H101');
    const message2 = fixtureMessage('message-2', 'H102');
    vi.mocked(api.listMessages).mockImplementation(async (_authorization, request) =>
      request.pageToken
        ? { messages: [{ id: 'message-2' }], nextPageToken: null }
        : { messages: [{ id: 'message-1' }], nextPageToken: 'PAGE-2' },
    );
    vi.mocked(api.getMessage).mockImplementation(async (_authorization, messageId) =>
      messageId === 'message-1' ? message1 : message2,
    );

    await run(service);

    expect(api.listMessages).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.listMessages).mock.calls[0]?.[1]).toEqual({
      pageToken: null,
      maxResults: 100,
      includeSpamTrash: true,
    });
    expect(ingestion.commits).toHaveLength(2);
    expect(ingestion.commits.map((commit) => commit.expectedCursorVersion)).toEqual([0, 1]);
    expect(ingestion.commits[0]).toMatchObject({
      nextCursor: {
        connector: 'gmail',
        mode: 'full',
        pageToken: 'PAGE-2',
        anchorHistoryId: 'H100',
      },
      events: [{ sourceEventId: 'message-1', sourceRevision: 'history:H101' }],
    });
    expect(ingestion.commits[1]).toMatchObject({
      nextCursor: {
        connector: 'gmail',
        mode: 'history',
        historyId: 'H100',
        pageToken: null,
      },
      events: [{ sourceEventId: 'message-2', sourceRevision: 'history:H102' }],
    });
    expect(ingestion.commits[0]?.events[0]?.payload).toMatchObject({
      schema: 'gmail.message.v1',
      provider: message1,
      normalized: {
        sourceId: 'message-1',
        participants: expect.any(Array),
        media: expect.any(Array),
      },
    });
    expect(ingestion.closes).toEqual([
      expect.objectContaining({ outcome: 'completed', syncId: SYNC_ID }),
    ]);
  });

  it('run_historyPagination_keepsOriginalHistoryIdUntilFinalPage', async () => {
    const { service, ingestion, api } = createHarness({
      connector: 'gmail',
      version: 1,
      mode: 'history',
      historyId: 'H100',
      pageToken: null,
      targetHistoryId: null,
    });
    vi.mocked(api.listHistory).mockImplementation(async (_authorization, request) =>
      request.pageToken
        ? {
            history: [{ id: 'H112', messagesAdded: [{ message: { id: 'message-2' } }] }],
            historyId: 'H120',
            nextPageToken: null,
          }
        : {
            history: [{ id: 'H111', labelsAdded: [{ message: { id: 'message-1' } }] }],
            historyId: 'H110',
            nextPageToken: 'HISTORY-PAGE-2',
          },
    );
    vi.mocked(api.getMessage).mockImplementation(async (_authorization, messageId) =>
      fixtureMessage(messageId, messageId === 'message-1' ? 'H111' : 'H112'),
    );

    await run(service);

    expect(vi.mocked(api.listHistory).mock.calls.map((call) => call[1])).toEqual([
      { startHistoryId: 'H100', pageToken: null, maxResults: 100 },
      { startHistoryId: 'H100', pageToken: 'HISTORY-PAGE-2', maxResults: 100 },
    ]);
    expect(ingestion.commits[0]?.nextCursor).toMatchObject({
      historyId: 'H100',
      pageToken: 'HISTORY-PAGE-2',
      targetHistoryId: 'H110',
    });
    expect(ingestion.commits[1]?.nextCursor).toEqual({
      connector: 'gmail',
      version: 1,
      mode: 'history',
      historyId: 'H120',
      pageToken: null,
      targetHistoryId: null,
    });
  });

  it('run_whenHistoryExpired_emitsExplicitFullResyncSignalWithoutCursorCommit', async () => {
    const { service, ingestion, api } = createHarness({
      connector: 'gmail',
      version: 1,
      mode: 'history',
      historyId: 'expired-history',
      pageToken: null,
      targetHistoryId: null,
    });
    vi.mocked(api.listHistory).mockRejectedValue(new GmailProviderError('history_expired', 404));

    await expect(run(service)).rejects.toBeInstanceOf(GmailFullResyncRequiredError);
    expect(ingestion.commits).toHaveLength(0);
    expect(ingestion.closes[0]).toMatchObject({
      outcome: 'failed',
      reasonCode: 'GMAIL_FULL_RESYNC_REQUIRED',
    });
  });

  it('run_whenRefreshTokenRevoked_requiresReconnectWithoutPartialCommit', async () => {
    const { service, ingestion, api } = createHarness();
    vi.mocked(api.getProfile).mockRejectedValue(new GmailProviderError('revoked', 401));

    await expect(run(service)).rejects.toBeInstanceOf(GmailReconnectRequiredError);
    expect(ingestion.commits).toHaveLength(0);
    expect(ingestion.closes[0]).toMatchObject({
      outcome: 'failed',
      reasonCode: 'GMAIL_AUTH_REVOKED',
    });
  });

  it('run_whenProviderRotatesToken_persistsRotationBeforeContinuing', async () => {
    const { service, api, vault } = createHarness();
    const rotated: OAuthTokenSet = { ...TOKENS, accessToken: 'access-2' };
    vi.mocked(api.getProfile).mockImplementation(
      async (authorization: GmailAuthorizationSession, _policy: GmailRequestPolicy) => {
        await authorization.onTokenRotation(rotated);
        return { emailAddress: 'owner@example.test', historyId: 'H100', messagesTotal: 0 };
      },
    );
    vi.mocked(api.listMessages).mockImplementation(async (authorization) => {
      expect(authorization.getTokens().accessToken).toBe('access-2');
      return { messages: [], nextPageToken: null };
    });

    await run(service);

    expect(vault.rotate).toHaveBeenCalledWith(
      { tenantId: TENANT_ID, accountId: ACCOUNT_ID },
      'vault://gmail/account-1',
      rotated,
    );
    expect(vault.rotate).toHaveBeenCalledBefore(vi.mocked(api.listMessages));
  });

  it('run_whenVaultReadFails_closesTheClaimedSyncWithoutCommitting', async () => {
    const { service, ingestion, vault } = createHarness();
    vi.mocked(vault.read).mockRejectedValue(new Error('vault unavailable'));

    await expect(run(service)).rejects.toMatchObject({ code: 'GMAIL_SYNC_FAILED' });
    expect(ingestion.commits).toHaveLength(0);
    expect(ingestion.closes[0]).toMatchObject({
      outcome: 'failed',
      reasonCode: 'GMAIL_SYNC_FAILED',
    });
  });

  it('run_whenEveryBoundedRepresentationIsOversized_doesNotAdvanceOrInventADeletion', async () => {
    const { service, ingestion, api } = createHarness();
    vi.mocked(api.listMessages).mockResolvedValue({
      messages: [{ id: 'message-too-large' }],
      nextPageToken: null,
    });
    vi.mocked(api.getMessage).mockRejectedValue(
      new GmailProviderError('response_too_large', 200),
    );

    await expect(run(service)).rejects.toMatchObject({ code: 'GMAIL_PROVIDER_UNAVAILABLE' });

    expect(ingestion.commits).toHaveLength(0);
    expect(ingestion.closes[0]).toMatchObject({
      outcome: 'failed',
      reasonCode: 'GMAIL_PROVIDER_UNAVAILABLE',
    });
  });
});

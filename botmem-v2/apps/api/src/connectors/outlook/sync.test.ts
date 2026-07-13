import { createHash } from 'node:crypto';
import {
  connectorAccountId,
  syncId,
  tenantId,
  type CloseSyncCommand,
  type CommitSyncPageCommand,
  type ConnectorAccountSnapshot,
  type HostedIngestionUseCase,
  type JsonValue,
  type StartSyncCommand,
} from '@botmem-v2/connector-domain';
import { describe, expect, it, vi } from 'vitest';
import {
  OUTLOOK_SCOPES,
  OutlookFullResyncRequiredError,
  OutlookInvalidCursorError,
  OutlookPageLimitError,
  OutlookProviderError,
  OutlookSyncService,
  mapOutlookMessage,
  type OutlookAuthorizationSession,
  type OutlookCredentialVaultPort,
  type OutlookDeltaPage,
  type OutlookGraphApiPort,
  type OutlookMessage,
  type OutlookOAuthTokenSet,
} from './index.js';

const TENANT_ID = tenantId('10000000-0000-4000-8000-000000000001');
const ACCOUNT_ID = connectorAccountId('20000000-0000-4000-8000-000000000001');
const SYNC_ID = syncId('30000000-0000-4000-8000-000000000001');
const STARTED_AT = '2026-07-13T10:00:00.000Z';
const LEASE_EXPIRES_AT = '2026-07-13T10:30:00.000Z';
const NEXT_LINK =
  'https://graph.microsoft.com/v1.0/me/mailFolders/folder-1/messages/delta?$skiptoken=next';
const DELTA_LINK =
  'https://graph.microsoft.com/v1.0/me/mailFolders/folder-1/messages/delta?$deltatoken=delta';
const FOLDER_ID = 'folder-1';
const TOKENS: OutlookOAuthTokenSet = Object.freeze({
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: '2026-07-13T11:00:00.000Z',
  grantedScopes: OUTLOOK_SCOPES,
  tokenType: 'Bearer',
});

class RecordingIngestion implements HostedIngestionUseCase {
  public readonly starts: StartSyncCommand[] = [];
  public readonly commits: CommitSyncPageCommand[] = [];
  public readonly closes: CloseSyncCommand[] = [];
  public commitAttempts = 0;
  public failCommit = false;

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
    this.commitAttempts += 1;
    if (this.failCommit) throw new Error('simulated atomic database rollback');
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
    connector: 'outlook',
    authKind: 'oauth2',
    providerSubjectHash: 'a'.repeat(64),
    credentialRef: 'vault://outlook/account-1',
    status: 'ready',
    aggregateVersion: 0,
    cursorVersion: 0,
    cursor,
    activeSync: null,
  });
}

function message(id: string, changeKey: string): OutlookMessage {
  return {
    id,
    changeKey,
    lastModifiedDateTime: '2026-07-13T09:50:00.000Z',
    receivedDateTime: '2026-07-13T09:45:00.000Z',
    subject: 'Promotion OTP unsubscribe words remain ingested',
    bodyPreview: 'Complete body preview',
    body: { contentType: 'text', content: 'Full body text' },
    from: { emailAddress: { name: 'Sender', address: 'Sender@Example.test' } },
    toRecipients: [
      { emailAddress: { name: 'Owner', address: 'owner@example.test' } },
      { emailAddress: { name: 'Name Only', address: null } },
    ],
    ccRecipients: [{ emailAddress: { name: 'CC', address: 'cc@example.test' } }],
    conversationId: 'conversation-7',
    conversationIndex: 'index-7',
    hasAttachments: true,
    attachments: [
      {
        id: 'attachment-1',
        name: 'invoice.pdf',
        contentType: 'application/pdf',
        size: 321,
      },
    ],
    categories: ['Inbox'],
  };
}

function createGraph(): OutlookGraphApiPort {
  return {
    getProfile: vi.fn(),
    discoverMailFolders: vi.fn().mockResolvedValue([{ id: FOLDER_ID, childFolderCount: 0 }]),
    listMessageDelta: vi.fn().mockResolvedValue({
      messages: [],
      nextLink: null,
      deltaLink: DELTA_LINK,
    }),
  };
}

const crypto = {
  sha256Hex: async (value: string) => createHash('sha256').update(value).digest('hex'),
};

function createHarness(cursor: ConnectorAccountSnapshot['cursor'] = {}) {
  const ingestion = new RecordingIngestion(account(cursor));
  const graph = createGraph();
  const vault: OutlookCredentialVaultPort = {
    store: vi.fn(),
    read: vi.fn().mockResolvedValue(TOKENS),
    rotate: vi.fn().mockResolvedValue(undefined),
    revoke: vi.fn(),
  };
  const service = new OutlookSyncService(ingestion, graph, vault, crypto, {
    now: () => STARTED_AT,
  });
  return { service, ingestion, graph, vault };
}

function run(service: OutlookSyncService) {
  return service.run({
    tenantId: TENANT_ID,
    accountId: ACCOUNT_ID,
    syncId: SYNC_ID,
    credentialRef: 'vault://outlook/account-1',
    startedAt: STARTED_AT,
    leaseExpiresAt: LEASE_EXPIRES_AT,
  });
}

describe('OutlookSyncService', () => {
  it('run_deltaPagination_commitsEachCompletePageAndPreservesMappingFields', async () => {
    const { service, ingestion, graph } = createHarness();
    vi.mocked(graph.listMessageDelta).mockImplementation(
      async (_authorization, _folderId, cursorLink) => {
        if (cursorLink === null) {
          return {
            messages: [message('message-1', 'change-1')],
            nextLink: NEXT_LINK,
            deltaLink: null,
          };
        }
        return {
          messages: [message('message-2', 'change-2')],
          nextLink: null,
          deltaLink: DELTA_LINK,
        };
      },
    );

    await run(service);

    expect(vi.mocked(graph.listMessageDelta).mock.calls.map((call) => call[2])).toEqual([
      null,
      NEXT_LINK,
    ]);
    expect(ingestion.commits).toHaveLength(2);
    expect(ingestion.commits.map((commit) => commit.expectedCursorVersion)).toEqual([0, 1]);
    expect(ingestion.commits[0]).toMatchObject({
      nextCursor: {
        connector: 'outlook',
        version: 1,
        folders: [{ folderId: FOLDER_ID, kind: 'next', link: NEXT_LINK }],
      },
      events: [{ sourceEventId: 'message-1', sourceRevision: 'changeKey:change-1' }],
    });
    expect(ingestion.commits[1]).toMatchObject({
      nextCursor: {
        connector: 'outlook',
        version: 1,
        folders: [{ folderId: FOLDER_ID, kind: 'delta', link: DELTA_LINK }],
      },
      events: [{ sourceEventId: 'message-2', sourceRevision: 'changeKey:change-2' }],
    });
    const payload = ingestion.commits[0]?.events[0]?.payload as {
      readonly schema: string;
      readonly provider: JsonValue;
      readonly normalized: {
        readonly thread: { readonly durableId: string };
        readonly participants: readonly { readonly durableId: string }[];
        readonly media: readonly { readonly durableId: string; readonly availability: string }[];
      };
    };
    expect(payload.schema).toBe('outlook.message.v1');
    expect(payload.provider).toMatchObject({
      categories: ['Inbox'],
      body: { content: 'Full body text' },
    });
    expect(payload.normalized.thread.durableId).toBe('outlook-conversation:conversation-7');
    expect(payload.normalized.participants.map((participant) => participant.durableId)).toEqual([
      'email:sender@example.test',
      'email:owner@example.test',
      'email:cc@example.test',
    ]);
    expect(payload.normalized.media).toEqual([
      expect.objectContaining({
        durableId: 'message-1:attachment:attachment-1',
        availability: 'hosted',
      }),
    ]);
    expect(ingestion.closes).toEqual([expect.objectContaining({ outcome: 'completed' })]);
  });

  it('run_existingDelta_usesOpaqueStoredLinkAndHandlesDeletionRevision', async () => {
    const { service, ingestion, graph } = createHarness({
      connector: 'outlook',
      version: 1,
      folders: [{ folderId: FOLDER_ID, kind: 'delta', link: DELTA_LINK }],
    });
    vi.mocked(graph.listMessageDelta).mockResolvedValue({
      messages: [{ id: 'deleted-1', '@removed': { reason: 'deleted' } }],
      nextLink: null,
      deltaLink: `${DELTA_LINK}-2`,
    });

    await run(service);

    expect(graph.listMessageDelta).toHaveBeenCalledWith(
      expect.anything(),
      FOLDER_ID,
      DELTA_LINK,
      expect.anything(),
    );
    expect(ingestion.commits[0]?.events[0]).toMatchObject({
      sourceEventId: 'deleted-1',
      sourceRevision: expect.stringMatching(/^removed:sha256:[0-9a-f]{64}$/),
      tombstone: true,
    });
  });

  it('run_multipleDiscoveredFolders_tracksEveryFolderIndependently', async () => {
    const { service, ingestion, graph } = createHarness();
    vi.mocked(graph.discoverMailFolders).mockResolvedValue([
      { id: 'folder-z', childFolderCount: 0 },
      { id: 'folder-a', childFolderCount: 1 },
    ]);
    vi.mocked(graph.listMessageDelta).mockImplementation(async (_authorization, folderId) => ({
      messages: [],
      nextLink: null,
      deltaLink: `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages/delta?$deltatoken=${folderId}`,
    }));

    await run(service);

    expect(vi.mocked(graph.listMessageDelta).mock.calls.map((call) => call[1])).toEqual([
      'folder-a',
      'folder-z',
    ]);
    expect(ingestion.commits.at(-1)?.nextCursor).toEqual({
      connector: 'outlook',
      version: 1,
      folders: [
        expect.objectContaining({ folderId: 'folder-a', kind: 'delta' }),
        expect.objectContaining({ folderId: 'folder-z', kind: 'delta' }),
      ],
    });
  });

  it('run_whenDeltaIsInvalid_requiresExplicitFullResyncWithoutAdvancingCursor', async () => {
    const { service, ingestion, graph } = createHarness({
      connector: 'outlook',
      version: 1,
      folders: [{ folderId: FOLDER_ID, kind: 'delta', link: DELTA_LINK }],
    });
    vi.mocked(graph.listMessageDelta).mockRejectedValue(
      new OutlookProviderError('invalid_delta', 410),
    );

    await expect(run(service)).rejects.toBeInstanceOf(OutlookFullResyncRequiredError);
    expect(ingestion.commits).toHaveLength(0);
    expect(ingestion.closes[0]).toMatchObject({
      outcome: 'failed',
      reasonCode: 'OUTLOOK_FULL_RESYNC_REQUIRED',
    });
  });

  it('run_whenCursorIsMalformed_failsBeforeAnyProviderReadOrCommit', async () => {
    const { service, ingestion, graph } = createHarness({
      connector: 'outlook',
      version: 1,
      folders: [
        { folderId: FOLDER_ID, kind: 'delta', link: DELTA_LINK },
        { folderId: FOLDER_ID, kind: 'delta', link: `${DELTA_LINK}-duplicate` },
      ],
    });

    await expect(run(service)).rejects.toBeInstanceOf(OutlookInvalidCursorError);
    expect(graph.discoverMailFolders).not.toHaveBeenCalled();
    expect(graph.listMessageDelta).not.toHaveBeenCalled();
    expect(ingestion.commits).toHaveLength(0);
  });

  it('run_whenProviderRotatesToken_persistsRotationBeforeContinuing', async () => {
    const { service, graph, vault } = createHarness();
    const rotated: OutlookOAuthTokenSet = { ...TOKENS, accessToken: 'access-2' };
    vi.mocked(graph.listMessageDelta).mockImplementation(
      async (authorization: OutlookAuthorizationSession): Promise<OutlookDeltaPage> => {
        await authorization.onTokenRotation(rotated);
        expect(vault.rotate).toHaveBeenCalledWith(
          { tenantId: TENANT_ID, accountId: ACCOUNT_ID },
          'vault://outlook/account-1',
          rotated,
        );
        expect(authorization.getTokens().accessToken).toBe('access-2');
        return { messages: [], nextLink: null, deltaLink: DELTA_LINK };
      },
    );

    await run(service);
    expect(vault.rotate).toHaveBeenCalledOnce();
  });

  it('run_whenAtomicCommitFails_doesNotRecordEventsOrAdvanceCursor', async () => {
    const { service, ingestion, graph } = createHarness();
    ingestion.failCommit = true;
    vi.mocked(graph.listMessageDelta).mockResolvedValue({
      messages: [message('message-1', 'change-1')],
      nextLink: null,
      deltaLink: DELTA_LINK,
    });

    await expect(run(service)).rejects.toMatchObject({ code: 'OUTLOOK_SYNC_FAILED' });
    expect(ingestion.commitAttempts).toBe(1);
    expect(ingestion.commits).toHaveLength(0);
    expect(ingestion.closes[0]).toMatchObject({ outcome: 'failed' });
  });

  it('run_whenProviderRepeatsNextLink_stopsCycleBeforeDuplicatePageCommit', async () => {
    const { service, ingestion, graph } = createHarness();
    vi.mocked(graph.listMessageDelta).mockImplementation(
      async (_authorization, _folderId, cursorLink) => ({
        messages: [message(cursorLink ? 'message-2' : 'message-1', 'change-1')],
        nextLink: NEXT_LINK,
        deltaLink: null,
      }),
    );

    await expect(run(service)).rejects.toBeInstanceOf(OutlookPageLimitError);
    expect(ingestion.commits).toHaveLength(1);
    expect(ingestion.closes[0]).toMatchObject({
      outcome: 'failed',
      reasonCode: 'OUTLOOK_PAGE_LIMIT_EXCEEDED',
    });
  });
});

describe('mapOutlookMessage', () => {
  it('sameProviderRevision_mapsDeterministicallyWithoutCreatingNameOnlyPeople', async () => {
    const fixture = message('message-stable', 'change-stable');
    const first = await mapOutlookMessage(fixture, crypto);
    const second = await mapOutlookMessage(structuredClone(fixture), crypto);

    expect(second).toEqual(first);
    expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.sourceRevision).toBe('changeKey:change-stable');
    expect(JSON.stringify(first.payload)).not.toContain('email:name only');
  });
});

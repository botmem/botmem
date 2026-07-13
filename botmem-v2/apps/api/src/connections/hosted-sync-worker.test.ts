import {
  connectorAccountId,
  syncId,
  tenantId,
  type ConnectorAccountSnapshot,
  type HostedIngestionUnitOfWork,
  type IngestionIdFactory,
} from '@botmem-v2/connector-domain';
import { describe, expect, it, vi } from 'vitest';
import {
  GMAIL_OAUTH_SCOPE,
  GmailProviderError,
  type GmailApiPort,
  type GmailCredentialVaultPort,
} from '../connectors/gmail/index.js';
import type {
  OutlookCredentialVaultPort,
  OutlookGraphApiPort,
} from '../connectors/outlook/index.js';
import type {
  OwnTracksCredentialVaultPort,
  OwnTracksLocationApiPort,
} from '../connectors/owntracks/index.js';
import {
  HostedSyncWorker,
  type HostedSyncJobClaim,
  type HostedSyncWorkerJobStore,
  type HostedSyncTelemetryEvent,
} from './index.js';

const TENANT_ID = tenantId('10000000-0000-4000-8000-000000000001');
const ACCOUNT_ID = connectorAccountId('20000000-0000-4000-8000-000000000001');
const LEASE_TOKEN = syncId('30000000-0000-4000-8000-000000000001');
const CLAIM: HostedSyncJobClaim = {
  jobId: '40000000-0000-4000-8000-000000000001',
  tenantId: TENANT_ID,
  accountId: ACCOUNT_ID,
  connector: 'gmail',
  attempt: 1,
  leaseToken: LEASE_TOKEN,
  leaseExpiresAt: '2026-07-13T10:10:00.000Z',
};

class MemoryIngestion implements HostedIngestionUnitOfWork {
  snapshot: ConnectorAccountSnapshot = {
    id: ACCOUNT_ID,
    tenantId: TENANT_ID,
    connector: 'gmail',
    authKind: 'oauth2',
    providerSubjectHash: 'a'.repeat(64),
    credentialRef: 'vault:v1:50000000-0000-4000-8000-000000000001',
    status: 'ready',
    aggregateVersion: 0,
    cursorVersion: 0,
    cursor: {},
    activeSync: null,
  };
  readonly commitPage = vi.fn(async (commit) => {
    this.snapshot = {
      ...this.snapshot,
      aggregateVersion: this.snapshot.aggregateVersion + 1,
      cursorVersion: this.snapshot.cursorVersion + 1,
      cursor: commit.nextCursor,
    };
    return { account: this.snapshot, insertedRevisionIds: [], duplicateRevisionCount: 0 };
  });

  async loadAccount() {
    return this.snapshot;
  }
  async claimSync(claim: Parameters<HostedIngestionUnitOfWork['claimSync']>[0]) {
    this.snapshot = {
      ...this.snapshot,
      aggregateVersion: this.snapshot.aggregateVersion + 1,
      activeSync: claim.sync,
    };
    return this.snapshot;
  }
  async closeSync(close: Parameters<HostedIngestionUnitOfWork['closeSync']>[0]) {
    this.snapshot = {
      ...this.snapshot,
      aggregateVersion: this.snapshot.aggregateVersion + 1,
      status: close.outcome === 'completed' ? 'ready' : 'degraded',
      activeSync: null,
    };
    return this.snapshot;
  }
}

function harness(providerFailure?: Error) {
  const jobs: HostedSyncWorkerJobStore = {
    claim: vi.fn().mockResolvedValue(CLAIM),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    heartbeat: vi.fn().mockResolvedValue(undefined),
  };
  const ingestion = new MemoryIngestion();
  const gmail: GmailApiPort = {
    getIdentity: vi.fn(),
    getProfile: vi.fn().mockResolvedValue({
      emailAddress: 'owner@example.test',
      historyId: 'history-1',
      messagesTotal: 0,
    }),
    listMessages: providerFailure
      ? vi.fn().mockRejectedValue(providerFailure)
      : vi.fn().mockResolvedValue({ messages: [], nextPageToken: null }),
    listHistory: vi.fn(),
    getMessage: vi.fn(),
  };
  const gmailVault: GmailCredentialVaultPort = {
    store: vi.fn(),
    read: vi.fn().mockResolvedValue({
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      expiresAt: '2026-07-13T11:00:00.000Z',
      grantedScopes: GMAIL_OAUTH_SCOPE.split(' '),
      tokenType: 'Bearer',
    }),
    rotate: vi.fn(),
    revoke: vi.fn(),
  };
  const outlook = {
    getProfile: vi.fn(),
    discoverMailFolders: vi.fn(),
    listMessageDelta: vi.fn(),
  } as OutlookGraphApiPort;
  const outlookVault = {
    store: vi.fn(),
    read: vi.fn(),
    rotate: vi.fn(),
    revoke: vi.fn(),
  } as OutlookCredentialVaultPort;
  const owntracks = { listLocations: vi.fn() } as OwnTracksLocationApiPort;
  const ownTracksVault = { read: vi.fn(), revoke: vi.fn() } as OwnTracksCredentialVaultPort;
  const events: HostedSyncTelemetryEvent[] = [];
  const worker = new HostedSyncWorker({
    jobs,
    ingestionUnitOfWork: ingestion,
    ids: {
      nextRevisionId: vi.fn(),
      nextOutboxMessageId: vi.fn(),
    } as IngestionIdFactory,
    accountConfig: { readConnectionConfig: vi.fn() },
    gmail,
    gmailVault,
    outlook,
    outlookVault,
    owntracks,
    ownTracksVault,
    crypto: { sha256Hex: vi.fn().mockResolvedValue('b'.repeat(64)) },
    ownTracksHash: { sha256Hex: vi.fn().mockResolvedValue('c'.repeat(64)) },
    clock: { now: () => '2026-07-13T10:00:00.000Z' },
    telemetry: { record: (event) => events.push(event) },
    policy: {
      workerId: 'worker.test',
      maxRunMs: 5_000,
      leaseMs: 10_000,
      maxAttempts: 5,
      pollMs: 50,
      heartbeatMs: 1_000,
      retryBaseMs: 100,
      retryMaxMs: 1_000,
    },
  });
  return { worker, jobs, ingestion, events };
}

describe('HostedSyncWorker', () => {
  it('runForever_whenShutdownIsRequested_exitsCleanly', async () => {
    const { worker, jobs } = harness();
    vi.mocked(jobs.claim).mockResolvedValue(null);
    const shutdown = new AbortController();

    const running = worker.runForever(shutdown.signal);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    shutdown.abort('test shutdown');

    await expect(running).resolves.toBeUndefined();
  });

  it('successfulPage_advancesCheckpointThenCompletesDurableJob', async () => {
    const { worker, jobs, ingestion, events } = harness();

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(ingestion.commitPage).toHaveBeenCalledOnce();
    expect(jobs.complete).toHaveBeenCalledWith(CLAIM, '2026-07-13T10:00:00.000Z');
    expect(jobs.fail).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ event: 'job_succeeded', connector: 'gmail' });
  });

  it('providerFailure_doesNotAdvanceCheckpointAndSchedulesRedactedRetry', async () => {
    const { worker, jobs, ingestion, events } = harness(new GmailProviderError('unavailable', 503));

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(ingestion.commitPage).not.toHaveBeenCalled();
    expect(jobs.complete).not.toHaveBeenCalled();
    expect(jobs.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        claim: CLAIM,
        failureCode: 'GMAIL_PROVIDER_UNAVAILABLE',
        retryable: true,
      }),
    );
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('access-secret');
    expect(serialized).not.toContain('refresh-secret');
    expect(serialized).not.toContain(TENANT_ID);
    expect(events.at(-1)).toMatchObject({
      event: 'job_failed',
      failureCode: 'GMAIL_PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });
});

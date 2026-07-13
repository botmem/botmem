import { connectorAccountId, tenantId } from '@botmem-v2/connector-domain';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { GMAIL_OAUTH_SCOPE, type GmailApiPort } from '../connectors/gmail/index.js';
import type { OutlookGraphApiPort } from '../connectors/outlook/index.js';
import type { OwnTracksLocationApiPort } from '../connectors/owntracks/index.js';
import { NodeIngestionIdFactory, PostgresHostedIngestionUnitOfWork } from '../ingestion/index.js';
import { NodePostgresPoolAdapter } from '../search/node-postgres.js';
import {
  DeploymentKeyRing,
  GmailCredentialVaultAdapter,
  HostedSyncWorker,
  OutlookCredentialVaultAdapter,
  OwnTracksCredentialVaultAdapter,
  PostgresConnectionAccountRepository,
  PostgresConnectorCredentialVault,
  PostgresHostedSyncAccountConfigReader,
  PostgresHostedSyncScheduler,
  PostgresHostedSyncWorkerJobStore,
} from './index.js';

const API_DATABASE_URL = process.env['BOTMEM_TEST_API_DATABASE_URL'];
const WORKER_DATABASE_URL = process.env['BOTMEM_TEST_WORKER_DATABASE_URL'];
const enabled = Boolean(API_DATABASE_URL && WORKER_DATABASE_URL);

describe.skipIf(!enabled)('durable hosted sync runtime real PostgreSQL', () => {
  const apiPool = new NodePostgresPoolAdapter({ connectionString: API_DATABASE_URL! });
  const workerPool = new NodePostgresPoolAdapter({ connectionString: WORKER_DATABASE_URL! });
  const now = () => new Date().toISOString();
  const scheduler = new PostgresHostedSyncScheduler(apiPool, 45, now);
  const jobs = new PostgresHostedSyncWorkerJobStore(workerPool);
  const tenant = tenantId('18000000-0000-4000-8000-000000000001');
  const accountId = connectorAccountId('28000000-0000-4000-8000-000000000001');
  const owner = { tenantId: tenant, accountId, connector: 'gmail' as const };
  const keyRing = new DeploymentKeyRing([{ version: 1, key: new Uint8Array(32).fill(8) }]);
  const apiVault = new PostgresConnectorCredentialVault(apiPool, keyRing, 'botmem_api', now);
  const workerVault = new PostgresConnectorCredentialVault(
    workerPool,
    keyRing,
    'botmem_worker',
    now,
  );
  const ingestion = new PostgresHostedIngestionUnitOfWork(workerPool);

  afterAll(async () => {
    await Promise.all([apiPool.close(), workerPool.close()]);
  });

  it('uses mutually exclusive API and worker database identities', async () => {
    const api = await apiPool.connect();
    const worker = await workerPool.connect();
    try {
      const apiRoles = await api.query<{
        readonly api: boolean;
        readonly worker: boolean;
      }>({
        text: `SELECT pg_has_role(current_user, 'botmem_api', 'member') AS api,
                     pg_has_role(current_user, 'botmem_worker', 'member') AS worker`,
      });
      const workerRoles = await worker.query<{
        readonly api: boolean;
        readonly worker: boolean;
      }>({
        text: `SELECT pg_has_role(current_user, 'botmem_api', 'member') AS api,
                     pg_has_role(current_user, 'botmem_worker', 'member') AS worker`,
      });
      expect(apiRoles.rows[0]).toEqual({ api: true, worker: false });
      expect(workerRoles.rows[0]).toEqual({ api: false, worker: true });
    } finally {
      api.release();
      worker.release();
    }
  });

  it('coalescesRequestsRecoversFollowUpAndCommitsProviderCheckpointBeforeCompletingJob', async () => {
    const credentialRef = await apiVault.store(owner, {
      kind: 'gmail_oauth',
      value: {
        accessToken: 'integration-access-secret',
        refreshToken: 'integration-refresh-secret',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        grantedScopes: GMAIL_OAUTH_SCOPE.split(' '),
        tokenType: 'Bearer',
      },
    });
    await new PostgresConnectionAccountRepository(apiPool).completeConnection({
      ...owner,
      authKind: 'oauth2',
      providerSubjectHash: '8'.repeat(64),
      credentialRef,
      displayLabel: 'integration@example.test',
      connectionConfig: {},
      initialCursor: {},
      connectedAt: now(),
    });

    await scheduler.enqueue(owner);
    await scheduler.enqueue(owner);
    const first = await jobs.claim({
      workerId: 'worker.integration',
      now: now(),
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxAttempts: 5,
    });
    expect(first).not.toBeNull();
    await scheduler.enqueue(owner);
    await jobs.complete(first!, now());
    const followUp = await jobs.claim({
      workerId: 'worker.integration',
      now: now(),
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxAttempts: 5,
    });
    expect(followUp).not.toBeNull();
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    await jobs.fail({
      claim: followUp!,
      failedAt: now(),
      failureCode: 'INTEGRATION_RETRY',
      retryable: true,
      retryAt,
      maxAttempts: 5,
    });
    await expect(
      jobs.claim({
        workerId: 'worker.integration',
        now: now(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        maxAttempts: 5,
      }),
    ).resolves.toBeNull();
    const retried = await jobs.claim({
      workerId: 'worker.integration',
      now: retryAt,
      leaseExpiresAt: new Date(Date.parse(retryAt) + 60_000).toISOString(),
      maxAttempts: 5,
    });
    expect(retried?.attempt).toBe(2);
    await jobs.cancel(retried!, retryAt, 'INTEGRATION_RESET');
    await scheduler.enqueue(owner);
    const beforeSync = await ingestion.loadAccount(tenant, accountId);
    expect(beforeSync).not.toBeNull();

    const gmail: GmailApiPort = {
      getIdentity: vi.fn(),
      getProfile: vi.fn().mockResolvedValue({
        emailAddress: 'integration@example.test',
        historyId: 'history-integration',
        messagesTotal: 0,
      }),
      listMessages: vi.fn().mockResolvedValue({ messages: [], nextPageToken: null }),
      listHistory: vi.fn(),
      getMessage: vi.fn(),
    };
    const worker = new HostedSyncWorker({
      jobs,
      ingestionUnitOfWork: ingestion,
      ids: new NodeIngestionIdFactory(),
      accountConfig: new PostgresHostedSyncAccountConfigReader(workerPool),
      gmail,
      gmailVault: new GmailCredentialVaultAdapter(workerVault),
      outlook: {
        getProfile: vi.fn(),
        discoverMailFolders: vi.fn(),
        listMessageDelta: vi.fn(),
      } as OutlookGraphApiPort,
      outlookVault: new OutlookCredentialVaultAdapter(workerVault),
      owntracks: { listLocations: vi.fn() } as OwnTracksLocationApiPort,
      ownTracksVault: new OwnTracksCredentialVaultAdapter(workerVault),
      crypto: { sha256Hex: vi.fn().mockResolvedValue('9'.repeat(64)) },
      ownTracksHash: { sha256Hex: vi.fn().mockResolvedValue('a'.repeat(64)) },
      clock: { now },
      telemetry: { record: vi.fn() },
      policy: {
        workerId: 'worker.integration',
        maxRunMs: 30_000,
        leaseMs: 60_000,
        maxAttempts: 5,
        pollMs: 50,
        heartbeatMs: 1_000,
        retryBaseMs: 100,
        retryMaxMs: 1_000,
      },
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    const account = await ingestion.loadAccount(tenant, accountId);
    expect(account).toMatchObject({
      status: 'ready',
      activeSync: null,
      cursor: {
        connector: 'gmail',
        version: 1,
        mode: 'history',
        historyId: 'history-integration',
        pageToken: null,
        targetHistoryId: null,
      },
    });
    expect(account?.cursorVersion).toBe(beforeSync!.cursorVersion + 1);
    await expect(scheduler.isReady()).resolves.toBe(true);
    await expect(
      jobs.claim({
        workerId: 'worker.integration',
        now: now(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        maxAttempts: 5,
      }),
    ).resolves.toBeNull();

    const dueAtMs = Date.now() + 24 * 60 * 60_000;
    const dueAt = new Date(dueAtMs).toISOString();
    const concurrentClaims = await Promise.all([
      jobs.claim({
        workerId: 'worker.periodic-a',
        now: dueAt,
        leaseExpiresAt: new Date(dueAtMs + 60_000).toISOString(),
        maxAttempts: 5,
      }),
      jobs.claim({
        workerId: 'worker.periodic-b',
        now: dueAt,
        leaseExpiresAt: new Date(dueAtMs + 60_000).toISOString(),
        maxAttempts: 5,
      }),
    ]);
    const scheduled = concurrentClaims.filter((claim) => claim !== null);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.attempt).toBe(1);

    await expect(
      jobs.claim({
        workerId: 'worker.before-expiry',
        now: new Date(dueAtMs + 59_000).toISOString(),
        leaseExpiresAt: new Date(dueAtMs + 119_000).toISOString(),
        maxAttempts: 5,
      }),
    ).resolves.toBeNull();
    const recovered = await jobs.claim({
      workerId: 'worker.after-crash',
      now: new Date(dueAtMs + 61_000).toISOString(),
      leaseExpiresAt: new Date(dueAtMs + 121_000).toISOString(),
      maxAttempts: 5,
    });
    expect(recovered?.attempt).toBe(2);

    const periodicRetryAtMs = dueAtMs + 181_000;
    await jobs.fail({
      claim: recovered!,
      failedAt: new Date(dueAtMs + 61_000).toISOString(),
      failureCode: 'PERIODIC_RETRY',
      retryable: true,
      retryAt: new Date(periodicRetryAtMs).toISOString(),
      maxAttempts: 5,
    });
    await expect(
      jobs.claim({
        workerId: 'worker.retry-early',
        now: new Date(periodicRetryAtMs - 1).toISOString(),
        leaseExpiresAt: new Date(periodicRetryAtMs + 60_000).toISOString(),
        maxAttempts: 5,
      }),
    ).resolves.toBeNull();
    const periodicRetry = await jobs.claim({
      workerId: 'worker.retry-due',
      now: new Date(periodicRetryAtMs).toISOString(),
      leaseExpiresAt: new Date(periodicRetryAtMs + 60_000).toISOString(),
      maxAttempts: 5,
    });
    expect(periodicRetry?.attempt).toBe(3);
    await jobs.complete(periodicRetry!, new Date(periodicRetryAtMs + 1_000).toISOString());
    await expect(
      jobs.claim({
        workerId: 'worker.not-due-again',
        now: new Date(periodicRetryAtMs + 2_000).toISOString(),
        leaseExpiresAt: new Date(periodicRetryAtMs + 62_000).toISOString(),
        maxAttempts: 5,
      }),
    ).resolves.toBeNull();

    await scheduler.enqueue(owner);
    const manual = await jobs.claim({
      workerId: 'worker.manual',
      now: now(),
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxAttempts: 5,
    });
    expect(manual?.attempt).toBe(1);

    const recoveryJobs = new PostgresHostedSyncWorkerJobStore(
      workerPool,
      {
        gmail: 300_000,
        outlook: 300_000,
        owntracks: 300_000,
      },
      900_000,
    );
    const shortRetryAtMs = Date.now() + 1_000;
    await recoveryJobs.fail({
      claim: manual!,
      failedAt: now(),
      failureCode: 'GMAIL_PROVIDER_UNAVAILABLE',
      retryable: true,
      retryAt: new Date(shortRetryAtMs).toISOString(),
      maxAttempts: 2,
    });
    const finalShortRetry = await recoveryJobs.claim({
      workerId: 'worker.exhaust-short-retries',
      now: new Date(shortRetryAtMs).toISOString(),
      leaseExpiresAt: new Date(shortRetryAtMs + 60_000).toISOString(),
      maxAttempts: 2,
    });
    expect(finalShortRetry?.attempt).toBe(2);
    const exhaustedAtMs = shortRetryAtMs + 1_000;
    await recoveryJobs.fail({
      claim: finalShortRetry!,
      failedAt: new Date(exhaustedAtMs).toISOString(),
      failureCode: 'GMAIL_PROVIDER_UNAVAILABLE',
      retryable: true,
      retryAt: new Date(exhaustedAtMs + 1_000).toISOString(),
      maxAttempts: 2,
    });
    await expect(
      recoveryJobs.claim({
        workerId: 'worker.exhaustion-cooldown',
        now: new Date(exhaustedAtMs + 899_999).toISOString(),
        leaseExpiresAt: new Date(exhaustedAtMs + 959_999).toISOString(),
        maxAttempts: 2,
      }),
    ).resolves.toBeNull();
    const recoveryProbeAtMs = exhaustedAtMs + 900_000;
    const recoveryProbe = await recoveryJobs.claim({
      workerId: 'worker.exhaustion-probe',
      now: new Date(recoveryProbeAtMs).toISOString(),
      leaseExpiresAt: new Date(recoveryProbeAtMs + 60_000).toISOString(),
      maxAttempts: 2,
    });
    expect(recoveryProbe?.attempt).toBe(1);
    await recoveryJobs.complete(recoveryProbe!, new Date(recoveryProbeAtMs + 1_000).toISOString());

    await scheduler.enqueue(owner);
    const permanent = await recoveryJobs.claim({
      workerId: 'worker.permanent-failure',
      now: new Date(recoveryProbeAtMs + 2_000).toISOString(),
      leaseExpiresAt: new Date(recoveryProbeAtMs + 62_000).toISOString(),
      maxAttempts: 2,
    });
    expect(permanent?.attempt).toBe(1);
    await recoveryJobs.fail({
      claim: permanent!,
      failedAt: new Date(recoveryProbeAtMs + 3_000).toISOString(),
      failureCode: 'GMAIL_AUTH_REVOKED',
      retryable: false,
      retryAt: new Date(recoveryProbeAtMs + 4_000).toISOString(),
      maxAttempts: 2,
    });
    await expect(
      recoveryJobs.claim({
        workerId: 'worker.permanent-must-stay-terminal',
        now: new Date(recoveryProbeAtMs + 365 * 24 * 60 * 60_000).toISOString(),
        leaseExpiresAt: new Date(recoveryProbeAtMs + 365 * 24 * 60 * 60_000 + 60_000).toISOString(),
        maxAttempts: 2,
      }),
    ).resolves.toBeNull();
  });
});

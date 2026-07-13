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
import { describe, expect, it, vi } from 'vitest';
import {
  OwnTracksProviderError,
  OwnTracksSyncService,
  type OwnTracksClockPort,
  type OwnTracksCredentialVaultPort,
  type OwnTracksLocationApiPort,
  type ValidatedOwnTracksEndpoint,
} from './index.js';

const TENANT_ID = tenantId('10000000-0000-4000-8000-000000000001');
const ACCOUNT_ID = connectorAccountId('20000000-0000-4000-8000-000000000001');
const SYNC_ID = syncId('30000000-0000-4000-8000-000000000001');
const NOW = '2026-07-13T10:00:00.000Z';
const NOW_SECONDS = Math.floor(Date.parse(NOW) / 1000);
const ENDPOINT: ValidatedOwnTracksEndpoint = Object.freeze({
  endpoint: 'https://tracks.example.test/api/0/locations?user=jane&device=phone',
  allowedPorts: [443],
});

class RecordingIngestion implements HostedIngestionUseCase {
  public readonly starts: StartSyncCommand[] = [];
  public readonly commits: CommitSyncPageCommand[] = [];
  public readonly closes: CloseSyncCommand[] = [];
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
    if (this.failCommit) throw new Error('transaction rolled back');
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

function account(cursor: ConnectorAccountSnapshot['cursor']): ConnectorAccountSnapshot {
  return Object.freeze({
    id: ACCOUNT_ID,
    tenantId: TENANT_ID,
    connector: 'owntracks',
    authKind: 'basic',
    providerSubjectHash: 'a'.repeat(64),
    credentialRef: 'vault://owntracks/account-1',
    status: 'ready',
    aggregateVersion: 0,
    cursorVersion: 0,
    cursor,
    activeSync: null,
  });
}

function steadyCursor() {
  return {
    connector: 'owntracks',
    version: 1,
    mode: 'steady',
    scannedThrough: NOW_SECONDS - 60,
    highWaterTst: NOW_SECONDS - 120,
    windowSeconds: 30 * 24 * 60 * 60,
  } as const;
}

function harness(cursor: ConnectorAccountSnapshot['cursor'] = steadyCursor()) {
  const ingestion = new RecordingIngestion(account(cursor));
  const locations: OwnTracksLocationApiPort = {
    listLocations: vi.fn().mockResolvedValue({ points: [] }),
  };
  const vault: OwnTracksCredentialVaultPort = {
    read: vi.fn().mockResolvedValue({ username: 'jane', password: 'vault-secret' }),
    revoke: vi.fn(),
  };
  const clock: OwnTracksClockPort = {
    now: () => NOW,
    sleep: vi.fn().mockResolvedValue(undefined),
  };
  const service = new OwnTracksSyncService(
    ingestion,
    locations,
    vault,
    {
      sha256Hex: async (value) => (value.includes('48.856826') ? 'a' : 'b').repeat(64),
    },
    clock,
  );
  return { service, ingestion, locations, vault };
}

function run(service: OwnTracksSyncService) {
  return service.run({
    tenantId: TENANT_ID,
    accountId: ACCOUNT_ID,
    syncId: SYNC_ID,
    endpoint: ENDPOINT,
    startedAt: NOW,
    leaseExpiresAt: '2026-07-13T10:30:00.000Z',
  });
}

describe('OwnTracksSyncService', () => {
  it('run_initialSyncRequestsOnlyTheDocumentedThirtyDayWindow', async () => {
    const { service, locations } = harness({});

    await run(service);

    expect(locations.listLocations).toHaveBeenCalledTimes(1);
    expect(locations.listLocations).toHaveBeenCalledWith(
      ENDPOINT,
      { username: 'jane', password: 'vault-secret' },
      {
        fromEpochSeconds: NOW_SECONDS - 30 * 24 * 60 * 60 + 1,
        toEpochSeconds: NOW_SECONDS,
      },
      undefined,
    );
  });

  it('run_reconciliation_ingestsAllValidPointsAndCommitsCheckpointAtomically', async () => {
    const { service, ingestion, locations, vault } = harness();
    vi.mocked(locations.listLocations).mockResolvedValue({
      points: [
        {
          _type: 'location',
          tst: NOW_SECONDS - 30,
          lat: 48.856826,
          lon: 2.292713,
          acc: 5,
          topic: 'owntracks/jane/phone',
        },
        { _type: 'transition', tst: NOW_SECONDS - 20, lat: 1, lon: 2 },
        {
          _type: 'location',
          _id: 'point-2',
          tst: NOW_SECONDS - 10,
          lat: 25.2048,
          lon: 55.2708,
        },
      ],
    });

    await run(service);

    expect(vault.read).toHaveBeenCalledWith(
      { tenantId: TENANT_ID, accountId: ACCOUNT_ID },
      'vault://owntracks/account-1',
    );
    expect(locations.listLocations).toHaveBeenCalledWith(
      ENDPOINT,
      { username: 'jane', password: 'vault-secret' },
      {
        fromEpochSeconds: NOW_SECONDS - 60 - 24 * 60 * 60,
        toEpochSeconds: NOW_SECONDS,
      },
      undefined,
    );
    expect(ingestion.commits).toHaveLength(1);
    expect(ingestion.commits[0]?.events).toHaveLength(2);
    expect(ingestion.commits[0]).toMatchObject({
      expectedCursorVersion: 0,
      nextCursor: {
        connector: 'owntracks',
        mode: 'steady',
        scannedThrough: NOW_SECONDS,
        highWaterTst: NOW_SECONDS - 10,
      },
      events: [
        { sourceEventId: `tst:${NOW_SECONDS - 30}`, kind: 'location' },
        { sourceEventId: 'id:point-2', kind: 'location' },
      ],
    });
    expect(ingestion.closes).toEqual([
      expect.objectContaining({ outcome: 'completed', syncId: SYNC_ID }),
    ]);
  });

  it('run_sameReconciliationTwice_emitsIdenticalSourceRevisionForIdempotentCommit', async () => {
    const first = harness();
    const second = harness();
    const location = {
      _type: 'location',
      tst: NOW_SECONDS - 30,
      lat: 48.856826,
      lon: 2.292713,
    } as const;
    vi.mocked(first.locations.listLocations).mockResolvedValue({ points: [location] });
    vi.mocked(second.locations.listLocations).mockResolvedValue({ points: [{ ...location }] });

    await run(first.service);
    await run(second.service);

    expect(first.ingestion.commits[0]?.events).toEqual(second.ingestion.commits[0]?.events);
  });

  it('run_whenResponseIsTooLarge_shrinksWindowBeforeSingleSuccessfulAtomicCommit', async () => {
    const { service, ingestion, locations } = harness({
      connector: 'owntracks',
      version: 1,
      mode: 'window',
      nextFrom: NOW_SECONDS - 2 * 24 * 60 * 60,
      targetTo: NOW_SECONDS,
      highWaterTst: null,
      windowSeconds: 30 * 24 * 60 * 60,
    });
    vi.mocked(locations.listLocations)
      .mockRejectedValueOnce(new OwnTracksProviderError('response_too_large', false))
      .mockResolvedValueOnce({ points: [] });

    await run(service);

    expect(locations.listLocations).toHaveBeenCalledTimes(2);
    expect(ingestion.commits).toHaveLength(1);
    expect(ingestion.commits[0]?.nextCursor).toMatchObject({
      mode: 'steady',
      windowSeconds: 15 * 24 * 60 * 60,
    });
  });

  it('run_whenCredentialsAreRejected_closesFailedWithoutAnyPartialCommit', async () => {
    const { service, ingestion, locations } = harness();
    vi.mocked(locations.listLocations).mockRejectedValue(
      new OwnTracksProviderError('auth_failed', false),
    );

    await expect(run(service)).rejects.toMatchObject({ code: 'OWNTRACKS_AUTH_FAILED' });
    expect(ingestion.commits).toHaveLength(0);
    expect(ingestion.closes[0]).toMatchObject({
      outcome: 'failed',
      reasonCode: 'OWNTRACKS_AUTH_FAILED',
    });
  });

  it('run_whenAtomicCommitFails_doesNotAdvanceCursorAndClosesFailed', async () => {
    const { service, ingestion, locations } = harness();
    ingestion.failCommit = true;
    vi.mocked(locations.listLocations).mockResolvedValue({
      points: [
        {
          _type: 'location',
          tst: NOW_SECONDS - 30,
          lat: 48.856826,
          lon: 2.292713,
        },
      ],
    });

    await expect(run(service)).rejects.toMatchObject({ code: 'OWNTRACKS_SYNC_FAILED' });
    expect(ingestion.commits).toHaveLength(0);
    expect(ingestion.closes[0]).toMatchObject({
      outcome: 'failed',
      reasonCode: 'OWNTRACKS_SYNC_FAILED',
    });
  });
});

import { connectorAccountId, tenantId } from '@botmem-v2/connector-domain';
import { describe, expect, it } from 'vitest';
import type {
  SqlClientPort,
  SqlPoolPort,
  SqlQueryConfig,
  SqlQueryResult,
} from '../search/postgres-ports.js';
import {
  PostgresHostedSyncWorkerJobStore,
  type HostedSyncJobClaim,
} from './hosted-sync-job-store.js';

const TENANT_ID = tenantId('10000000-0000-4000-8000-000000000001');
const ACCOUNT_ID = connectorAccountId('20000000-0000-4000-8000-000000000001');
const COMPLETED_AT = '2026-07-13T10:00:00.000Z';
const FAILED_AT = '2026-07-13T10:04:00.000Z';

describe('PostgresHostedSyncWorkerJobStore periodic cadence', () => {
  it('complete_schedulesEachConnectorAtItsConfiguredDurableDueTime', async () => {
    const updates: SqlQueryConfig[] = [];
    const store = new PostgresHostedSyncWorkerJobStore(pool(updates), {
      gmail: 60_000,
      outlook: 120_000,
      owntracks: 180_000,
    });

    for (const connector of ['gmail', 'outlook', 'owntracks'] as const) {
      await store.complete(claim(connector), COMPLETED_AT);
    }

    expect(updates.map((query) => query.values?.[5])).toEqual([
      '2026-07-13T10:01:00.000Z',
      '2026-07-13T10:02:00.000Z',
      '2026-07-13T10:03:00.000Z',
    ]);
    expect(
      updates.every((query) => query.text.includes('THEN $5::timestamptz ELSE $6::timestamptz')),
    ).toBe(true);
    expect(
      updates.every((query) =>
        query.text.includes('lease_expires_at > clock_timestamp()'),
      ),
    ).toBe(true);
  });

  it('constructor_rejectsUnboundedCadences', () => {
    expect(
      () =>
        new PostgresHostedSyncWorkerJobStore(pool([]), {
          gmail: 59_999,
          outlook: 120_000,
          owntracks: 180_000,
        }),
    ).toThrow(/between one minute and one day/u);
  });

  it('claim_passesTheBoundedDurableExhaustionCooldownToPostgres', async () => {
    const queries: SqlQueryConfig[] = [];
    const store = new PostgresHostedSyncWorkerJobStore(claimPool(queries), undefined, 900_000);

    await store.claim({
      workerId: 'worker.test',
      now: COMPLETED_AT,
      leaseExpiresAt: '2026-07-13T10:01:00.000Z',
      maxAttempts: 3,
    });

    const claimQuery = queries.find((query) => query.text.includes('claim_hosted_sync_job'));
    expect(claimQuery?.values?.[5]).toBe(900);
    expect(claimQuery?.text).toContain('$5, $6');
  });

  it('fail_afterTransientAttemptsExhaust_schedulesAFreshProbeCycle', async () => {
    const updates: SqlQueryConfig[] = [];
    const store = new PostgresHostedSyncWorkerJobStore(pool(updates), undefined, 900_000);

    await store.fail({
      claim: claim('gmail', 3),
      failedAt: FAILED_AT,
      failureCode: 'GMAIL_PROVIDER_UNAVAILABLE',
      retryable: true,
      retryAt: '2026-07-13T10:05:00.000Z',
      maxAttempts: 3,
    });

    expect(updates[0]?.values?.slice(4, 8)).toEqual([
      'retryable_exhausted',
      '2026-07-13T10:19:00.000Z',
      null,
      'GMAIL_PROVIDER_UNAVAILABLE',
    ]);
    expect(updates[0]?.text).toContain("THEN 'pending' ELSE $5");
    expect(updates[0]?.text).toContain('lease_expires_at > clock_timestamp()');
  });

  it('fail_whenPermanent_staysTerminalEvenAtTheFirstAttempt', async () => {
    const updates: SqlQueryConfig[] = [];
    const store = new PostgresHostedSyncWorkerJobStore(pool(updates), undefined, 900_000);

    await store.fail({
      claim: claim('outlook', 1),
      failedAt: FAILED_AT,
      failureCode: 'OUTLOOK_AUTH_REVOKED',
      retryable: false,
      retryAt: '2026-07-13T10:05:00.000Z',
      maxAttempts: 3,
    });

    expect(updates[0]?.values?.slice(4, 8)).toEqual([
      'dead',
      FAILED_AT,
      FAILED_AT,
      'OUTLOOK_AUTH_REVOKED',
    ]);
  });

  it('constructor_rejectsAnUnboundedExhaustionCooldown', () => {
    expect(() => new PostgresHostedSyncWorkerJobStore(pool([]), undefined, 899_000)).toThrow(
      /between 15 minutes and 7 days/u,
    );
    expect(() => new PostgresHostedSyncWorkerJobStore(pool([]), undefined, 604_801_000)).toThrow(
      /between 15 minutes and 7 days/u,
    );
  });
});

function claim(connector: HostedSyncJobClaim['connector'], attempt = 1): HostedSyncJobClaim {
  return {
    jobId: '30000000-0000-4000-8000-000000000001',
    tenantId: TENANT_ID,
    accountId: ACCOUNT_ID,
    connector,
    attempt,
    leaseToken: '40000000-0000-4000-8000-000000000001',
    leaseExpiresAt: '2026-07-13T10:10:00.000Z',
  };
}

function claimPool(queries: SqlQueryConfig[]): SqlPoolPort {
  const client: SqlClientPort = {
    query: async <Row>(query: SqlQueryConfig): Promise<SqlQueryResult<Row>> => {
      queries.push(query);
      return { rows: [], rowCount: null };
    },
    release: () => undefined,
  };
  return { connect: async () => client };
}

function pool(updates: SqlQueryConfig[]): SqlPoolPort {
  const client: SqlClientPort = {
    query: async <Row>(query: SqlQueryConfig): Promise<SqlQueryResult<Row>> => {
      if (query.text.startsWith('UPDATE botmem.hosted_sync_job')) updates.push(query);
      return { rows: [], rowCount: query.text.startsWith('UPDATE') ? 1 : null };
    },
    release: () => undefined,
  };
  return { connect: async () => client };
}

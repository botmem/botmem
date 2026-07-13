import type { HostedConnector } from '@botmem-v2/contracts';
import {
  connectorAccountId,
  tenantId,
  type ConnectorAccountId,
  type TenantId,
} from '@botmem-v2/connector-domain';
import { randomUUID } from 'node:crypto';
import type { SqlClientPort, SqlPoolPort } from '../search/postgres-ports.js';
import type { HostedSyncSchedulerPort } from './ports.js';

export interface HostedSyncJobClaim {
  readonly jobId: string;
  readonly tenantId: TenantId;
  readonly accountId: ConnectorAccountId;
  readonly connector: HostedConnector;
  readonly attempt: number;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
}

export interface HostedSyncReadinessPort {
  isReady(): Promise<boolean>;
}

export interface HostedSyncCadenceMs {
  readonly gmail: number;
  readonly outlook: number;
  readonly owntracks: number;
}

const DEFAULT_CADENCE_MS: HostedSyncCadenceMs = Object.freeze({
  gmail: 5 * 60_000,
  outlook: 5 * 60_000,
  owntracks: 5 * 60_000,
});

const DEFAULT_EXHAUSTED_RETRY_MS = 6 * 60 * 60_000;
const MINIMUM_EXHAUSTED_RETRY_MS = 15 * 60_000;
const MAXIMUM_EXHAUSTED_RETRY_MS = 7 * 24 * 60 * 60_000;

export interface HostedSyncWorkerJobStore {
  claim(input: {
    readonly workerId: string;
    readonly now: string;
    readonly leaseExpiresAt: string;
    readonly maxAttempts: number;
  }): Promise<HostedSyncJobClaim | null>;
  complete(claim: HostedSyncJobClaim, completedAt: string): Promise<void>;
  fail(input: {
    readonly claim: HostedSyncJobClaim;
    readonly failedAt: string;
    readonly failureCode: string;
    readonly retryable: boolean;
    readonly retryAt: string;
    readonly maxAttempts: number;
  }): Promise<void>;
  cancel(claim: HostedSyncJobClaim, cancelledAt: string, reasonCode: string): Promise<void>;
  heartbeat(workerId: string, now: string): Promise<void>;
}

interface ClaimRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly account_id: string;
  readonly connector: HostedConnector;
  readonly attempt: number;
  readonly lease_token: string;
  readonly lease_expires_at: Date | string;
}

export class PostgresHostedSyncScheduler
  implements HostedSyncSchedulerPort, HostedSyncReadinessPort
{
  constructor(
    private readonly apiPool: SqlPoolPort,
    private readonly readyMaxAgeSeconds = 45,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    if (readyMaxAgeSeconds < 1 || readyMaxAgeSeconds > 300) {
      throw new RangeError('hosted sync readiness age must be between 1 and 300 seconds');
    }
  }

  async enqueue(input: {
    readonly tenantId: TenantId;
    readonly accountId: ConnectorAccountId;
    readonly connector: HostedConnector;
  }): Promise<void> {
    const requestedAt = this.now();
    await this.transaction(input.tenantId, async (client) => {
      const result = await client.query({
        text: `INSERT INTO botmem.hosted_sync_job (
                 id, tenant_id, account_id, connector, state,
                 request_version, attempts, available_at, requested_at
               )
               SELECT $1::uuid, account.tenant_id, account.id, account.connector,
                      'pending', 1, 0, $5::timestamptz, $5::timestamptz
                 FROM botmem.connector_account account
                WHERE account.tenant_id = $2::uuid AND account.id = $3::uuid
                  AND account.connector = $4
                  AND account.status IN ('ready', 'degraded')
               ON CONFLICT (tenant_id, account_id) DO UPDATE
                  SET request_version = botmem.hosted_sync_job.request_version + 1,
                      state = CASE WHEN botmem.hosted_sync_job.state = 'running'
                                   THEN 'running' ELSE 'pending' END,
                      attempts = CASE WHEN botmem.hosted_sync_job.state = 'running'
                                      THEN botmem.hosted_sync_job.attempts ELSE 0 END,
                      available_at = CASE WHEN botmem.hosted_sync_job.state = 'running'
                                          THEN botmem.hosted_sync_job.available_at
                                          ELSE EXCLUDED.available_at END,
                      requested_at = EXCLUDED.requested_at,
                      started_at = CASE WHEN botmem.hosted_sync_job.state = 'running'
                                        THEN botmem.hosted_sync_job.started_at ELSE NULL END,
                      finished_at = NULL,
                      claimed_request_version = CASE WHEN botmem.hosted_sync_job.state = 'running'
                                                     THEN botmem.hosted_sync_job.claimed_request_version
                                                     ELSE NULL END,
                      lease_owner = CASE WHEN botmem.hosted_sync_job.state = 'running'
                                         THEN botmem.hosted_sync_job.lease_owner ELSE NULL END,
                      lease_token = CASE WHEN botmem.hosted_sync_job.state = 'running'
                                         THEN botmem.hosted_sync_job.lease_token ELSE NULL END,
                      lease_expires_at = CASE WHEN botmem.hosted_sync_job.state = 'running'
                                              THEN botmem.hosted_sync_job.lease_expires_at ELSE NULL END,
                      failure_code = NULL
                WHERE botmem.hosted_sync_job.connector = EXCLUDED.connector
               RETURNING id`,
        values: [randomUUID(), input.tenantId, input.accountId, input.connector, requestedAt],
      });
      if (result.rowCount !== 1) throw new HostedSyncPersistenceError('SYNC_ENQUEUE_REJECTED');
    });
  }

  async isReady(): Promise<boolean> {
    try {
      return await this.transaction(null, async (client) => {
        const result = await client.query<{ readonly ready: boolean }>({
          text: `SELECT botmem.hosted_sync_worker_ready($1::timestamptz, $2) AS ready`,
          values: [this.now(), this.readyMaxAgeSeconds],
        });
        return result.rows[0]?.ready === true;
      });
    } catch {
      return false;
    }
  }

  private async transaction<Result>(
    tenant: TenantId | null,
    operation: (client: SqlClientPort) => Promise<Result>,
  ): Promise<Result> {
    return transaction(this.apiPool, 'botmem_api', tenant, operation);
  }
}

/** Worker-only job boundary. This class cannot enqueue API requests or read readiness. */
export class PostgresHostedSyncWorkerJobStore implements HostedSyncWorkerJobStore {
  constructor(
    private readonly workerPool: SqlPoolPort,
    private readonly cadenceMs: HostedSyncCadenceMs = DEFAULT_CADENCE_MS,
    private readonly exhaustedRetryMs = DEFAULT_EXHAUSTED_RETRY_MS,
  ) {
    for (const [connector, cadence] of Object.entries(cadenceMs)) {
      if (!Number.isSafeInteger(cadence) || cadence < 60_000 || cadence > 86_400_000) {
        throw new RangeError(
          `${connector} hosted sync cadence must be between one minute and one day`,
        );
      }
    }
    if (
      !Number.isSafeInteger(exhaustedRetryMs) ||
      exhaustedRetryMs < MINIMUM_EXHAUSTED_RETRY_MS ||
      exhaustedRetryMs > MAXIMUM_EXHAUSTED_RETRY_MS ||
      exhaustedRetryMs % 1_000 !== 0
    ) {
      throw new RangeError(
        'hosted sync exhausted retry cooldown must be whole seconds between 15 minutes and 7 days',
      );
    }
  }

  async claim(input: {
    readonly workerId: string;
    readonly now: string;
    readonly leaseExpiresAt: string;
    readonly maxAttempts: number;
  }): Promise<HostedSyncJobClaim | null> {
    return this.transaction(null, async (client) => {
      const leaseToken = randomUUID();
      const result = await client.query<ClaimRow>({
        text: `SELECT id, tenant_id, account_id, connector, attempt,
                      lease_token, lease_expires_at
                 FROM botmem.claim_hosted_sync_job($1, $2::uuid, $3::timestamptz,
                                                   $4::timestamptz, $5, $6)`,
        values: [
          input.workerId,
          leaseToken,
          input.now,
          input.leaseExpiresAt,
          input.maxAttempts,
          this.exhaustedRetryMs / 1_000,
        ],
      });
      const row = result.rows[0];
      return row
        ? Object.freeze({
            jobId: row.id,
            tenantId: tenantId(row.tenant_id),
            accountId: connectorAccountId(row.account_id),
            connector: row.connector,
            attempt: Number(row.attempt),
            leaseToken: row.lease_token,
            leaseExpiresAt: iso(row.lease_expires_at),
          })
        : null;
    });
  }

  async complete(claim: HostedSyncJobClaim, completedAt: string): Promise<void> {
    const nextDueAt = new Date(
      Date.parse(completedAt) + this.cadenceMs[claim.connector],
    ).toISOString();
    await this.transaction(claim.tenantId, async (client) => {
      const result = await client.query({
        text: `UPDATE botmem.hosted_sync_job
                  SET state = CASE WHEN request_version > claimed_request_version
                                   THEN 'pending' ELSE 'completed' END,
                      attempts = CASE WHEN request_version > claimed_request_version
                                      THEN 0 ELSE attempts END,
                      available_at = CASE WHEN request_version > claimed_request_version
                                          THEN $5::timestamptz ELSE $6::timestamptz END,
                      finished_at = CASE WHEN request_version > claimed_request_version
                                         THEN NULL ELSE $5::timestamptz END,
                      lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
                      failure_code = NULL
                WHERE tenant_id = $1::uuid AND account_id = $2::uuid
                  AND id = $3::uuid AND state = 'running' AND lease_token = $4::uuid`,
        values: [
          claim.tenantId,
          claim.accountId,
          claim.jobId,
          claim.leaseToken,
          completedAt,
          nextDueAt,
        ],
      });
      if (result.rowCount !== 1) throw new HostedSyncLeaseLostError();
    });
  }

  async fail(input: {
    readonly claim: HostedSyncJobClaim;
    readonly failedAt: string;
    readonly failureCode: string;
    readonly retryable: boolean;
    readonly retryAt: string;
    readonly maxAttempts: number;
  }): Promise<void> {
    const retry = input.retryable && input.claim.attempt < input.maxAttempts;
    const exhausted = input.retryable && !retry;
    const exhaustedRetryAt = new Date(
      Date.parse(input.failedAt) + this.exhaustedRetryMs,
    ).toISOString();
    await this.transaction(input.claim.tenantId, async (client) => {
      const result = await client.query({
        text: `UPDATE botmem.hosted_sync_job
                  SET state = CASE WHEN request_version > claimed_request_version
                                   THEN 'pending' ELSE $5 END,
                      attempts = CASE WHEN request_version > claimed_request_version
                                      THEN 0 ELSE attempts END,
                      available_at = CASE WHEN request_version > claimed_request_version
                                          THEN $9::timestamptz ELSE $6::timestamptz END,
                      finished_at = CASE WHEN request_version > claimed_request_version
                                         THEN NULL ELSE $7::timestamptz END,
                      lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
                      failure_code = CASE WHEN request_version > claimed_request_version
                                          THEN NULL ELSE $8 END
                WHERE tenant_id = $1::uuid AND account_id = $2::uuid
                  AND id = $3::uuid AND state = 'running' AND lease_token = $4::uuid`,
        values: [
          input.claim.tenantId,
          input.claim.accountId,
          input.claim.jobId,
          input.claim.leaseToken,
          retry ? 'retry_wait' : exhausted ? 'retryable_exhausted' : 'dead',
          retry ? input.retryAt : exhausted ? exhaustedRetryAt : input.failedAt,
          retry || exhausted ? null : input.failedAt,
          input.failureCode,
          input.failedAt,
        ],
      });
      if (result.rowCount !== 1) throw new HostedSyncLeaseLostError();
      await client.query({
        text: `UPDATE botmem.connector_account
                  SET status = 'degraded', updated_at = $3::timestamptz
                WHERE tenant_id = $1::uuid AND id = $2::uuid
                  AND status IN ('ready', 'degraded')`,
        values: [input.claim.tenantId, input.claim.accountId, input.failedAt],
      });
    });
  }

  async cancel(claim: HostedSyncJobClaim, cancelledAt: string, reasonCode: string): Promise<void> {
    await this.transaction(claim.tenantId, async (client) => {
      const result = await client.query({
        text: `UPDATE botmem.hosted_sync_job
                  SET state = 'cancelled', finished_at = $5::timestamptz,
                      lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
                      failure_code = $6
                WHERE tenant_id = $1::uuid AND account_id = $2::uuid
                  AND id = $3::uuid AND state = 'running' AND lease_token = $4::uuid`,
        values: [
          claim.tenantId,
          claim.accountId,
          claim.jobId,
          claim.leaseToken,
          cancelledAt,
          reasonCode,
        ],
      });
      if (result.rowCount !== 1) throw new HostedSyncLeaseLostError();
    });
  }

  async heartbeat(workerId: string, now: string): Promise<void> {
    await this.transaction(null, async (client) => {
      await client.query({
        text: `INSERT INTO botmem.hosted_sync_worker_heartbeat (
                 worker_id, started_at, last_seen_at
               ) VALUES ($1, $2::timestamptz, $2::timestamptz)
               ON CONFLICT (worker_id) DO UPDATE
                  SET last_seen_at = EXCLUDED.last_seen_at`,
        values: [workerId, now],
      });
    });
  }

  private async transaction<Result>(
    tenant: TenantId | null,
    operation: (client: SqlClientPort) => Promise<Result>,
  ): Promise<Result> {
    return transaction(this.workerPool, 'botmem_worker', tenant, operation);
  }
}

export class HostedSyncPersistenceError extends Error {
  override readonly name = 'HostedSyncPersistenceError';
  constructor(readonly code: 'SYNC_ENQUEUE_REJECTED') {
    super(code);
  }
}

export class HostedSyncLeaseLostError extends Error {
  override readonly name = 'HostedSyncLeaseLostError';
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function transaction<Result>(
  pool: SqlPoolPort,
  role: 'botmem_api' | 'botmem_worker',
  tenant: TenantId | null,
  operation: (client: SqlClientPort) => Promise<Result>,
): Promise<Result> {
  const client = await pool.connect();
  let open = false;
  try {
    await client.query({ text: 'BEGIN' });
    open = true;
    await client.query({ text: `SET LOCAL ROLE ${role}` });
    if (tenant) {
      await client.query({
        text: "SELECT set_config('botmem.tenant_id', $1, true)",
        values: [tenant],
      });
    }
    const result = await operation(client);
    await client.query({ text: 'COMMIT' });
    open = false;
    return result;
  } catch (error) {
    if (open) await client.query({ text: 'ROLLBACK' }).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

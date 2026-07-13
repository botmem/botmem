import type { AuthenticatedPrincipal } from '../identity/domain.js';
import { randomUUID } from 'node:crypto';
import type { SqlClientPort, SqlPoolPort } from '../search/postgres-ports.js';
import type {
  ExportPage,
  HostedExportRecord,
  LifecycleJobClaim,
  LifecycleJobKind,
  LifecycleJobState,
  LifecycleJobView,
} from './domain.js';
import { LifecycleJobNotFoundError } from './domain.js';
import type {
  BillingCancellationClaim,
  BillingCancellationRepositoryPort,
  DeviceDeletionNoticeClaim,
  DeviceDeletionNoticeRelayRepositoryPort,
  LifecycleApiRepositoryPort,
  LifecycleWorkerRepositoryPort,
} from './ports.js';

interface JobViewRow {
  readonly id: string;
  readonly kind: LifecycleJobKind;
  readonly state: LifecycleJobState;
  readonly requested_at: Date | string;
  readonly attempts: number;
  readonly artifact_expires_at: Date | string | null;
  readonly completed_at: Date | string | null;
  readonly failure_code: string | null;
  readonly local_delivered: number | string;
  readonly local_unreachable: number | string;
  readonly local_pending: number | string;
}

interface ClaimRow {
  readonly job_id: string;
  readonly tenant_id: string;
  readonly workspace_id: string;
  readonly requested_by_user_id: string;
  readonly kind: LifecycleJobKind;
  readonly attempts: number;
  readonly lease_token: string;
}

interface ExportRow {
  readonly account_id: string;
  readonly source_event_id: string;
  readonly connector: 'gmail' | 'outlook' | 'owntracks';
  readonly source_revision: string;
  readonly kind: 'email' | 'location';
  readonly occurred_at: Date | string | null;
  readonly observed_at: Date | string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly tombstone: boolean;
}

interface BooleanRow {
  readonly value: boolean;
}

interface TextRow {
  readonly value: string | null;
}

const jobViewSql = `SELECT job.id, job.kind, job.state, job.requested_at, job.attempts,
       job.artifact_expires_at, job.completed_at, job.failure_code,
       (SELECT count(*) FROM botmem.workspace_device_deletion_notice notice
         WHERE notice.job_id = job.id AND notice.state = 'delivered') AS local_delivered,
       (SELECT count(*) FROM botmem.workspace_device_deletion_notice notice
         WHERE notice.job_id = job.id AND notice.state = 'unreachable') AS local_unreachable,
       (SELECT count(*) FROM botmem.workspace_device_deletion_notice notice
         WHERE notice.job_id = job.id AND notice.state IN ('pending', 'delivering')) AS local_pending
  FROM botmem.workspace_lifecycle_job job`;

export class PostgresLifecycleApiRepository implements LifecycleApiRepositoryPort {
  constructor(private readonly pool: SqlPoolPort) {}

  requestExport(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly jobId: string;
    readonly requestedAt: string;
    readonly maxAttempts: number;
  }): Promise<LifecycleJobView> {
    return this.request('request_workspace_export', input);
  }

  requestDeletion(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly jobId: string;
    readonly requestedAt: string;
    readonly maxAttempts: number;
  }): Promise<LifecycleJobView> {
    return this.request('request_workspace_deletion', input);
  }

  async list(input: {
    readonly principal: AuthenticatedPrincipal;
  }): Promise<readonly LifecycleJobView[]> {
    return transaction(this.pool, 'botmem_api', async (client) => {
      await setOwnerContext(client, input.principal);
      const result = await client.query<JobViewRow>({
        text: `${jobViewSql}
                WHERE job.tenant_id = $1::uuid
                  AND job.workspace_id = $2::uuid
                  AND job.requested_by_user_id = $3::uuid
                ORDER BY job.requested_at DESC, job.id DESC`,
        values: [input.principal.tenantId, input.principal.workspaceId, input.principal.userId],
      });
      return result.rows.map(jobView);
    });
  }

  async workerReady(input: {
    readonly now: string;
    readonly maximumAgeSeconds: number;
  }): Promise<boolean> {
    return transaction(this.pool, 'botmem_api', async (client) => {
      const result = await client.query<BooleanRow>({
        text: `SELECT botmem.workspace_lifecycle_worker_ready(
                 $1::timestamptz, $2::integer
               ) AS value`,
        values: [input.now, input.maximumAgeSeconds],
      });
      return result.rows[0]?.value === true;
    });
  }

  async readExportArtifactKey(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly jobId: string;
    readonly now: string;
  }): Promise<string | null> {
    return transaction(this.pool, 'botmem_api', async (client) => {
      await setOwnerContext(client, input.principal);
      const result = await client.query<TextRow>({
        text: `SELECT botmem.read_workspace_export_artifact(
                 $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz
               ) AS value`,
        values: [
          input.jobId,
          input.principal.tenantId,
          input.principal.workspaceId,
          input.principal.userId,
          input.now,
        ],
      });
      return result.rows[0]?.value ?? null;
    });
  }

  private async request(
    functionName: 'request_workspace_export' | 'request_workspace_deletion',
    input: {
      readonly principal: AuthenticatedPrincipal;
      readonly jobId: string;
      readonly requestedAt: string;
      readonly maxAttempts: number;
    },
  ): Promise<LifecycleJobView> {
    return transaction(this.pool, 'botmem_api', async (client) => {
      await setOwnerContext(client, input.principal);
      const requested = await client.query<{ readonly id: string }>({
        text: `SELECT botmem.${functionName}(
                 $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz, $6::integer
               ) AS id`,
        values: [
          input.jobId,
          input.principal.tenantId,
          input.principal.workspaceId,
          input.principal.userId,
          input.requestedAt,
          input.maxAttempts,
        ],
      });
      const jobId = requested.rows[0]?.id;
      if (!jobId) throw new LifecycleJobNotFoundError();
      const result = await client.query<JobViewRow>({
        text: `${jobViewSql} WHERE job.id = $1::uuid`,
        values: [jobId],
      });
      const row = result.rows[0];
      if (!row) throw new LifecycleJobNotFoundError();
      return jobView(row);
    });
  }
}

export class PostgresLifecycleWorkerRepository implements LifecycleWorkerRepositoryPort {
  constructor(private readonly pool: SqlPoolPort) {}

  async claim(input: {
    readonly workerId: string;
    readonly claimedAt: string;
    readonly leaseExpiresAt: string;
  }): Promise<LifecycleJobClaim | null> {
    return transaction(this.pool, 'botmem_lifecycle', async (client) => {
      const leaseToken = randomUUID();
      const result = await client.query<ClaimRow>({
        text: `SELECT * FROM botmem.claim_workspace_lifecycle_job(
                 $1, $2::uuid, $3::timestamptz, $4::timestamptz
               )`,
        values: [input.workerId, leaseToken, input.claimedAt, input.leaseExpiresAt],
      });
      const row = result.rows[0];
      return row ? claim(row) : null;
    });
  }

  renewLease(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly now: string;
    readonly leaseExpiresAt: string;
  }): Promise<boolean> {
    return this.booleanFunction(
      'renew_workspace_lifecycle_lease',
      [input.jobId, input.workerId, input.leaseToken, input.now, input.leaseExpiresAt],
      '$1::uuid, $2, $3::uuid, $4::timestamptz, $5::timestamptz',
    );
  }

  async readExportPage(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly now: string;
    readonly cursor: { readonly accountId: string; readonly sourceEventId: string } | null;
    readonly pageSize: number;
  }): Promise<ExportPage> {
    return transaction(this.pool, 'botmem_lifecycle', async (client) => {
      const result = await client.query<ExportRow>({
        text: `SELECT * FROM botmem.read_workspace_export_page(
                 $1::uuid, $2, $3::uuid, $4::timestamptz, $5::uuid, $6, $7::integer
               )`,
        values: [
          input.jobId,
          input.workerId,
          input.leaseToken,
          input.now,
          input.cursor?.accountId ?? null,
          input.cursor?.sourceEventId ?? null,
          input.pageSize,
        ],
      });
      const items = result.rows.map(exportRecord);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          items.length === input.pageSize && last
            ? { accountId: last.accountId, sourceEventId: last.sourceEventId }
            : null,
      };
    });
  }

  async deletionBlockers(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly now: string;
  }): Promise<{
    readonly pendingNotices: number;
    readonly billingState: 'not_required' | 'pending' | 'processing' | 'confirmed' | 'dead';
  }> {
    return transaction(this.pool, 'botmem_lifecycle', async (client) => {
      const result = await client.query<{
        readonly pending_notices: number | string;
        readonly billing_state: 'not_required' | 'pending' | 'processing' | 'confirmed' | 'dead';
      }>({
        text: `SELECT * FROM botmem.workspace_deletion_blockers(
                 $1::uuid, $2, $3::uuid, $4::timestamptz
               )`,
        values: [input.jobId, input.workerId, input.leaseToken, input.now],
      });
      const row = result.rows[0];
      if (!row) throw new LifecycleJobNotFoundError();
      return {
        pendingNotices: Number(row.pending_notices),
        billingState: row.billing_state,
      };
    });
  }

  deferDeletion(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly now: string;
    readonly retryAt: string;
    readonly reason: 'BILLING_CANCELLATION_PENDING' | 'BILLING_CANCELLATION_DEAD';
  }): Promise<boolean> {
    return this.booleanFunction(
      'defer_workspace_deletion',
      [input.jobId, input.workerId, input.leaseToken, input.now, input.retryAt, input.reason],
      '$1::uuid, $2, $3::uuid, $4::timestamptz, $5::timestamptz, $6',
    );
  }

  async listDeletionArtifacts(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly now: string;
  }): Promise<readonly { readonly jobId: string; readonly artifactKey: string }[]> {
    return transaction(this.pool, 'botmem_lifecycle', async (client) => {
      const result = await client.query<{ readonly job_id: string; readonly artifact_key: string }>(
        {
          text: `SELECT * FROM botmem.list_workspace_deletion_artifacts(
                 $1::uuid, $2, $3::uuid, $4::timestamptz
               )`,
          values: [input.jobId, input.workerId, input.leaseToken, input.now],
        },
      );
      return result.rows.map((row) => ({ jobId: row.job_id, artifactKey: row.artifact_key }));
    });
  }

  completeExport(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly completedAt: string;
    readonly artifactKey: string;
    readonly artifactExpiresAt: string;
  }): Promise<boolean> {
    return this.booleanFunction(
      'complete_workspace_export',
      [
        input.jobId,
        input.workerId,
        input.leaseToken,
        input.completedAt,
        input.artifactKey,
        input.artifactExpiresAt,
      ],
      '$1::uuid, $2, $3::uuid, $4::timestamptz, $5, $6::timestamptz',
    );
  }

  completeDeletion(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly completedAt: string;
  }): Promise<boolean> {
    return this.booleanFunction(
      'complete_workspace_deletion',
      [input.jobId, input.workerId, input.leaseToken, input.completedAt],
      '$1::uuid, $2, $3::uuid, $4::timestamptz',
    );
  }

  authorizeWorkspaceDestruction(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly now: string;
    readonly leaseExpiresAt: string;
  }): Promise<boolean> {
    return this.booleanFunction(
      'authorize_workspace_destruction',
      [input.jobId, input.workerId, input.leaseToken, input.now, input.leaseExpiresAt],
      '$1::uuid, $2, $3::uuid, $4::timestamptz, $5::timestamptz',
    );
  }

  async fail(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly failedAt: string;
    readonly retryAt: string;
    readonly failureCode: string;
  }): Promise<'retry' | 'dead' | null> {
    return transaction(this.pool, 'botmem_lifecycle', async (client) => {
      const result = await client.query<TextRow>({
        text: `SELECT botmem.fail_workspace_lifecycle_job(
                 $1::uuid, $2, $3::uuid, $4::timestamptz, $5::timestamptz, $6
               ) AS value`,
        values: [
          input.jobId,
          input.workerId,
          input.leaseToken,
          input.failedAt,
          input.retryAt,
          input.failureCode,
        ],
      });
      const value = result.rows[0]?.value;
      return value === 'retry' || value === 'dead' ? value : null;
    });
  }

  async heartbeat(input: {
    readonly workerId: string;
    readonly startedAt: string;
    readonly seenAt: string;
  }): Promise<void> {
    await transaction(this.pool, 'botmem_lifecycle', async (client) => {
      await client.query({
        text: `SELECT botmem.heartbeat_workspace_lifecycle_worker(
                 $1, $2::timestamptz, $3::timestamptz
               )`,
        values: [input.workerId, input.startedAt, input.seenAt],
      });
    });
  }

  async listExpiredArtifacts(input: {
    readonly now: string;
    readonly limit: number;
  }): Promise<readonly { readonly jobId: string; readonly artifactKey: string }[]> {
    return transaction(this.pool, 'botmem_lifecycle', async (client) => {
      const result = await client.query<{ readonly job_id: string; readonly artifact_key: string }>(
        {
          text: `SELECT * FROM botmem.list_expired_workspace_artifacts(
                 $1::timestamptz, $2::integer
               )`,
          values: [input.now, input.limit],
        },
      );
      return result.rows.map((row) => ({ jobId: row.job_id, artifactKey: row.artifact_key }));
    });
  }

  completeArtifactPurge(jobId: string): Promise<boolean> {
    return this.booleanFunction('complete_workspace_artifact_purge', [jobId], '$1::uuid');
  }

  async purgeExpiredBillingAudits(input: {
    readonly now: string;
    readonly limit: number;
  }): Promise<number> {
    return transaction(this.pool, 'botmem_lifecycle', async (client) => {
      const result = await client.query<{ readonly value: number | string }>({
        text: `SELECT botmem.purge_expired_workspace_deleted_billing_audit(
                 $1::timestamptz, $2::integer
               ) AS value`,
        values: [input.now, input.limit],
      });
      return Number(result.rows[0]?.value ?? 0);
    });
  }

  repair(input: {
    readonly jobId: string;
    readonly repairedAt: string;
    readonly repairReference: string;
  }): Promise<boolean> {
    return this.booleanFunction(
      'repair_workspace_lifecycle_job',
      [input.jobId, input.repairedAt, input.repairReference],
      '$1::uuid, $2::timestamptz, $3',
    );
  }

  private async booleanFunction(
    name: string,
    values: readonly unknown[],
    parameters: string,
  ): Promise<boolean> {
    return transaction(this.pool, 'botmem_lifecycle', async (client) => {
      const result = await client.query<BooleanRow>({
        text: `SELECT botmem.${name}(${parameters}) AS value`,
        values,
      });
      return result.rows[0]?.value === true;
    });
  }
}

export class PostgresDeviceDeletionNoticeRelayRepository implements DeviceDeletionNoticeRelayRepositoryPort {
  constructor(private readonly pool: SqlPoolPort) {}

  async claim(input: {
    readonly relayId: string;
    readonly claimedAt: string;
    readonly leaseExpiresAt: string;
  }): Promise<DeviceDeletionNoticeClaim | null> {
    return transaction(this.pool, 'botmem_api', async (client) => {
      const leaseToken = randomUUID();
      const result = await client.query<{
        readonly job_id: string;
        readonly tenant_id: string;
        readonly workspace_id: string;
        readonly device_id: string;
        readonly attempts: number;
        readonly lease_token: string;
      }>({
        text: `SELECT * FROM botmem.claim_workspace_device_deletion_notice(
                 $1, $2::uuid, $3::timestamptz, $4::timestamptz
               )`,
        values: [input.relayId, leaseToken, input.claimedAt, input.leaseExpiresAt],
      });
      const row = result.rows[0];
      return row
        ? {
            jobId: row.job_id,
            tenantId: row.tenant_id,
            workspaceId: row.workspace_id,
            deviceId: row.device_id,
            attempts: Number(row.attempts),
            leaseToken: row.lease_token,
          }
        : null;
    });
  }

  finish(input: {
    readonly jobId: string;
    readonly deviceId: string;
    readonly relayId: string;
    readonly leaseToken: string;
    readonly state: 'delivered' | 'unreachable';
    readonly attemptedAt: string;
  }): Promise<boolean> {
    return this.booleanFunction(
      'finish_workspace_device_deletion_notice',
      [
        input.jobId,
        input.deviceId,
        input.relayId,
        input.leaseToken,
        input.state,
        input.attemptedAt,
      ],
      '$1::uuid, $2::uuid, $3, $4::uuid, $5, $6::timestamptz',
    );
  }

  async fail(input: {
    readonly jobId: string;
    readonly deviceId: string;
    readonly relayId: string;
    readonly leaseToken: string;
    readonly failedAt: string;
    readonly retryAt: string;
  }): Promise<'pending' | 'unreachable' | null> {
    return transaction(this.pool, 'botmem_api', async (client) => {
      const result = await client.query<TextRow>({
        text: `SELECT botmem.fail_workspace_device_deletion_notice(
                 $1::uuid, $2::uuid, $3, $4::uuid, $5::timestamptz, $6::timestamptz
               ) AS value`,
        values: [
          input.jobId,
          input.deviceId,
          input.relayId,
          input.leaseToken,
          input.failedAt,
          input.retryAt,
        ],
      });
      const value = result.rows[0]?.value;
      return value === 'pending' || value === 'unreachable' ? value : null;
    });
  }

  private async booleanFunction(
    name: string,
    values: readonly unknown[],
    parameters: string,
  ): Promise<boolean> {
    return transaction(this.pool, 'botmem_api', async (client) => {
      const result = await client.query<BooleanRow>({
        text: `SELECT botmem.${name}(${parameters}) AS value`,
        values,
      });
      return result.rows[0]?.value === true;
    });
  }
}

/**
 * Queue adapter for the existing Stripe-capable commerce reconciler. The
 * lifecycle worker never receives Stripe credentials.
 */
export class PostgresBillingCancellationRepository implements BillingCancellationRepositoryPort {
  constructor(private readonly pool: SqlPoolPort) {}

  async claim(input: {
    readonly workerId: string;
    readonly claimedAt: string;
    readonly leaseExpiresAt: string;
    readonly maxAttempts: number;
  }): Promise<BillingCancellationClaim | null> {
    return transaction(this.pool, 'botmem_commerce', async (client) => {
      const leaseToken = randomUUID();
      const result = await client.query<{
        readonly job_id: string;
        readonly tenant_id: string;
        readonly workspace_id: string;
        readonly stripe_subscription_id: string;
        readonly attempts: number;
        readonly lease_token: string;
      }>({
        text: `SELECT * FROM botmem.claim_workspace_billing_cancellation(
                 $1, $2::uuid, $3::timestamptz, $4::timestamptz, $5::integer
               )`,
        values: [
          input.workerId,
          leaseToken,
          input.claimedAt,
          input.leaseExpiresAt,
          input.maxAttempts,
        ],
      });
      const row = result.rows[0];
      return row
        ? {
            jobId: row.job_id,
            tenantId: row.tenant_id,
            workspaceId: row.workspace_id,
            stripeSubscriptionId: row.stripe_subscription_id,
            attempts: Number(row.attempts),
            leaseToken: row.lease_token,
          }
        : null;
    });
  }

  confirm(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly confirmedAt: string;
    readonly observedStripeStatus: 'canceled';
  }): Promise<boolean> {
    return this.booleanFunction(
      'confirm_workspace_billing_cancellation',
      [
        input.jobId,
        input.workerId,
        input.leaseToken,
        input.confirmedAt,
        input.observedStripeStatus,
      ],
      '$1::uuid, $2, $3::uuid, $4::timestamptz, $5',
    );
  }

  async fail(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly failedAt: string;
    readonly retryAt: string;
    readonly maxAttempts: number;
    readonly failureCode: string;
  }): Promise<'pending' | 'dead' | null> {
    return transaction(this.pool, 'botmem_commerce', async (client) => {
      const result = await client.query<TextRow>({
        text: `SELECT botmem.fail_workspace_billing_cancellation(
                 $1::uuid, $2, $3::uuid, $4::timestamptz, $5::timestamptz,
                 $6::integer, $7
               ) AS value`,
        values: [
          input.jobId,
          input.workerId,
          input.leaseToken,
          input.failedAt,
          input.retryAt,
          input.maxAttempts,
          input.failureCode,
        ],
      });
      const value = result.rows[0]?.value;
      return value === 'pending' || value === 'dead' ? value : null;
    });
  }

  private async booleanFunction(
    name: string,
    values: readonly unknown[],
    parameters: string,
  ): Promise<boolean> {
    return transaction(this.pool, 'botmem_commerce', async (client) => {
      const result = await client.query<BooleanRow>({
        text: `SELECT botmem.${name}(${parameters}) AS value`,
        values,
      });
      return result.rows[0]?.value === true;
    });
  }
}

async function transaction<Result>(
  pool: SqlPoolPort,
  role: 'botmem_api' | 'botmem_commerce' | 'botmem_lifecycle',
  operation: (client: SqlClientPort) => Promise<Result>,
): Promise<Result> {
  const client = await pool.connect();
  let open = false;
  try {
    await client.query({ text: 'BEGIN' });
    open = true;
    await client.query({ text: `SET LOCAL ROLE ${role}` });
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

function setOwnerContext(
  client: SqlClientPort,
  principal: AuthenticatedPrincipal,
): Promise<unknown> {
  return client.query({
    text: `SELECT set_config('botmem.tenant_id', $1, true),
                  set_config('botmem.workspace_id', $2, true),
                  set_config('botmem.user_id', $3, true)`,
    values: [principal.tenantId, principal.workspaceId, principal.userId],
  });
}

function jobView(row: JobViewRow): LifecycleJobView {
  return {
    jobId: row.id,
    kind: row.kind,
    state: row.state,
    requestedAt: iso(row.requested_at),
    attempts: Number(row.attempts),
    availableUntil: row.artifact_expires_at === null ? null : iso(row.artifact_expires_at),
    completedAt: row.completed_at === null ? null : iso(row.completed_at),
    failureCode: row.failure_code,
    localDelete:
      row.kind === 'deletion'
        ? {
            delivered: Number(row.local_delivered),
            unreachable: Number(row.local_unreachable),
            pending: Number(row.local_pending),
          }
        : null,
  };
}

function claim(row: ClaimRow): LifecycleJobClaim {
  return {
    jobId: row.job_id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    requestedByUserId: row.requested_by_user_id,
    kind: row.kind,
    attempts: Number(row.attempts),
    leaseToken: row.lease_token,
  };
}

function exportRecord(row: ExportRow): HostedExportRecord {
  return {
    accountId: row.account_id,
    sourceEventId: row.source_event_id,
    connector: row.connector,
    sourceRevision: row.source_revision,
    kind: row.kind,
    occurredAt: row.occurred_at === null ? null : iso(row.occurred_at),
    observedAt: iso(row.observed_at),
    payload: row.payload,
    tombstone: row.tombstone,
  };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthenticatedPrincipal } from '../identity/domain.js';
import { PostgresRuntimeRoleValidator } from '../projection-worker/postgres-role-health.js';
import { NodePostgresPoolAdapter } from '../search/node-postgres.js';
import { SharedFilesystemLifecycleArtifactStore } from './filesystem-artifact-store.js';
import {
  PostgresLifecycleApiRepository,
  PostgresLifecycleWorkerRepository,
} from './postgres-lifecycle-repository.js';
import { WorkspaceLifecycleService } from './service.js';
import { WorkspaceLifecycleWorker } from './worker.js';

const ADMIN_DATABASE_URL = process.env['BOTMEM_TEST_ADMIN_DATABASE_URL'];
const API_DATABASE_URL = process.env['BOTMEM_TEST_API_DATABASE_URL'];
const LIFECYCLE_DATABASE_URL = process.env['BOTMEM_TEST_LIFECYCLE_DATABASE_URL'];
const enabled = Boolean(ADMIN_DATABASE_URL && API_DATABASE_URL && LIFECYCLE_DATABASE_URL);

const WORKSPACE_ID = 'a1000000-0000-4000-8000-000000000091';
const USER_ID = 'a2000000-0000-4000-8000-000000000091';
const ACCOUNT_ID = 'a3000000-0000-4000-8000-000000000091';
const DEVICE_ID = 'a4000000-0000-4000-8000-000000000091';
const EXPORT_JOB_ID = 'a5000000-0000-4000-8000-000000000091';
const DELETE_JOB_ID = 'a5000000-0000-4000-8000-000000000092';
const OCCURRED_AT = '2026-07-12T10:00:00.000Z';
const STARTED_AT = Date.parse('2026-07-13T10:00:00.000Z');

const principal: AuthenticatedPrincipal = {
  tenantId: WORKSPACE_ID,
  workspaceId: WORKSPACE_ID,
  userId: USER_ID,
  membershipRole: 'owner',
  credentialId: 'a6000000-0000-4000-8000-000000000091',
  credentialKind: 'browser_session',
  scopes: ['browser'],
  expiresAt: '2026-07-20T10:00:00.000Z',
};

describe.skipIf(!enabled)(
  'workspace lifecycle API and exact-role worker on real PostgreSQL',
  () => {
    const admin = new Pool({ connectionString: ADMIN_DATABASE_URL });
    const apiPool = new NodePostgresPoolAdapter({ connectionString: API_DATABASE_URL });
    const lifecyclePool = new NodePostgresPoolAdapter({ connectionString: LIFECYCLE_DATABASE_URL });
    let artifactRoot = '';

    beforeAll(async () => {
      artifactRoot = await mkdtemp(join(tmpdir(), 'botmem-lifecycle-integration-'));
      await cleanupWorkspace(admin);
      await seedWorkspace(admin);
    });

    afterAll(async () => {
      await Promise.allSettled([
        apiPool.close(),
        lifecyclePool.close(),
        admin.end(),
        artifactRoot ? rm(artifactRoot, { recursive: true, force: true }) : Promise.resolve(),
      ]);
    });

    it('exportsIdempotently_thenDeletesHostedState_whileOfflineDeviceNoticeRemainsBestEffort', async () => {
      await expect(
        new PostgresRuntimeRoleValidator().validate(
          lifecyclePool,
          'botmem_lifecycle',
          AbortSignal.timeout(5_000),
        ),
      ).resolves.toBeUndefined();

      let nowMs = Date.now();
      const ids = [EXPORT_JOB_ID, DELETE_JOB_ID];
      const artifacts = new SharedFilesystemLifecycleArtifactStore(
        artifactRoot,
        new Uint8Array(32).fill(91),
        {
          maxArtifactBytes: 1024 * 1024,
          maxWorkspaceBytes: 2 * 1024 * 1024,
          maxGlobalBytes: 4 * 1024 * 1024,
          minimumFreeBytes: 0,
        },
      );
      const service = new WorkspaceLifecycleService(
        new PostgresLifecycleApiRepository(apiPool),
        artifacts,
        {
          uuid: () =>
            ids.shift() ??
            (() => {
              throw new Error('unexpected lifecycle ID');
            })(),
        },
        { nowMs: () => nowMs },
      );
      const worker = new WorkspaceLifecycleWorker(
        new PostgresLifecycleWorkerRepository(lifecyclePool),
        artifacts,
        { nowMs: () => nowMs },
        { event: () => undefined },
        {
          workerId: 'lifecycle.integration',
          exportPageSize: 1,
          exportRetentionMs: 60_000,
        },
      );

      const requested = await service.requestExport(principal);
      expect(requested).toMatchObject({ jobId: EXPORT_JOB_ID, state: 'queued' });
      await expect(worker.runOnce()).resolves.toBe(true);
      expect(await service.list(principal)).toEqual([
        expect.objectContaining({ jobId: EXPORT_JOB_ID, state: 'ready' }),
      ]);

      const opened = await service.openExport(principal, EXPORT_JOB_ID);
      const exportText = await readAll(opened.body);
      expect(exportText).toContain('"contentBoundary":"hosted-only"');
      expect(exportText).toContain('"sourceEventId":"lifecycle-integration-message"');
      expect(exportText).toContain('"body":"Hosted lifecycle integration"');
      expect(exportText).not.toContain('credential_ref');
      const reopened = await service.openExport(principal, EXPORT_JOB_ID);
      expect(await readAll(reopened.body)).toBe(exportText);
      await admin.query(
        `UPDATE botmem.workspace_lifecycle_job
            SET requested_at = clock_timestamp() - interval '2 minutes',
                artifact_expires_at = clock_timestamp() - interval '1 minute'
          WHERE id = $1::uuid`,
        [EXPORT_JOB_ID],
      );
      await expect(
        new PostgresLifecycleApiRepository(apiPool).readExportArtifactKey({
          principal,
          jobId: EXPORT_JOB_ID,
          now: '2000-01-01T00:00:00.000Z',
        }),
      ).resolves.toBeNull();
      const compatibility = await apiPool.connect();
      try {
        await compatibility.query({ text: 'BEGIN' });
        await compatibility.query({ text: 'SET LOCAL ROLE botmem_api' });
        await compatibility.query({
          text: "SELECT set_config('botmem.tenant_id', $1, true)",
          values: [WORKSPACE_ID],
        });
        await compatibility.query({
          text: "SELECT set_config('botmem.workspace_id', $1, true)",
          values: [WORKSPACE_ID],
        });
        await compatibility.query({
          text: "SELECT set_config('botmem.user_id', $1, true)",
          values: [USER_ID],
        });
        const backdated = await compatibility.query<{ readonly artifact_key: string | null }>({
          text: `SELECT botmem.consume_workspace_export_artifact(
                   $1::uuid, $2::uuid, $2::uuid, $3::uuid, $4::timestamptz
                 ) AS artifact_key`,
          values: [EXPORT_JOB_ID, WORKSPACE_ID, USER_ID, '2000-01-01T00:00:00.000Z'],
        });
        expect(backdated.rows[0]?.artifact_key).toBeNull();
        await compatibility.query({ text: 'COMMIT' });
      } finally {
        await compatibility.query({ text: 'ROLLBACK' }).catch(() => undefined);
        compatibility.release();
      }

      nowMs += 10_000;
      const deletion = await service.requestDeletion(principal, `DELETE ${WORKSPACE_ID}`);
      expect(deletion).toMatchObject({ jobId: DELETE_JOB_ID, state: 'queued' });
      await expect(worker.runOnce()).resolves.toBe(true);

      const result = await admin.query<{
        workspace_status: string | null;
        user_exists: boolean;
        event_exists: boolean;
        pending_notice: boolean;
        deletion_completed: boolean;
      }>(
        `SELECT
         (SELECT status FROM botmem.workspace WHERE id = $1::uuid) AS workspace_status,
         EXISTS (SELECT 1 FROM botmem.identity_user WHERE id = $2::uuid) AS user_exists,
         EXISTS (SELECT 1 FROM botmem.ingest_event_revision WHERE tenant_id = $1::uuid) AS event_exists,
         EXISTS (SELECT 1 FROM botmem.workspace_device_deletion_notice
                  WHERE job_id = $3::uuid AND state = 'pending') AS pending_notice,
         EXISTS (SELECT 1 FROM botmem.workspace_lifecycle_job
                  WHERE id = $3::uuid AND state = 'completed') AS deletion_completed`,
        [WORKSPACE_ID, USER_ID, DELETE_JOB_ID],
      );
      expect(result.rows[0]).toEqual({
        workspace_status: 'deleted',
        user_exists: false,
        event_exists: false,
        pending_notice: true,
        deletion_completed: true,
      });
    });
  },
);

async function seedWorkspace(admin: Pool): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO botmem.identity_user
       (id, tenant_id, email, email_lookup_hash, status, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, 'lifecycle-integration@example.com',
             decode(repeat('91', 32), 'hex'), 'active', $3::timestamptz, $3::timestamptz)`,
      [USER_ID, WORKSPACE_ID, new Date(STARTED_AT)],
    );
    await client.query(
      `INSERT INTO botmem.workspace
       (id, tenant_id, display_name, status, created_at, updated_at)
     VALUES ($1::uuid, $1::uuid, 'Lifecycle integration', 'active',
             $2::timestamptz, $2::timestamptz)`,
      [WORKSPACE_ID, new Date(STARTED_AT)],
    );
    await client.query(
      `INSERT INTO botmem.workspace_membership
       (tenant_id, workspace_id, user_id, role, status, created_at, updated_at)
     VALUES ($1::uuid, $1::uuid, $2::uuid, 'owner', 'active',
             $3::timestamptz, $3::timestamptz)`,
      [WORKSPACE_ID, USER_ID, new Date(STARTED_AT)],
    );
    await client.query(
      `INSERT INTO botmem.connector_account
       (id, tenant_id, connector, auth_kind, provider_subject_hash,
        credential_ref, status, aggregate_version, created_at, updated_at)
     VALUES ($2::uuid, $1::uuid, 'gmail', 'oauth2', repeat('9', 64),
             'vault:lifecycle-integration', 'ready', 1, $3::timestamptz, $3::timestamptz)`,
      [WORKSPACE_ID, ACCOUNT_ID, new Date(STARTED_AT)],
    );
    await client.query(
      `INSERT INTO botmem.device_registry
       (id, tenant_id, workspace_id, display_name, key_id, public_key,
        connectors, status, credential_version, created_at, updated_at)
     VALUES ($2::uuid, $1::uuid, $1::uuid, 'Offline integration Mac',
             'lifecycle-integration-key', decode(repeat('91', 32), 'hex'),
             ARRAY['imessage'], 'active', 1, $3::timestamptz, $3::timestamptz)`,
      [WORKSPACE_ID, DEVICE_ID, new Date(STARTED_AT)],
    );
    await client.query(
      `INSERT INTO botmem.ingest_event_revision
       (id, tenant_id, account_id, source_event_id, source_revision, kind,
        occurred_at, observed_at, content_hash, payload, tombstone)
     VALUES ('a7000000-0000-4000-8000-000000000091'::uuid, $1::uuid, $2::uuid,
             'lifecycle-integration-message', 'revision-1', 'email',
             $4::timestamptz, $3::timestamptz, repeat('7', 64),
             '{"subject":"Lifecycle integration","body":"Hosted lifecycle integration"}'::jsonb,
             false)`,
      [WORKSPACE_ID, ACCOUNT_ID, new Date(STARTED_AT), OCCURRED_AT],
    );
    await client.query(
      `INSERT INTO botmem.ingest_event_head
       (tenant_id, account_id, source_event_id, head_revision_id, updated_at)
     VALUES ($1::uuid, $2::uuid, 'lifecycle-integration-message',
             'a7000000-0000-4000-8000-000000000091'::uuid, $3::timestamptz)`,
      [WORKSPACE_ID, ACCOUNT_ID, new Date(STARTED_AT)],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function cleanupWorkspace(admin: Pool): Promise<void> {
  await admin.query(
    'DELETE FROM botmem.workspace_device_deletion_notice WHERE tenant_id = $1::uuid',
    [WORKSPACE_ID],
  );
  await admin.query(
    'DELETE FROM botmem.workspace_billing_cancellation_request WHERE tenant_id = $1::uuid',
    [WORKSPACE_ID],
  );
  await admin.query(
    'DELETE FROM botmem.workspace_deleted_billing_audit WHERE job_id = ANY($1::uuid[])',
    [[EXPORT_JOB_ID, DELETE_JOB_ID]],
  );
  await admin.query('DELETE FROM botmem.workspace_lifecycle_job WHERE tenant_id = $1::uuid', [
    WORKSPACE_ID,
  ]);
  await admin.query('DELETE FROM botmem.ingest_event_head WHERE tenant_id = $1::uuid', [
    WORKSPACE_ID,
  ]);
  await admin.query('ALTER TABLE botmem.ingest_event_revision DISABLE TRIGGER USER');
  try {
    await admin.query('DELETE FROM botmem.ingest_event_revision WHERE tenant_id = $1::uuid', [
      WORKSPACE_ID,
    ]);
  } finally {
    await admin.query('ALTER TABLE botmem.ingest_event_revision ENABLE TRIGGER USER');
  }
  await admin.query('DELETE FROM botmem.device_registry WHERE tenant_id = $1::uuid', [
    WORKSPACE_ID,
  ]);
  await admin.query('DELETE FROM botmem.connector_account WHERE tenant_id = $1::uuid', [
    WORKSPACE_ID,
  ]);
  await admin.query('DELETE FROM botmem.workspace_membership WHERE tenant_id = $1::uuid', [
    WORKSPACE_ID,
  ]);
  await admin.query('DELETE FROM botmem.workspace WHERE tenant_id = $1::uuid', [WORKSPACE_ID]);
  await admin.query('DELETE FROM botmem.identity_user WHERE tenant_id = $1::uuid', [WORKSPACE_ID]);
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let output = '';
  for await (const chunk of stream) output += Buffer.from(chunk).toString('utf8');
  return output;
}

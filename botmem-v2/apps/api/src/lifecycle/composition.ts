import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { PostgresRuntimeRoleValidator } from '../projection-worker/postgres-role-health.js';
import type { ProductionApiExtension, ProductionApiExtensionFactory } from '../production-api.js';
import { NodePostgresPoolAdapter } from '../search/node-postgres.js';
import type { SqlPoolPort } from '../search/postgres-ports.js';
import { registerLifecycleApi } from './api.js';
import { DeviceDeletionNoticeRelay } from './device-notice-relay.js';
import {
  SharedFilesystemLifecycleArtifactStore,
  loadLifecycleArtifactKey,
  type LifecycleArtifactStoreOptions,
} from './filesystem-artifact-store.js';
import {
  PostgresDeviceDeletionNoticeRelayRepository,
  PostgresLifecycleApiRepository,
  PostgresLifecycleWorkerRepository,
} from './postgres-lifecycle-repository.js';
import type { LifecycleClockPort, LifecycleTelemetryPort } from './ports.js';
import { WorkspaceLifecycleService } from './service.js';
import { WorkspaceLifecycleWorker } from './worker.js';

const artifactConfigSchema = z.object({
  LIFECYCLE_ARTIFACT_ROOT: z.string().trim().min(1),
  LIFECYCLE_ARTIFACT_KEY_PATH: z.string().trim().min(1),
  LIFECYCLE_ARTIFACT_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(1024 ** 5)
    .default(5 * 1024 * 1024 * 1024),
  LIFECYCLE_ARTIFACT_WORKSPACE_QUOTA_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(1024 ** 5)
    .optional(),
  LIFECYCLE_ARTIFACT_GLOBAL_QUOTA_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(1024 ** 5)
    .optional(),
  LIFECYCLE_ARTIFACT_MINIMUM_FREE_BYTES: z.coerce
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(1024 * 1024 * 1024),
});

const apiConfigSchema = artifactConfigSchema.extend({
  API_REPLICA_ID: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/u),
  LIFECYCLE_RELAY_ID: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,128}$/u)
    .optional(),
  LIFECYCLE_WORKER_MAXIMUM_AGE_SECONDS: z.coerce.number().int().min(10).max(300).default(60),
});

const workerConfigSchema = artifactConfigSchema.extend({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  LIFECYCLE_DATABASE_URL: z.string().trim().min(1),
  LIFECYCLE_WORKER_ID: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
  LIFECYCLE_DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(20).default(4),
  LIFECYCLE_DATABASE_CONNECT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(30_000)
    .default(5_000),
  LIFECYCLE_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  LIFECYCLE_EXPORT_PAGE_SIZE: z.coerce.number().int().min(1).max(1_000).default(200),
  LIFECYCLE_EXPORT_RETENTION_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(2_678_400)
    .default(86_400),
});

interface ArtifactRuntimeConfig {
  readonly root: string;
  readonly keyFile: string;
  readonly options: LifecycleArtifactStoreOptions;
}

export const lifecycleApiExtensionFactory: ProductionApiExtensionFactory = async (input) => {
  const raw = apiConfigSchema.parse(defined(input.environment));
  const artifactConfig = parseArtifactConfig(raw);
  const artifacts = new SharedFilesystemLifecycleArtifactStore(
    artifactConfig.root,
    await loadLifecycleArtifactKey(artifactConfig.keyFile),
    artifactConfig.options,
  );
  const repository = new PostgresLifecycleApiRepository(input.apiPool);
  const lifecycle = new WorkspaceLifecycleService(
    repository,
    artifacts,
    { uuid: () => randomUUID() },
    { nowMs: () => Date.now() },
  );
  const telemetry = jsonTelemetry('lifecycle_api');
  const relay = new DeviceDeletionNoticeRelay(
    new PostgresDeviceDeletionNoticeRelayRepository(input.apiPool),
    input.deviceDeletionDelivery,
    { nowMs: () => Date.now() },
    telemetry,
    { relayId: raw.LIFECYCLE_RELAY_ID ?? `${raw.API_REPLICA_ID}:lifecycle` },
  );
  const shutdown = new AbortController();
  let relayHealthy = true;
  const relayTask = relay.run(shutdown.signal).catch(() => {
    relayHealthy = false;
  });
  const extension: ProductionApiExtension = {
    registrars: [
      {
        register: (app, _authorizer, credentials) => {
          registerLifecycleApi(app, credentials, lifecycle, {
            allowedOrigins: input.config.trustedOrigins,
          });
        },
      },
    ],
    readinessProbes: [
      {
        name: 'lifecycle',
        isReady: async () =>
          relayHealthy &&
          (await artifacts.readable()) &&
          (await repository.workerReady({
            now: new Date().toISOString(),
            maximumAgeSeconds: raw.LIFECYCLE_WORKER_MAXIMUM_AGE_SECONDS,
          })),
      },
    ],
    close: async () => {
      shutdown.abort('api_shutdown');
      await relayTask;
    },
  };
  return extension;
};

export interface LifecycleWorkerRunnerOptions {
  /** A login with botmem_lifecycle membership only. */
  readonly lifecyclePool: SqlPoolPort;
  readonly artifactRoot: string;
  readonly artifactKey: Uint8Array;
  readonly artifactStore?: LifecycleArtifactStoreOptions;
  readonly workerId: string;
  readonly clock: LifecycleClockPort;
  readonly telemetry: LifecycleTelemetryPort;
  readonly pollIntervalMs?: number;
  readonly exportPageSize?: number;
  readonly exportRetentionMs?: number;
}

export function createLifecycleWorkerRunner(
  options: LifecycleWorkerRunnerOptions,
): WorkspaceLifecycleWorker {
  return new WorkspaceLifecycleWorker(
    new PostgresLifecycleWorkerRepository(options.lifecyclePool),
    new SharedFilesystemLifecycleArtifactStore(
      options.artifactRoot,
      options.artifactKey,
      options.artifactStore,
    ),
    options.clock,
    options.telemetry,
    {
      workerId: options.workerId,
      ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
      ...(options.exportPageSize === undefined ? {} : { exportPageSize: options.exportPageSize }),
      ...(options.exportRetentionMs === undefined
        ? {}
        : { exportRetentionMs: options.exportRetentionMs }),
    },
  );
}

export async function runLifecycleWorkerFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  signal: AbortSignal,
  telemetry: LifecycleTelemetryPort = jsonTelemetry('lifecycle_worker'),
): Promise<void> {
  const raw = workerConfigSchema.parse(defined(environment));
  validateDatabaseUrl(raw.LIFECYCLE_DATABASE_URL, raw.NODE_ENV);
  const artifact = parseArtifactConfig(raw);
  const pool = new NodePostgresPoolAdapter({
    connectionString: raw.LIFECYCLE_DATABASE_URL,
    max: raw.LIFECYCLE_DATABASE_POOL_MAX,
    connectionTimeoutMillis: raw.LIFECYCLE_DATABASE_CONNECT_TIMEOUT_MS,
    application_name: 'botmem-v2-lifecycle-worker',
  });
  try {
    await new PostgresRuntimeRoleValidator(raw.LIFECYCLE_DATABASE_CONNECT_TIMEOUT_MS).validate(
      pool,
      'botmem_lifecycle',
      AbortSignal.timeout(raw.LIFECYCLE_DATABASE_CONNECT_TIMEOUT_MS),
    );
    const runner = createLifecycleWorkerRunner({
      lifecyclePool: pool,
      artifactRoot: artifact.root,
      artifactKey: await loadLifecycleArtifactKey(artifact.keyFile),
      artifactStore: artifact.options,
      workerId: raw.LIFECYCLE_WORKER_ID,
      clock: { nowMs: () => Date.now() },
      telemetry,
      pollIntervalMs: raw.LIFECYCLE_WORKER_POLL_INTERVAL_MS,
      exportPageSize: raw.LIFECYCLE_EXPORT_PAGE_SIZE,
      exportRetentionMs: raw.LIFECYCLE_EXPORT_RETENTION_SECONDS * 1_000,
    });
    if (!(await runner.ready()))
      throw new LifecycleRuntimeConfigError('artifact storage is not ready');
    await runner.run(signal);
  } finally {
    await pool.close();
  }
}

export class LifecycleRuntimeConfigError extends Error {
  override readonly name = 'LifecycleRuntimeConfigError';
}

function parseArtifactConfig(raw: z.infer<typeof artifactConfigSchema>): ArtifactRuntimeConfig {
  if (!isAbsolute(raw.LIFECYCLE_ARTIFACT_ROOT) || !isAbsolute(raw.LIFECYCLE_ARTIFACT_KEY_PATH)) {
    throw new LifecycleRuntimeConfigError(
      'LIFECYCLE_ARTIFACT_ROOT and LIFECYCLE_ARTIFACT_KEY_PATH must be absolute',
    );
  }
  const envelopeBytes = 40;
  const workspaceQuota =
    raw.LIFECYCLE_ARTIFACT_WORKSPACE_QUOTA_BYTES ??
    raw.LIFECYCLE_ARTIFACT_MAX_BYTES + envelopeBytes;
  const globalQuota = raw.LIFECYCLE_ARTIFACT_GLOBAL_QUOTA_BYTES ?? workspaceQuota * 10;
  return {
    root: raw.LIFECYCLE_ARTIFACT_ROOT,
    keyFile: raw.LIFECYCLE_ARTIFACT_KEY_PATH,
    options: {
      maxArtifactBytes: raw.LIFECYCLE_ARTIFACT_MAX_BYTES,
      maxWorkspaceBytes: workspaceQuota,
      maxGlobalBytes: globalQuota,
      minimumFreeBytes: raw.LIFECYCLE_ARTIFACT_MINIMUM_FREE_BYTES,
    },
  };
}

function validateDatabaseUrl(value: string, environment: 'development' | 'test' | 'production') {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new LifecycleRuntimeConfigError('LIFECYCLE_DATABASE_URL must be a valid URL');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new LifecycleRuntimeConfigError('LIFECYCLE_DATABASE_URL must use postgres or postgresql');
  }
  if (environment === 'production') {
    if (['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
      throw new LifecycleRuntimeConfigError(
        'production LIFECYCLE_DATABASE_URL cannot target loopback',
      );
    }
    if (
      !['require', 'verify-ca', 'verify-full'].includes(parsed.searchParams.get('sslmode') ?? '')
    ) {
      throw new LifecycleRuntimeConfigError('production LIFECYCLE_DATABASE_URL must require TLS');
    }
  }
}

function jsonTelemetry(component: string): LifecycleTelemetryPort {
  return {
    event: (event) => {
      process.stdout.write(`${JSON.stringify(lifecycleOperationalEvent(component, event))}\n`);
    },
  };
}

export function lifecycleOperationalEvent(
  component: string,
  event: Parameters<LifecycleTelemetryPort['event']>[0],
) {
  const safeComponent = /^[a-z][a-z0-9_]{0,63}$/u.test(component) ? component : 'lifecycle';
  const code =
    event.code === undefined
      ? undefined
      : /^[A-Z][A-Z0-9_]{0,63}$/u.test(event.code)
        ? event.code
        : 'UNEXPECTED_FAILURE';
  return Object.freeze({
    component: safeComponent,
    event: event.event,
    ...(event.kind ? { kind: event.kind } : {}),
    ...(code ? { code } : {}),
  });
}

function defined(input: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

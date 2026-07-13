import { z } from 'zod';
import {
  composeHostedSyncWorker,
  type HostedSyncTelemetryEvent,
  type HostedSyncTelemetryPort,
} from './connections/index.js';
import { PostgresRuntimeRoleValidator } from './projection-worker/postgres-role-health.js';
import { NodePostgresPoolAdapter } from './search/node-postgres.js';

const syncWorkerSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  WORKER_DATABASE_URL: z.string().trim().min(1),
  WORKER_DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  WORKER_DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5_000),
});

export interface SyncWorkerRuntimeConfig {
  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly databaseConnectTimeoutMs: number;
}

export function parseSyncWorkerRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>>,
): SyncWorkerRuntimeConfig {
  const raw = syncWorkerSchema.parse(defined(environment));
  const database = secretSafeUrl(raw.WORKER_DATABASE_URL, 'WORKER_DATABASE_URL');
  if (database.protocol !== 'postgres:' && database.protocol !== 'postgresql:') {
    throw new SyncWorkerRuntimeConfigError('WORKER_DATABASE_URL must use postgres or postgresql');
  }
  if (raw.NODE_ENV === 'production') {
    if (database.hostname === 'localhost' || database.hostname === '127.0.0.1') {
      throw new SyncWorkerRuntimeConfigError(
        'production WORKER_DATABASE_URL cannot target loopback',
      );
    }
    const sslMode = database.searchParams.get('sslmode');
    if (!['require', 'verify-ca', 'verify-full'].includes(sslMode ?? '')) {
      throw new SyncWorkerRuntimeConfigError(
        'production WORKER_DATABASE_URL must require TLS with sslmode',
      );
    }
  }
  return Object.freeze({
    databaseUrl: raw.WORKER_DATABASE_URL,
    databasePoolMax: raw.WORKER_DATABASE_POOL_MAX,
    databaseConnectTimeoutMs: raw.WORKER_DATABASE_CONNECT_TIMEOUT_MS,
  });
}

/** Runs the worker until cancellation and owns its worker-only database pool. */
export async function runHostedSyncWorkerFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  signal: AbortSignal,
  telemetry: HostedSyncTelemetryPort = new JsonConsoleSyncTelemetry(),
): Promise<void> {
  const config = parseSyncWorkerRuntimeConfig(environment);
  const workerPool = new NodePostgresPoolAdapter({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    connectionTimeoutMillis: config.databaseConnectTimeoutMs,
    application_name: 'botmem-v2-sync-worker',
  });
  try {
    await new PostgresRuntimeRoleValidator(config.databaseConnectTimeoutMs).validate(
      workerPool,
      'botmem_worker',
      AbortSignal.timeout(config.databaseConnectTimeoutMs),
    );
    const composition = composeHostedSyncWorker({ workerPool, telemetry, environment });
    await composition.worker.runForever(signal);
  } finally {
    await workerPool.close();
  }
}

/** Identifier-free structured telemetry; connector type and reason code are bounded enums. */
export class JsonConsoleSyncTelemetry implements HostedSyncTelemetryPort {
  record(event: HostedSyncTelemetryEvent): void {
    console.info(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        component: 'hosted_sync_worker',
        ...event,
      }),
    );
  }
}

export class SyncWorkerRuntimeConfigError extends Error {
  override readonly name = 'SyncWorkerRuntimeConfigError';
}

function secretSafeUrl(value: string, field: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new SyncWorkerRuntimeConfigError(`${field} must be a valid URL`);
  }
}

function defined(input: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

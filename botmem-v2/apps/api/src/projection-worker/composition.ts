import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NodePostgresPoolAdapter } from '../search/node-postgres.js';
import {
  OpenAiEmbeddingProvider,
  type OpenAiEmbeddingOptions,
} from '../search/openai-embedding.js';
import { PostgresHostedProjectionStore } from '../search/postgres-hosted-projection.js';
import { HostedProjectionMaterializer } from './materializer.js';
import type { ProjectionWorkerTelemetryPort, RuntimeDatabaseHealthPort } from './ports.js';
import { PostgresOutboxDispatcher } from './postgres-dispatcher.js';
import { PostgresHostedProjectionInputReader } from './postgres-input.js';
import { PostgresSearchReadinessProbe } from './postgres-readiness-probe.js';
import { PostgresRuntimeRoleValidator, ProjectionDatabaseHealth } from './postgres-role-health.js';
import { ProjectionOutboxWorker } from './worker.js';

const rawConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PROJECTION_WORKER_HOST: z.string().trim().min(1).default('127.0.0.1'),
  PROJECTION_WORKER_PORT: z.coerce.number().int().min(1).max(65_535).default(12_413),
  PROJECTION_WORKER_ID: z.string().regex(/^[A-Za-z0-9._:-]{1,96}$/u),
  DISPATCHER_DATABASE_URL: z.string().trim().min(1),
  WORKER_DATABASE_URL: z.string().trim().min(1),
  PROJECTION_DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(64).default(8),
  PROJECTION_DATABASE_CONNECT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(30_000)
    .default(5_000),
  OPENAI_API_KEY: z.string().trim().min(1),
  OPENAI_EMBED_MODEL: z.string().trim().min(1).default('text-embedding-3-small'),
  OPENAI_EMBED_ENDPOINT: z.string().trim().min(1).default('https://api.openai.com/v1/embeddings'),
  OPENAI_EMBED_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(10_000),
  PROJECTION_BATCH_SIZE: z.coerce.number().int().min(1).max(64).default(16),
  PROJECTION_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
  PROJECTION_POLL_MS: z.coerce.number().int().min(50).max(60_000).default(1_000),
  PROJECTION_LEASE_MS: z.coerce.number().int().min(5_000).max(300_000).default(60_000),
  PROJECTION_TASK_TIMEOUT_MS: z.coerce.number().int().min(100).max(290_000).default(45_000),
  PROJECTION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(8),
  PROJECTION_BACKOFF_BASE_MS: z.coerce.number().int().min(100).max(300_000).default(1_000),
  PROJECTION_BACKOFF_MAX_MS: z.coerce.number().int().min(100).max(3_600_000).default(300_000),
  PROJECTION_REPAIR_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(86_400_000)
    .default(300_000),
  PROJECTION_REPAIR_WORKSPACE_BATCH: z.coerce.number().int().min(1).max(500).default(100),
  PROJECTION_REPAIR_BATCH: z.coerce.number().int().min(1).max(500).default(100),
  PROJECTION_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(20_000),
  PROJECTION_HEALTH_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(2_000),
});

export interface ProjectionWorkerConfig {
  readonly environment: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly workerId: string;
  readonly dispatcherDatabaseUrl: string;
  readonly workerDatabaseUrl: string;
  readonly databasePoolMax: number;
  readonly databaseConnectTimeoutMs: number;
  readonly embedding: OpenAiEmbeddingOptions;
  readonly batchSize: number;
  readonly concurrency: number;
  readonly pollMs: number;
  readonly leaseMs: number;
  readonly taskTimeoutMs: number;
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  readonly repairIntervalMs: number;
  readonly repairWorkspaceBatch: number;
  readonly repairBatch: number;
  readonly shutdownTimeoutMs: number;
  readonly healthTimeoutMs: number;
}

export interface ProjectionWorkerComposition {
  readonly config: ProjectionWorkerConfig;
  readonly worker: ProjectionOutboxWorker;
  readonly databaseHealth: RuntimeDatabaseHealthPort;
  readonly close: () => Promise<void>;
}

export interface RunningProjectionWorker extends ProjectionWorkerComposition {
  readonly app: FastifyInstance;
}

export function parseProjectionWorkerConfig(
  environment: Readonly<Record<string, string | undefined>>,
): ProjectionWorkerConfig {
  const raw = rawConfigSchema.parse(defined(environment));
  const dispatcher = postgresUrl(raw.DISPATCHER_DATABASE_URL, 'DISPATCHER_DATABASE_URL');
  const worker = postgresUrl(raw.WORKER_DATABASE_URL, 'WORKER_DATABASE_URL');
  if (!dispatcher.username || !worker.username || dispatcher.username === worker.username) {
    throw new ProjectionWorkerConfigError('database URLs must use distinct named logins');
  }
  if (!sameDatabaseTarget(dispatcher, worker)) {
    throw new ProjectionWorkerConfigError('database URLs must target the same PostgreSQL database');
  }
  if (raw.NODE_ENV === 'production') {
    validateProductionDatabase(dispatcher, 'DISPATCHER_DATABASE_URL');
    validateProductionDatabase(worker, 'WORKER_DATABASE_URL');
  }
  if (raw.PROJECTION_LEASE_MS < raw.PROJECTION_TASK_TIMEOUT_MS + 5_000) {
    throw new ProjectionWorkerConfigError('projection lease must exceed task timeout by 5000ms');
  }
  if (raw.PROJECTION_BACKOFF_MAX_MS < raw.PROJECTION_BACKOFF_BASE_MS) {
    throw new ProjectionWorkerConfigError('projection maximum backoff is below base backoff');
  }
  return Object.freeze({
    environment: raw.NODE_ENV,
    host: raw.PROJECTION_WORKER_HOST,
    port: raw.PROJECTION_WORKER_PORT,
    workerId: raw.PROJECTION_WORKER_ID,
    dispatcherDatabaseUrl: raw.DISPATCHER_DATABASE_URL,
    workerDatabaseUrl: raw.WORKER_DATABASE_URL,
    databasePoolMax: raw.PROJECTION_DATABASE_POOL_MAX,
    databaseConnectTimeoutMs: raw.PROJECTION_DATABASE_CONNECT_TIMEOUT_MS,
    embedding: Object.freeze({
      apiKey: raw.OPENAI_API_KEY,
      model: raw.OPENAI_EMBED_MODEL,
      endpoint: raw.OPENAI_EMBED_ENDPOINT,
      timeoutMs: raw.OPENAI_EMBED_TIMEOUT_MS,
    }),
    batchSize: raw.PROJECTION_BATCH_SIZE,
    concurrency: raw.PROJECTION_CONCURRENCY,
    pollMs: raw.PROJECTION_POLL_MS,
    leaseMs: raw.PROJECTION_LEASE_MS,
    taskTimeoutMs: raw.PROJECTION_TASK_TIMEOUT_MS,
    maxAttempts: raw.PROJECTION_MAX_ATTEMPTS,
    backoffBaseMs: raw.PROJECTION_BACKOFF_BASE_MS,
    backoffMaxMs: raw.PROJECTION_BACKOFF_MAX_MS,
    repairIntervalMs: raw.PROJECTION_REPAIR_INTERVAL_MS,
    repairWorkspaceBatch: raw.PROJECTION_REPAIR_WORKSPACE_BATCH,
    repairBatch: raw.PROJECTION_REPAIR_BATCH,
    shutdownTimeoutMs: raw.PROJECTION_SHUTDOWN_TIMEOUT_MS,
    healthTimeoutMs: raw.PROJECTION_HEALTH_TIMEOUT_MS,
  });
}

export async function composeProjectionWorker(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly telemetry?: ProjectionWorkerTelemetryPort;
  readonly fetch?: typeof globalThis.fetch;
}): Promise<ProjectionWorkerComposition> {
  const config = parseProjectionWorkerConfig(input.environment);
  const dispatcherPool = new NodePostgresPoolAdapter({
    connectionString: config.dispatcherDatabaseUrl,
    max: Math.max(2, Math.min(config.databasePoolMax, config.concurrency)),
    connectionTimeoutMillis: config.databaseConnectTimeoutMs,
    application_name: 'botmem-v2-projection-dispatcher',
  });
  const workerPool = new NodePostgresPoolAdapter({
    connectionString: config.workerDatabaseUrl,
    max: config.databasePoolMax,
    connectionTimeoutMillis: config.databaseConnectTimeoutMs,
    application_name: 'botmem-v2-projection-worker',
  });
  try {
    const startupSignal = deadlineSignal(config.healthTimeoutMs);
    const validator = new PostgresRuntimeRoleValidator(config.healthTimeoutMs);
    try {
      await validator.validate(dispatcherPool, 'botmem_dispatcher', startupSignal.signal);
      await validator.validate(workerPool, 'botmem_worker', startupSignal.signal);
    } finally {
      startupSignal.dispose();
    }

    const dispatcher = new PostgresOutboxDispatcher(dispatcherPool);
    const inputReader = new PostgresHostedProjectionInputReader(workerPool);
    const store = new PostgresHostedProjectionStore(workerPool);
    const readiness = new PostgresSearchReadinessProbe(workerPool);
    const embeddings = new OpenAiEmbeddingProvider({
      ...config.embedding,
      ...(input.fetch ? { fetch: input.fetch } : {}),
    });
    const clock = { nowMs: () => Date.now() };
    const telemetry = input.telemetry ?? new SanitizedConsoleProjectionTelemetry();
    const materializer = new HostedProjectionMaterializer(
      inputReader,
      embeddings,
      store,
      readiness,
      clock,
    );
    const worker = new ProjectionOutboxWorker(
      dispatcher,
      materializer,
      store,
      telemetry,
      config,
      clock,
    );
    const databaseHealth = new ProjectionDatabaseHealth(dispatcherPool, workerPool);
    let closed = false;
    return Object.freeze({
      config,
      worker,
      databaseHealth,
      close: async () => {
        if (closed) return;
        closed = true;
        await worker.stop();
        await Promise.allSettled([dispatcherPool.close(), workerPool.close()]);
      },
    });
  } catch (error) {
    await Promise.allSettled([dispatcherPool.close(), workerPool.close()]);
    throw error;
  }
}

export async function startProjectionWorkerFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<RunningProjectionWorker> {
  const composition = await composeProjectionWorker({ environment });
  const app = Fastify({ logger: false, bodyLimit: 1_024 });
  app.get('/health/live', async (_request, reply) => reply.code(200).send({ status: 'live' }));
  app.get('/health/ready', async (_request, reply) => {
    if (!composition.worker.isInternallyReady()) {
      return reply.code(503).send({ status: 'not_ready', reason: 'worker_unavailable' });
    }
    const deadline = deadlineSignal(composition.config.healthTimeoutMs);
    try {
      await composition.databaseHealth.probe(deadline.signal);
      return reply.code(200).send({ status: 'ready' });
    } catch {
      return reply.code(503).send({ status: 'not_ready', reason: 'database_unavailable' });
    } finally {
      deadline.dispose();
    }
  });
  app.addHook('onClose', async () => composition.close());
  try {
    composition.worker.start();
    await app.listen({ host: composition.config.host, port: composition.config.port });
    return Object.freeze({ ...composition, app });
  } catch (error) {
    await app.close().catch(() => composition.close());
    throw error;
  }
}

export class SanitizedConsoleProjectionTelemetry implements ProjectionWorkerTelemetryPort {
  event(input: Parameters<ProjectionWorkerTelemetryPort['event']>[0]): void {
    const line = JSON.stringify({ component: 'projection-worker', kind: 'event', ...input });
    if (input.level === 'error') console.error(line);
    else if (input.level === 'warn') console.warn(line);
    else console.info(line);
  }

  metric(input: Parameters<ProjectionWorkerTelemetryPort['metric']>[0]): void {
    console.info(JSON.stringify({ component: 'projection-worker', kind: 'metric', ...input }));
  }
}

export class ProjectionWorkerConfigError extends Error {
  override readonly name = 'ProjectionWorkerConfigError';
}

function defined(input: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function postgresUrl(value: string, field: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ProjectionWorkerConfigError(`${field} must be a valid URL`);
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new ProjectionWorkerConfigError(`${field} must use postgres or postgresql`);
  }
  return parsed;
}

function validateProductionDatabase(database: URL, field: string): void {
  if (database.hostname === 'localhost' || database.hostname === '127.0.0.1') {
    throw new ProjectionWorkerConfigError(`${field} cannot target localhost in production`);
  }
  if (
    !['require', 'verify-ca', 'verify-full'].includes(database.searchParams.get('sslmode') ?? '')
  ) {
    throw new ProjectionWorkerConfigError(`${field} must require TLS in production`);
  }
}

function sameDatabaseTarget(left: URL, right: URL): boolean {
  return (
    left.hostname === right.hostname &&
    effectivePort(left) === effectivePort(right) &&
    left.pathname === right.pathname
  );
}

function effectivePort(database: URL): string {
  return database.port || '5432';
}

function deadlineSignal(timeoutMs: number): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

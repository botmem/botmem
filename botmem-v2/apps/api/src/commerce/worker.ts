import { z } from 'zod';
import { PostgresBillingCancellationRepository } from '../lifecycle/postgres-lifecycle-repository.js';
import { NodePostgresPoolAdapter } from '../search/node-postgres.js';
import type { SqlPoolPort } from '../search/postgres-ports.js';
import {
  BillingCancellationProcessor,
  type BillingCancellationResult,
} from './billing-cancellation-worker.js';
import { PostgresCommerceRepository } from './postgres-commerce-repository.js';
import { PostgresIdentityProvisioner } from './postgres-identity-provisioner.js';
import { CommerceReconciler, type CommerceReconciliationResult } from './reconciler.js';
import { StripeReconciliationHttpClient } from './stripe-client.js';

const workerConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  COMMERCE_DATABASE_URL: z.string().trim().min(1),
  IDENTITY_ADMIN_DATABASE_URL: z.string().trim().min(1),
  STRIPE_RECONCILER_API_KEY: z.string().trim().min(1),
  STRIPE_API_VERSION: z.string().trim().min(1),
  STRIPE_PRICE_ID: z.string().trim().min(1),
  STRIPE_RECONCILER_API_ENDPOINT: z.string().trim().min(1).optional(),
  COMMERCE_RECONCILER_WORKER_ID: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
  COMMERCE_DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(16).default(8),
  IDENTITY_ADMIN_DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(8).default(4),
  COMMERCE_DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5_000),
  COMMERCE_RECONCILER_POLL_MS: z.coerce.number().int().min(50).max(10_000).default(500),
  COMMERCE_RECONCILER_HEARTBEAT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  COMMERCE_RECONCILER_LEASE_MS: z.coerce.number().int().min(5_000).max(300_000).default(60_000),
  COMMERCE_RECONCILER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(12),
  COMMERCE_RECONCILER_BACKOFF_BASE_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  COMMERCE_RECONCILER_BACKOFF_MAX_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(3_600_000)
    .default(300_000),
});

export interface CommerceWorkerTelemetryPort {
  report(event: {
    readonly code:
      | 'commerce_reconciler_started'
      | 'commerce_reconciler_processed'
      | 'commerce_reconciler_ignored'
      | 'commerce_reconciler_retry_scheduled'
      | 'commerce_reconciler_dead_letter'
      | 'commerce_cancellation_processed'
      | 'commerce_cancellation_retry_scheduled'
      | 'commerce_cancellation_dead_letter'
      | 'commerce_reconciler_stopped';
  }): void;
}

export interface CommerceReconcilerRuntime {
  run(signal: AbortSignal): Promise<void>;
  readiness(): Promise<boolean>;
  close(): Promise<void>;
}

/** Standalone worker composition. Never import this from the API process. */
export function composeCommerceReconcilerWorker(
  environment: Readonly<Record<string, string | undefined>>,
  telemetry: CommerceWorkerTelemetryPort = silentTelemetry,
): CommerceReconcilerRuntime {
  const raw = workerConfigSchema.parse({
    NODE_ENV: environment['NODE_ENV'],
    COMMERCE_DATABASE_URL: environment['COMMERCE_DATABASE_URL'],
    IDENTITY_ADMIN_DATABASE_URL: environment['IDENTITY_ADMIN_DATABASE_URL'],
    STRIPE_RECONCILER_API_KEY: environment['STRIPE_RECONCILER_API_KEY'],
    STRIPE_API_VERSION: environment['STRIPE_API_VERSION'],
    STRIPE_PRICE_ID: environment['STRIPE_PRICE_ID'],
    STRIPE_RECONCILER_API_ENDPOINT: environment['STRIPE_RECONCILER_API_ENDPOINT'],
    COMMERCE_RECONCILER_WORKER_ID: environment['COMMERCE_RECONCILER_WORKER_ID'],
    COMMERCE_DATABASE_POOL_MAX: environment['COMMERCE_DATABASE_POOL_MAX'],
    IDENTITY_ADMIN_DATABASE_POOL_MAX: environment['IDENTITY_ADMIN_DATABASE_POOL_MAX'],
    COMMERCE_DATABASE_CONNECT_TIMEOUT_MS: environment['COMMERCE_DATABASE_CONNECT_TIMEOUT_MS'],
    COMMERCE_RECONCILER_POLL_MS: environment['COMMERCE_RECONCILER_POLL_MS'],
    COMMERCE_RECONCILER_HEARTBEAT_MS: environment['COMMERCE_RECONCILER_HEARTBEAT_MS'],
    COMMERCE_RECONCILER_LEASE_MS: environment['COMMERCE_RECONCILER_LEASE_MS'],
    COMMERCE_RECONCILER_MAX_ATTEMPTS: environment['COMMERCE_RECONCILER_MAX_ATTEMPTS'],
    COMMERCE_RECONCILER_BACKOFF_BASE_MS: environment['COMMERCE_RECONCILER_BACKOFF_BASE_MS'],
    COMMERCE_RECONCILER_BACKOFF_MAX_MS: environment['COMMERCE_RECONCILER_BACKOFF_MAX_MS'],
  });
  const commerceDatabase = databaseUrl(
    raw.COMMERCE_DATABASE_URL,
    'COMMERCE_DATABASE_URL',
    raw.NODE_ENV,
  );
  const identityDatabase = databaseUrl(
    raw.IDENTITY_ADMIN_DATABASE_URL,
    'IDENTITY_ADMIN_DATABASE_URL',
    raw.NODE_ENV,
  );
  rejectSharedLogin(commerceDatabase, identityDatabase);
  if (raw.COMMERCE_RECONCILER_BACKOFF_MAX_MS < raw.COMMERCE_RECONCILER_BACKOFF_BASE_MS) {
    throw new CommerceWorkerConfigError(
      'COMMERCE_RECONCILER_BACKOFF_MAX_MS must be at least the base delay',
    );
  }

  const commercePool = new NodePostgresPoolAdapter({
    connectionString: raw.COMMERCE_DATABASE_URL,
    max: raw.COMMERCE_DATABASE_POOL_MAX,
    connectionTimeoutMillis: raw.COMMERCE_DATABASE_CONNECT_TIMEOUT_MS,
    application_name: 'botmem-v2-commerce-reconciler',
  });
  const identityPool = new NodePostgresPoolAdapter({
    connectionString: raw.IDENTITY_ADMIN_DATABASE_URL,
    max: raw.IDENTITY_ADMIN_DATABASE_POOL_MAX,
    connectionTimeoutMillis: raw.COMMERCE_DATABASE_CONNECT_TIMEOUT_MS,
    application_name: 'botmem-v2-identity-provisioner',
  });
  const repository = new PostgresCommerceRepository(commercePool, 'botmem_commerce');
  const provisioner = new PostgresIdentityProvisioner(identityPool);
  const stripe = new StripeReconciliationHttpClient({
    apiKey: raw.STRIPE_RECONCILER_API_KEY,
    apiVersion: raw.STRIPE_API_VERSION,
    ...(raw.STRIPE_RECONCILER_API_ENDPOINT ? { endpoint: raw.STRIPE_RECONCILER_API_ENDPOINT } : {}),
  });
  const reconciler = new CommerceReconciler(
    repository,
    stripe,
    provisioner,
    { nowMs: () => Date.now() },
    {
      priceId: raw.STRIPE_PRICE_ID,
      leaseMs: raw.COMMERCE_RECONCILER_LEASE_MS,
      maxAttempts: raw.COMMERCE_RECONCILER_MAX_ATTEMPTS,
      backoffBaseMs: raw.COMMERCE_RECONCILER_BACKOFF_BASE_MS,
      backoffMaximumMs: raw.COMMERCE_RECONCILER_BACKOFF_MAX_MS,
    },
  );
  const cancellations = new BillingCancellationProcessor(
    new PostgresBillingCancellationRepository(commercePool),
    stripe,
    { nowMs: () => Date.now() },
    {
      leaseMs: raw.COMMERCE_RECONCILER_LEASE_MS,
      maxAttempts: Math.min(20, raw.COMMERCE_RECONCILER_MAX_ATTEMPTS),
      backoffBaseMs: raw.COMMERCE_RECONCILER_BACKOFF_BASE_MS,
      backoffMaximumMs: raw.COMMERCE_RECONCILER_BACKOFF_MAX_MS,
    },
  );
  let closed = false;

  return Object.freeze({
    run: async (signal: AbortSignal) => {
      await assertCommerceLogin(commercePool);
      if (!(await reconciler.readiness())) throw new CommerceWorkerUnavailableError();
      const startedAt = new Date().toISOString();
      let heartbeatDue = 0;
      telemetry.report({ code: 'commerce_reconciler_started' });
      try {
        while (!signal.aborted) {
          if (Date.now() >= heartbeatDue) {
            await reconciler.heartbeat(raw.COMMERCE_RECONCILER_WORKER_ID, startedAt);
            heartbeatDue = Date.now() + raw.COMMERCE_RECONCILER_HEARTBEAT_MS;
          }
          const [result, cancellation] = await Promise.all([
            reconciler.reconcileOne(raw.COMMERCE_RECONCILER_WORKER_ID),
            cancellations.reconcileOne(raw.COMMERCE_RECONCILER_WORKER_ID),
          ]);
          reportResult(telemetry, result);
          reportCancellationResult(telemetry, cancellation);
          if (result === 'idle' && cancellation === 'idle') {
            await abortableDelay(raw.COMMERCE_RECONCILER_POLL_MS, signal);
          }
        }
      } finally {
        telemetry.report({ code: 'commerce_reconciler_stopped' });
      }
    },
    readiness: async () => {
      try {
        await assertCommerceLogin(commercePool);
        return await reconciler.readiness();
      } catch {
        return false;
      }
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await Promise.all([commercePool.close(), identityPool.close()]);
    },
  });
}

export async function startCommerceReconcilerFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  signal: AbortSignal,
  telemetry?: CommerceWorkerTelemetryPort,
): Promise<void> {
  const runtime = composeCommerceReconcilerWorker(environment, telemetry);
  try {
    await runtime.run(signal);
  } finally {
    await runtime.close();
  }
}

async function assertCommerceLogin(pool: SqlPoolPort): Promise<void> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ readonly safe: boolean }>({
      text: `SELECT NOT login.rolsuper
                    AND NOT login.rolbypassrls
                    AND pg_has_role(session_user, 'botmem_commerce', 'SET')
                    AND NOT pg_has_role(session_user, 'botmem_api', 'SET')
                    AND NOT pg_has_role(session_user, 'botmem_identity_admin', 'SET')
                    AND NOT pg_has_role(session_user, 'botmem_lifecycle', 'SET')
                    AND NOT pg_has_role(session_user, 'botmem_worker', 'SET')
                    AND NOT pg_has_role(session_user, 'botmem_dispatcher', 'SET')
                    AND NOT pg_has_role(session_user, 'botmem_migrator', 'SET')
                    AND NOT pg_has_role(session_user, 'botmem_schema_owner', 'SET') AS safe
               FROM pg_roles login
              WHERE login.rolname = session_user`,
    });
    if (result.rows[0]?.safe !== true) throw new UnsafeCommerceLoginError();
  } finally {
    client.release();
  }
}

function reportResult(
  telemetry: CommerceWorkerTelemetryPort,
  result: CommerceReconciliationResult,
): void {
  if (result === 'idle') return;
  telemetry.report({ code: `commerce_reconciler_${result}` });
}

function reportCancellationResult(
  telemetry: CommerceWorkerTelemetryPort,
  result: BillingCancellationResult,
): void {
  if (result === 'idle') return;
  telemetry.report({
    code:
      result === 'processed'
        ? 'commerce_cancellation_processed'
        : result === 'dead_letter'
          ? 'commerce_cancellation_dead_letter'
          : 'commerce_cancellation_retry_scheduled',
  });
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, delayMs);
    function done() {
      clearTimeout(timeout);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

function databaseUrl(value: string, field: string, environment: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CommerceWorkerConfigError(`${field} must be a valid URL`);
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.username) {
    throw new CommerceWorkerConfigError(`${field} must be a PostgreSQL URL with a login`);
  }
  if (environment === 'production') {
    const sslMode = parsed.searchParams.get('sslmode');
    if (!['require', 'verify-ca', 'verify-full'].includes(sslMode ?? '')) {
      throw new CommerceWorkerConfigError(`${field} must require TLS in production`);
    }
  }
  return parsed;
}

function rejectSharedLogin(commerce: URL, identity: URL): void {
  if (commerce.username === identity.username) {
    throw new CommerceWorkerConfigError(
      'IDENTITY_ADMIN_DATABASE_URL must use a login distinct from COMMERCE_DATABASE_URL',
    );
  }
  if (
    commerce.hostname !== identity.hostname ||
    (commerce.port || '5432') !== (identity.port || '5432') ||
    commerce.pathname !== identity.pathname
  ) {
    throw new CommerceWorkerConfigError(
      'commerce and identity-admin URLs must target the same Botmem database',
    );
  }
}

const silentTelemetry: CommerceWorkerTelemetryPort = { report: () => undefined };

export class CommerceWorkerConfigError extends Error {
  override readonly name = 'CommerceWorkerConfigError';
}
export class UnsafeCommerceLoginError extends Error {
  override readonly name = 'UnsafeCommerceLoginError';
}
export class CommerceWorkerUnavailableError extends Error {
  override readonly name = 'CommerceWorkerUnavailableError';
}

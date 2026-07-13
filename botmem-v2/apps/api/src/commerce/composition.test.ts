import { describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../config.js';
import { NodePostgresPoolAdapter } from '../search/node-postgres.js';
import { composeCommerceApiRuntime } from './composition.js';
import { composeCommerceReconcilerWorker } from './worker.js';

describe('commerce process secret boundaries', () => {
  it('API composition reads no reconciler database or Stripe secret', async () => {
    const environment = poison(apiEnvironment(), [
      'COMMERCE_DATABASE_URL',
      'IDENTITY_ADMIN_DATABASE_URL',
      'STRIPE_RECONCILER_API_KEY',
    ]);
    const composition = composeCommerceApiRuntime({
      apiPool: {} as NodePostgresPoolAdapter,
      runtimeConfig: runtimeConfig(),
      environment,
    });
    await expect(composition.close()).resolves.toBeUndefined();
  });

  it('worker composition reads no API session, webhook, OAuth, or vault secret', async () => {
    const environment = poison(workerEnvironment(), [
      'DATABASE_URL',
      'AUTH_TOKEN_PEPPER',
      'STRIPE_CHECKOUT_API_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'GOOGLE_OAUTH_CLIENT_SECRET',
      'MICROSOFT_OAUTH_CLIENT_SECRET',
      'CONNECTOR_VAULT_KEYS',
    ]);
    const worker = composeCommerceReconcilerWorker(environment);
    await expect(worker.close()).resolves.toBeUndefined();
  });

  it('fails closed without Stripe configuration and never echoes a malformed secret', () => {
    expect(() =>
      composeCommerceApiRuntime({
        apiPool: {} as NodePostgresPoolAdapter,
        runtimeConfig: runtimeConfig(),
        environment: {},
      }),
    ).toThrow();
    try {
      composeCommerceApiRuntime({
        apiPool: {} as NodePostgresPoolAdapter,
        runtimeConfig: runtimeConfig(),
        environment: { ...apiEnvironment(), STRIPE_CHECKOUT_API_KEY: 'do-not-echo-this-secret' },
      });
      throw new Error('composition unexpectedly accepted malformed Stripe key');
    } catch (error) {
      expect(String(error)).not.toContain('do-not-echo-this-secret');
    }
  });
});

function apiEnvironment(): Record<string, string> {
  return {
    STRIPE_CHECKOUT_API_KEY: 'rk_test_checkout123456789',
    STRIPE_WEBHOOK_SECRET: 'whsec_commerce123456789',
    STRIPE_API_VERSION: '2026-02-25.clover',
    STRIPE_PRICE_ID: 'price_commerce123456',
    STRIPE_CHECKOUT_SUCCESS_URL:
      'https://app.example.test/signup/complete?session_id={CHECKOUT_SESSION_ID}',
    STRIPE_CHECKOUT_CANCEL_URL: 'https://app.example.test/pricing?checkout=cancelled',
    STRIPE_PORTAL_RETURN_URL: 'https://app.example.test/app',
  };
}

function workerEnvironment(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    COMMERCE_DATABASE_URL: 'postgresql://commerce:test@localhost:5432/botmem',
    IDENTITY_ADMIN_DATABASE_URL: 'postgresql://identity:test@localhost:5432/botmem',
    STRIPE_RECONCILER_API_KEY: 'rk_test_reconcile123456789',
    STRIPE_API_VERSION: '2026-02-25.clover',
    STRIPE_PRICE_ID: 'price_commerce123456',
    COMMERCE_RECONCILER_WORKER_ID: 'commerce.test',
  };
}

function runtimeConfig(): RuntimeConfig {
  return {
    environment: 'test',
    host: '127.0.0.1',
    port: 12_412,
    databaseUrl: 'postgresql://api:test@localhost:5432/botmem',
    publicBaseUrl: 'https://api.example.test',
    publicWebBaseUrl: 'https://app.example.test',
    trustedOrigins: ['https://app.example.test'],
    tokenPepper: new Uint8Array(32).fill(7),
    sessionCookieName: 'botmem_session',
    secureCookies: true,
    sessionTtlMs: 60_000,
    patMaxTtlMs: 60_000,
    databasePoolMax: 4,
    databaseConnectTimeoutMs: 1_000,
  };
}

function poison(
  base: Record<string, string>,
  forbidden: readonly string[],
): Readonly<Record<string, string | undefined>> {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (typeof property === 'string' && forbidden.includes(property)) {
        throw new Error(`forbidden environment access: ${property}`);
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

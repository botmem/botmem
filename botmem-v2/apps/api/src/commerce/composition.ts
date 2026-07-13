import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RuntimeConfig } from '../config.js';
import { NodeTokenSecurity } from '../identity/token-security.js';
import type { ProductionApiExtension, ProductionApiExtensionFactory } from '../production-api.js';
import type { WorkspaceAuthorizer } from '../search-api.js';
import { NodePostgresPoolAdapter } from '../search/node-postgres.js';
import { registerCommerceApi } from './api.js';
import { PostgresCheckoutAbuseGuard } from './checkout-abuse.js';
import { IdentityEmailLookupHasher } from './email-lookup.js';
import { PostgresCommerceRepository } from './postgres-commerce-repository.js';
import { CommerceService } from './service.js';
import { StripeCheckoutHttpClient } from './stripe-client.js';
import { StripeWebhookVerifier } from './stripe-webhook-security.js';

const commerceApiConfigSchema = z.object({
  SALES_ENABLED: z.enum(['true', 'false']).default('false'),
  STRIPE_CHECKOUT_API_KEY: z.string().trim().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().trim().min(1),
  STRIPE_API_VERSION: z.string().trim().min(1),
  STRIPE_PRICE_ID: z.string().trim().min(1),
  STRIPE_CHECKOUT_SUCCESS_URL: z.string().trim().min(1),
  STRIPE_CHECKOUT_CANCEL_URL: z.string().trim().min(1),
  STRIPE_PORTAL_RETURN_URL: z.string().trim().min(1),
  STRIPE_CHECKOUT_API_ENDPOINT: z.string().trim().min(1).optional(),
  COMMERCE_RECONCILER_MAXIMUM_AGE_SECONDS: z.coerce.number().int().min(10).max(300).default(60),
});

export interface CommerceApiRuntimeComposition {
  readonly service: CommerceService;
  register(app: FastifyInstance, authorizer: WorkspaceAuthorizer): Promise<void>;
  entitledWorkspaceAuthorizer(authorizer: WorkspaceAuthorizer): WorkspaceAuthorizer;
  readiness(): Promise<boolean>;
  close(): Promise<void>;
}

/** API composition has no identity-admin URL and no Stripe reconciliation capability. */
export function composeCommerceApiRuntime(input: {
  readonly apiPool: NodePostgresPoolAdapter;
  readonly runtimeConfig: RuntimeConfig;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): CommerceApiRuntimeComposition {
  const raw = commerceApiConfigSchema.parse({
    SALES_ENABLED: input.environment['SALES_ENABLED'],
    STRIPE_CHECKOUT_API_KEY: input.environment['STRIPE_CHECKOUT_API_KEY'],
    STRIPE_WEBHOOK_SECRET: input.environment['STRIPE_WEBHOOK_SECRET'],
    STRIPE_API_VERSION: input.environment['STRIPE_API_VERSION'],
    STRIPE_PRICE_ID: input.environment['STRIPE_PRICE_ID'],
    STRIPE_CHECKOUT_SUCCESS_URL: input.environment['STRIPE_CHECKOUT_SUCCESS_URL'],
    STRIPE_CHECKOUT_CANCEL_URL: input.environment['STRIPE_CHECKOUT_CANCEL_URL'],
    STRIPE_PORTAL_RETURN_URL: input.environment['STRIPE_PORTAL_RETURN_URL'],
    STRIPE_CHECKOUT_API_ENDPOINT: input.environment['STRIPE_CHECKOUT_API_ENDPOINT'],
    COMMERCE_RECONCILER_MAXIMUM_AGE_SECONDS:
      input.environment['COMMERCE_RECONCILER_MAXIMUM_AGE_SECONDS'],
  });
  const successUrl = checkoutSuccessUrl(
    raw.STRIPE_CHECKOUT_SUCCESS_URL,
    input.runtimeConfig.publicWebBaseUrl,
    input.runtimeConfig.environment,
  );
  const cancelUrl = webUrl(
    raw.STRIPE_CHECKOUT_CANCEL_URL,
    'STRIPE_CHECKOUT_CANCEL_URL',
    input.runtimeConfig.publicWebBaseUrl,
    input.runtimeConfig.environment,
  );
  const portalReturnUrl = webUrl(
    raw.STRIPE_PORTAL_RETURN_URL,
    'STRIPE_PORTAL_RETURN_URL',
    input.runtimeConfig.publicWebBaseUrl,
    input.runtimeConfig.environment,
  );
  const repository = new PostgresCommerceRepository(input.apiPool);
  const security = new NodeTokenSecurity(input.runtimeConfig.tokenPepper);
  const service = new CommerceService(
    repository,
    new StripeCheckoutHttpClient({
      apiKey: raw.STRIPE_CHECKOUT_API_KEY,
      apiVersion: raw.STRIPE_API_VERSION,
      ...(raw.STRIPE_CHECKOUT_API_ENDPOINT ? { endpoint: raw.STRIPE_CHECKOUT_API_ENDPOINT } : {}),
    }),
    new IdentityEmailLookupHasher(security),
    { uuid: () => randomUUID() },
    { nowMs: () => Date.now() },
    {
      priceId: raw.STRIPE_PRICE_ID,
      successUrl,
      cancelUrl,
      portalReturnUrl,
      checkoutAvailable: raw.SALES_ENABLED === 'true',
      reconcilerMaximumAgeSeconds: raw.COMMERCE_RECONCILER_MAXIMUM_AGE_SECONDS,
    },
  );
  const webhookVerifier = new StripeWebhookVerifier(raw.STRIPE_WEBHOOK_SECRET);
  const checkoutAbuse = new PostgresCheckoutAbuseGuard(
    input.apiPool,
    security,
    new IdentityEmailLookupHasher(security),
  );

  return Object.freeze({
    service,
    register: async (app: FastifyInstance, authorizer: WorkspaceAuthorizer) => {
      registerCommerceApi(app, {
        commerce: service,
        webhookVerifier,
        workspaceAuthorizer: authorizer,
        allowedOrigins: input.runtimeConfig.trustedOrigins,
        checkoutAbuse,
      });
    },
    entitledWorkspaceAuthorizer: (authorizer: WorkspaceAuthorizer) =>
      service.entitledAuthorizer(authorizer),
    readiness: () => service.readiness(),
    close: async () => undefined,
  });
}

/** Directly consumable extension factory for the production API composition. */
export const commerceApiExtensionFactory: ProductionApiExtensionFactory = (input) => {
  const commerce = composeCommerceApiRuntime({
    apiPool: input.apiPool,
    runtimeConfig: input.config,
    environment: input.environment,
  });
  const extension: ProductionApiExtension = {
    workspaceAuthorizerDecorator: (authorizer) => commerce.entitledWorkspaceAuthorizer(authorizer),
    registrars: [{ register: (app, authorizer) => commerce.register(app, authorizer) }],
    readinessProbes: [{ name: 'commerce_reconciler', isReady: () => commerce.readiness() }],
    close: () => commerce.close(),
  };
  return extension;
};

export class CommerceRuntimeConfigError extends Error {
  override readonly name = 'CommerceRuntimeConfigError';
}

function checkoutSuccessUrl(
  value: string,
  publicWebOrigin: string,
  environment: RuntimeConfig['environment'],
): string {
  const marker = '{CHECKOUT_SESSION_ID}';
  if (value.split(marker).length !== 2) {
    throw new CommerceRuntimeConfigError(
      'STRIPE_CHECKOUT_SUCCESS_URL must contain {CHECKOUT_SESSION_ID} exactly once',
    );
  }
  return webUrl(
    value.replace(marker, 'cs_test_validation123456'),
    'STRIPE_CHECKOUT_SUCCESS_URL',
    publicWebOrigin,
    environment,
  ).replace('cs_test_validation123456', marker);
}

function webUrl(
  value: string,
  field: string,
  publicWebOrigin: string,
  environment: RuntimeConfig['environment'],
): string {
  const parsed = safeUrl(value, field);
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.origin !== publicWebOrigin
  ) {
    throw new CommerceRuntimeConfigError(
      `${field} must be a credential-free URL on PUBLIC_WEB_URL`,
    );
  }
  if (environment === 'production' && parsed.protocol !== 'https:') {
    throw new CommerceRuntimeConfigError(`${field} must use HTTPS in production`);
  }
  return parsed.toString();
}

function safeUrl(value: string, field: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new CommerceRuntimeConfigError(`${field} must be a valid URL`);
  }
}

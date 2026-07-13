import {
  BillingCheckoutRequestSchema,
  StripeCheckoutSessionIdSchema,
  parseWorkspaceId,
} from '@botmem-v2/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import {
  WorkspaceAuthorizationError,
  type WorkspaceAuthorizer,
  type WorkspaceCredentials,
} from '../search-api.js';
import {
  BillingInputError,
  BillingNotFoundError,
  BillingUnavailableError,
  CheckoutUnavailableError,
  CheckoutRateLimitError,
} from './domain.js';
import type { CheckoutAbuseGuardPort } from './checkout-abuse.js';
import { CommerceService } from './service.js';
import { parseStripeEvent } from './stripe-event.js';
import { StripeWebhookRejectedError, StripeWebhookVerifier } from './stripe-webhook-security.js';

export interface CommerceApiDependencies {
  readonly commerce: CommerceService;
  readonly webhookVerifier: StripeWebhookVerifier;
  readonly workspaceAuthorizer: WorkspaceAuthorizer;
  readonly allowedOrigins: readonly string[];
  readonly checkoutAbuse: CheckoutAbuseGuardPort;
}

interface WorkspaceParams {
  readonly workspaceId: string;
}

/** Register inside an encapsulated Fastify plugin so JSON remains raw only here. */
export function registerCommerceApi(
  app: FastifyInstance,
  dependencies: CommerceApiDependencies,
): void {
  const allowedOrigins = new Set(dependencies.allowedOrigins);
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) =>
    done(null, body),
  );

  app.get('/v2/billing/price', async (request, reply) => {
    try {
      reply.header('cache-control', 'public, max-age=300, stale-if-error=3600');
      return reply.code(200).send(await dependencies.commerce.publicPrice());
    } catch (error) {
      return billingError(request, reply, error);
    }
  });

  app.post('/v2/billing/checkout', async (request, reply) => {
    if (!trustedOrigin(request, allowedOrigins)) return forbidden(reply);
    try {
      const body = BillingCheckoutRequestSchema.parse(jsonBody(request.body));
      await dependencies.checkoutAbuse.admit({ email: body.email, clientAddress: request.ip });
      reply.header('cache-control', 'no-store');
      return reply.code(201).send(await dependencies.commerce.createCheckout(body));
    } catch (error) {
      return billingError(request, reply, error);
    }
  });

  app.post('/v2/billing/checkout/status', async (request, reply) => {
    if (!trustedOrigin(request, allowedOrigins)) return forbidden(reply);
    try {
      const { sessionId } = checkoutStatusRequestSchema.parse(jsonBody(request.body));
      reply.header('cache-control', 'no-store');
      return reply.code(200).send(await dependencies.commerce.checkoutStatus(sessionId));
    } catch (error) {
      return billingError(request, reply, error);
    }
  });

  app.post('/v2/billing/webhooks/stripe', async (request, reply) => {
    try {
      const rawBody = Buffer.isBuffer(request.body) ? request.body : null;
      const signature = exactHeader(request.headers['stripe-signature']);
      if (!rawBody) throw new StripeWebhookRejectedError();
      const verified = dependencies.webhookVerifier.verify(rawBody, signature);
      await dependencies.commerce.acceptWebhook(parseStripeEvent(verified));
      return reply.code(200).send({ received: true });
    } catch (error) {
      if (error instanceof StripeWebhookRejectedError || error instanceof ZodError) {
        return reply.code(400).send(apiError('webhook_rejected', 'Webhook rejected'));
      }
      request.log.error({ code: 'stripe_webhook_processing_failed' }, 'Stripe webhook failed');
      return reply.code(503).send(apiError('webhook_unavailable', 'Webhook unavailable'));
    }
  });

  app.get<{ Params: WorkspaceParams }>(
    '/v2/workspaces/:workspaceId/billing',
    async (request, reply) => {
      const workspaceId = await authorize(request, reply, dependencies.workspaceAuthorizer);
      if (!workspaceId) return;
      try {
        reply.header('cache-control', 'no-store');
        return reply.code(200).send(await dependencies.commerce.billingStatus(workspaceId));
      } catch (error) {
        return billingError(request, reply, error);
      }
    },
  );

  app.post<{ Params: WorkspaceParams }>(
    '/v2/workspaces/:workspaceId/billing/portal',
    async (request, reply) => {
      const structured = credentials(request);
      if (structured.authorizationHeader || !structured.cookieHeader) {
        return forbidden(reply);
      }
      const workspaceId = await authorize(
        request,
        reply,
        dependencies.workspaceAuthorizer,
        structured,
      );
      if (!workspaceId) return;
      try {
        reply.header('cache-control', 'no-store');
        return reply.code(201).send(await dependencies.commerce.createPortal(workspaceId));
      } catch (error) {
        return billingError(request, reply, error);
      }
    },
  );
}

const checkoutStatusRequestSchema = z
  .object({
    sessionId: StripeCheckoutSessionIdSchema,
  })
  .strict();

async function authorize(
  request: FastifyRequest<{ Params: WorkspaceParams }>,
  reply: FastifyReply,
  authorizer: WorkspaceAuthorizer,
  presented: WorkspaceCredentials = credentials(request),
): Promise<string | null> {
  try {
    const workspaceId = parseWorkspaceId(request.params.workspaceId);
    const authorized = await authorizer.authorize(workspaceId, presented);
    if (authorized !== workspaceId)
      throw new WorkspaceAuthorizationError(403, 'workspace_forbidden', 'Workspace denied');
    return workspaceId;
  } catch (error) {
    if (error instanceof WorkspaceAuthorizationError) {
      reply.code(error.status).send(apiError(error.code, error.message));
      return null;
    }
    if (error instanceof ZodError) {
      reply.code(400).send(apiError('invalid_workspace_id', 'Workspace ID is invalid'));
      return null;
    }
    request.log.error({ code: 'billing_authorization_failed' }, 'Billing authorization failed');
    reply.code(500).send(apiError('authorization_failed', 'Authorization failed'));
    return null;
  }
}

function billingError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof ZodError || error instanceof BillingInputError) {
    return reply.code(400).send(apiError('invalid_request', 'Request is invalid'));
  }
  if (error instanceof BillingNotFoundError) {
    return reply.code(404).send(apiError('billing_not_found', 'Billing record not found'));
  }
  if (error instanceof CheckoutUnavailableError) {
    return reply.code(409).send(apiError('checkout_unavailable', 'Checkout is not available'));
  }
  if (error instanceof BillingUnavailableError) {
    request.log.error({ code: 'billing_operation_unavailable' }, 'Billing operation unavailable');
    return reply.code(503).send(apiError('billing_unavailable', 'Billing is unavailable'));
  }
  if (error instanceof CheckoutRateLimitError) {
    reply.header('retry-after', String(error.retryAfterSeconds));
    return reply
      .code(429)
      .send(apiError('checkout_rate_limited', 'Checkout temporarily unavailable'));
  }
  request.log.error({ code: 'billing_operation_failed' }, 'Billing operation failed');
  return reply.code(500).send(apiError('billing_failed', 'Billing operation failed'));
}

function jsonBody(body: unknown): unknown {
  if (!Buffer.isBuffer(body) || body.byteLength > 1_048_576) throw new BillingInputError('body');
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new BillingInputError('body');
  }
}

function credentials(request: FastifyRequest): WorkspaceCredentials {
  const authorizationHeader = exactHeader(request.headers.authorization);
  const cookieHeader = exactHeader(request.headers.cookie);
  return {
    ...(authorizationHeader ? { authorizationHeader } : {}),
    ...(cookieHeader ? { cookieHeader } : {}),
  };
}

function exactHeader(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  return value?.length === 1 ? value[0] : undefined;
}

function trustedOrigin(request: FastifyRequest, allowed: ReadonlySet<string>): boolean {
  const origin = exactHeader(request.headers.origin);
  return Boolean(origin && allowed.has(origin));
}

function forbidden(reply: FastifyReply) {
  return reply.code(403).send(apiError('workspace_forbidden', 'Workspace access denied'));
}

function apiError(code: string, message: string) {
  return { error: { code, message } };
}

import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceAuthorizationError } from '../search-api.js';
import { registerCommerceApi } from './api.js';
import { CommerceService } from './service.js';
import { CheckoutRateLimitError, CheckoutUnavailableError } from './domain.js';
import type { CheckoutAbuseGuardPort } from './checkout-abuse.js';
import { StripeWebhookVerifier } from './stripe-webhook-security.js';

const SECRET = 'whsec_commerce_test_secret';
const NOW_MS = Date.parse('2026-07-13T12:00:00.000Z');
const WORKSPACE_ID = '81000000-0000-4000-8000-000000000001';
const SESSION_ID = 'cs_test_commerce123456';
const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('commerce HTTP adapter', () => {
  it('publishes the exact Stripe price with bounded public caching', async () => {
    const commerce = fakeCommerce();
    const response = await build(commerce).inject({ method: 'GET', url: '/v2/billing/price' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=300, stale-if-error=3600');
    expect(response.json()).toEqual({
      version: 2,
      currency: 'usd',
      unitAmountMinor: 1_900,
      interval: 'month',
      intervalCount: 1,
      checkoutAvailable: true,
    });
  });

  it('requires a trusted browser origin and validates the public checkout contract', async () => {
    const commerce = fakeCommerce();
    const app = build(commerce);

    const forbidden = await app.inject({
      method: 'POST',
      url: '/v2/billing/checkout',
      payload: { version: 2, email: 'owner@example.test', workspaceName: 'Mine' },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(commerce.createCheckout).not.toHaveBeenCalled();

    const created = await app.inject({
      method: 'POST',
      url: '/v2/billing/checkout',
      headers: { origin: 'https://app.example.test' },
      payload: { version: 2, email: 'owner@example.test', workspaceName: 'Mine' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    expect(commerce.createCheckout).toHaveBeenCalledWith({
      version: 2,
      email: 'owner@example.test',
      workspaceName: 'Mine',
    });
  });

  it('returns a stable refusal while sales are awaiting legal approval', async () => {
    const commerce = fakeCommerce();
    commerce.createCheckout.mockRejectedValueOnce(new CheckoutUnavailableError());
    const response = await build(commerce).inject({
      method: 'POST',
      url: '/v2/billing/checkout',
      headers: { origin: 'https://app.example.test' },
      payload: { version: 2, email: 'owner@example.test', workspaceName: 'Mine' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: { code: 'checkout_unavailable', message: 'Checkout is not available' },
    });
  });

  it('accepts only a timestamped HMAC over the exact raw Stripe body', async () => {
    const commerce = fakeCommerce();
    const app = build(commerce);
    const body = JSON.stringify({
      id: 'evt_commerce_webhook123456',
      object: 'event',
      type: 'checkout.session.completed',
      created: Math.floor(NOW_MS / 1_000),
      data: {
        object: {
          id: SESSION_ID,
          object: 'checkout.session',
          client_reference_id: WORKSPACE_ID,
          customer: 'cus_commerce123456',
          subscription: 'sub_commerce123456',
        },
      },
    });
    const timestamp = Math.floor(NOW_MS / 1_000);
    const signature = createHmac('sha256', SECRET)
      .update(`${timestamp}.${body}`, 'utf8')
      .digest('hex');

    const accepted = await app.inject({
      method: 'POST',
      url: '/v2/billing/webhooks/stripe',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': `t=${timestamp},v1=${signature}`,
      },
      payload: body,
    });
    expect(accepted.statusCode).toBe(200);
    expect(commerce.acceptWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        supported: true,
        envelope: expect.objectContaining({
          eventId: 'evt_commerce_webhook123456',
          checkoutSessionId: SESSION_ID,
        }),
      }),
    );

    const changed = await app.inject({
      method: 'POST',
      url: '/v2/billing/webhooks/stripe',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': `t=${timestamp},v1=${signature}`,
      },
      payload: `${body} `,
    });
    expect(changed.statusCode).toBe(400);
  });

  it('returns a bounded retry without starting Stripe work when admission is denied', async () => {
    const commerce = fakeCommerce();
    const app = build(commerce, undefined, {
      admit: vi.fn(async () => {
        throw new CheckoutRateLimitError(75);
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v2/billing/checkout',
      headers: { origin: 'https://app.example.test' },
      payload: { version: 2, email: 'owner@example.test', workspaceName: 'Mine' },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('75');
    expect(commerce.createCheckout).not.toHaveBeenCalled();
  });

  it('keeps the Stripe completion capability in a no-store POST body', async () => {
    const commerce = fakeCommerce();
    const app = build(commerce);
    const response = await app.inject({
      method: 'POST',
      url: '/v2/billing/checkout/status',
      headers: { origin: 'https://app.example.test' },
      payload: { sessionId: SESSION_ID },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(commerce.checkoutStatus).toHaveBeenCalledWith(SESSION_ID);
    const leakedPath = await app.inject({
      method: 'GET',
      url: `/v2/billing/checkout/${SESSION_ID}/status`,
    });
    expect(leakedPath.statusCode).toBe(404);
  });

  it('keeps billing recovery behind raw authentication and limits Portal to browser sessions', async () => {
    const commerce = fakeCommerce();
    const authorize = vi.fn(async (_workspace: string, credentials: { cookieHeader?: string }) => {
      if (!credentials.cookieHeader) {
        throw new WorkspaceAuthorizationError(401, 'authentication_required', 'Sign in required');
      }
      return WORKSPACE_ID;
    });
    const app = build(commerce, authorize);

    const billing = await app.inject({
      method: 'GET',
      url: `/v2/workspaces/${WORKSPACE_ID}/billing`,
      headers: { cookie: 'botmem_session=opaque' },
    });
    expect(billing.statusCode).toBe(200);

    const patPortal = await app.inject({
      method: 'POST',
      url: `/v2/workspaces/${WORKSPACE_ID}/billing/portal`,
      headers: { authorization: 'Bearer secret-token' },
    });
    expect(patPortal.statusCode).toBe(403);
    expect(commerce.createPortal).not.toHaveBeenCalled();

    const browserPortal = await app.inject({
      method: 'POST',
      url: `/v2/workspaces/${WORKSPACE_ID}/billing/portal`,
      headers: { cookie: 'botmem_session=opaque' },
    });
    expect(browserPortal.statusCode).toBe(201);
    expect(commerce.createPortal).toHaveBeenCalledWith(WORKSPACE_ID);
  });
});

function build(
  commerce: ReturnType<typeof fakeCommerce>,
  authorize = vi.fn(async () => WORKSPACE_ID),
  checkoutAbuse: CheckoutAbuseGuardPort = { admit: vi.fn(async () => undefined) },
) {
  const app = Fastify({ logger: false });
  apps.push(app);
  app.register(async (billingApp) => {
    registerCommerceApi(billingApp, {
      commerce: commerce as unknown as CommerceService,
      webhookVerifier: new StripeWebhookVerifier(SECRET, () => NOW_MS),
      workspaceAuthorizer: { authorize },
      allowedOrigins: ['https://app.example.test'],
      checkoutAbuse,
    });
  });
  return app;
}

function fakeCommerce() {
  return {
    publicPrice: vi.fn(async () => ({
      version: 2 as const,
      currency: 'usd',
      unitAmountMinor: 1_900,
      interval: 'month' as const,
      intervalCount: 1,
      checkoutAvailable: true as const,
    })),
    createCheckout: vi.fn(async () => ({
      version: 2 as const,
      checkoutUrl: 'https://checkout.stripe.test/session',
      expiresAt: '2026-07-14T12:00:00.000Z',
    })),
    checkoutStatus: vi.fn(async () => ({ version: 2 as const, status: 'pending' as const })),
    acceptWebhook: vi.fn(async () => 'queued' as const),
    billingStatus: vi.fn(async () => ({
      version: 2 as const,
      workspaceId: WORKSPACE_ID,
      subscriptionStatus: 'active' as const,
      entitled: true,
    })),
    createPortal: vi.fn(async () => ({
      version: 2 as const,
      portalUrl: 'https://billing.stripe.test/session',
    })),
  };
}

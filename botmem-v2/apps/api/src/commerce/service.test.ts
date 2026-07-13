import { describe, expect, it, vi } from 'vitest';
import { WorkspaceAuthorizationError } from '../search-api.js';
import { CheckoutUnavailableError, type BillingSignup } from './domain.js';
import type { CommerceRepositoryPort, StripeCheckoutPort } from './ports.js';
import { CommerceService } from './service.js';

const SIGNUP_ID = '81000000-0000-4000-8000-000000000001';
const OWNER_ID = '81000000-0000-4000-8000-000000000002';
const SESSION_ID = 'cs_test_commerce123456';
const PRICE_ID = 'price_commerce123456';

describe('CommerceService API boundary', () => {
  it('returns and caches the exact configured Stripe recurring price', async () => {
    const stripe = new FakeCheckoutStripe();
    const service = build(new MemoryCommerceRepository(), stripe);

    await expect(service.publicPrice()).resolves.toEqual({
      version: 2,
      currency: 'usd',
      unitAmountMinor: 1_900,
      interval: 'month',
      intervalCount: 1,
      checkoutAvailable: true,
    });
    await service.publicPrice();
    expect(stripe.priceReads).toBe(1);
  });

  it('normalizes signup input and uses only the configured checkout port', async () => {
    const repository = new MemoryCommerceRepository();
    const stripe = new FakeCheckoutStripe();
    const service = build(repository, stripe);

    const response = await service.createCheckout({
      version: 2,
      email: '  OWNER@Example.Test ',
      workspaceName: '  My Memory  ',
    });

    expect(response.checkoutUrl).toBe('https://checkout.stripe.test/session');
    expect(repository.signup).toMatchObject({
      signupId: SIGNUP_ID,
      workspaceId: SIGNUP_ID,
      ownerUserId: OWNER_ID,
      email: 'owner@example.test',
      workspaceName: 'My Memory',
      checkoutSessionId: SESSION_ID,
    });
    expect(stripe.checkoutInput).toMatchObject({ priceId: PRICE_ID, signupId: SIGNUP_ID });
  });

  it('publishes and enforces the fail-closed legal review gate', async () => {
    const repository = new MemoryCommerceRepository();
    const stripe = new FakeCheckoutStripe();
    const service = build(repository, stripe, false);

    await expect(service.publicPrice()).resolves.toMatchObject({
      checkoutAvailable: false,
      unavailableReason: 'legal_review_pending',
    });
    await expect(
      service.createCheckout({
        version: 2,
        email: 'owner@example.test',
        workspaceName: 'Mine',
      }),
    ).rejects.toBeInstanceOf(CheckoutUnavailableError);
    expect(repository.signup).toBeUndefined();
    expect(stripe.checkoutInput).toBeUndefined();
  });

  it('durably queues a reduced verified envelope without reconciling inline', async () => {
    const repository = new MemoryCommerceRepository();
    const service = build(repository, new FakeCheckoutStripe());
    const event = {
      supported: true,
      envelope: {
        eventId: 'evt_commerce_intake123456',
        eventType: 'invoice.paid',
        eventCreatedAt: '2026-07-13T12:00:00.000Z',
        objectId: 'in_commerce123456',
        subscriptionId: 'sub_commerce123456',
      },
    } as const;

    await expect(service.acceptWebhook(event)).resolves.toBe('queued');
    await expect(service.acceptWebhook(event)).resolves.toBe('duplicate');
    expect(repository.queued).toHaveLength(1);
  });

  it('denies product authorization while leaving raw billing/login recovery outside the decorator', async () => {
    const repository = new MemoryCommerceRepository();
    const authorizer = build(repository, new FakeCheckoutStripe()).entitledAuthorizer({
      authorize: vi.fn(async () => SIGNUP_ID),
    });
    await expect(
      authorizer.authorize(SIGNUP_ID, { cookieHeader: 'session=value' }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<WorkspaceAuthorizationError>>({
        status: 402,
        code: 'subscription_required',
      }),
    );
  });
});

class FakeCheckoutStripe implements StripeCheckoutPort {
  checkoutInput?: Parameters<StripeCheckoutPort['createSubscriptionCheckout']>[0];
  priceReads = 0;
  async retrievePrice() {
    this.priceReads += 1;
    return {
      version: 2 as const,
      currency: 'usd',
      unitAmountMinor: 1_900,
      interval: 'month' as const,
      intervalCount: 1,
    };
  }
  async createSubscriptionCheckout(
    input: Parameters<StripeCheckoutPort['createSubscriptionCheckout']>[0],
  ) {
    this.checkoutInput = input;
    return {
      sessionId: SESSION_ID,
      url: 'https://checkout.stripe.test/session',
      expiresAt: '2026-07-14T12:00:00.000Z',
    };
  }
  async createBillingPortal() {
    return { url: 'https://billing.stripe.test/session' };
  }
}

class MemoryCommerceRepository implements CommerceRepositoryPort {
  signup?: BillingSignup & { createdAt: string; expiresAt: string };
  readonly queued: string[] = [];
  async createSignup(signup: BillingSignup & { createdAt: string; expiresAt: string }) {
    this.signup = signup;
  }
  async attachCheckout(input: { signupId: string; sessionId: string; expiresAt: string }) {
    if (!this.signup) throw new Error('missing signup');
    this.signup = {
      ...this.signup,
      checkoutSessionId: input.sessionId,
      expiresAt: input.expiresAt,
    };
  }
  async markCheckoutState() {}
  async getCheckoutStatus() {
    return null;
  }
  async getBillingStatus() {
    return null;
  }
  async getStripeCustomer() {
    return null;
  }
  async hasActiveEntitlement() {
    return false;
  }
  async findSignup() {
    return this.signup ?? null;
  }
  async enqueueWebhook(input: Parameters<CommerceRepositoryPort['enqueueWebhook']>[0]) {
    if (this.queued.includes(input.event.envelope.eventId)) return 'duplicate' as const;
    this.queued.push(input.event.envelope.eventId);
    return 'queued' as const;
  }
  async claimWebhook() {
    return null;
  }
  async applySubscription() {}
  async settleWebhook() {}
  async retryWebhook() {}
  async heartbeat() {}
  async reconcilerReady() {
    return true;
  }
  async readiness() {
    return true;
  }
}

function build(
  repository: CommerceRepositoryPort,
  stripe: StripeCheckoutPort,
  checkoutAvailable = true,
) {
  const ids = [SIGNUP_ID, OWNER_ID];
  return new CommerceService(
    repository,
    stripe,
    { hashCanonicalEmail: async () => '1'.repeat(64) },
    { uuid: () => ids.shift() ?? '81000000-0000-4000-8000-000000000099' },
    { nowMs: () => Date.parse('2026-07-13T12:00:00.000Z') },
    {
      priceId: PRICE_ID,
      successUrl: 'https://app.example.test/signup/complete?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'https://app.example.test/pricing?checkout=cancelled',
      portalReturnUrl: 'https://app.example.test/app',
      checkoutAvailable,
    },
  );
}

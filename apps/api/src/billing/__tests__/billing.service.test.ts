import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BillingService } from '../billing.service';
import type { ConfigService } from '../../config/config.service';

// Mock Stripe at module level
vi.mock('stripe', () => {
  const MockStripe = vi.fn().mockImplementation(() => ({
    customers: {
      create: vi.fn().mockResolvedValue({ id: 'cus_test123' }),
    },
    checkout: {
      sessions: {
        create: vi.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/test' }),
      },
    },
    billingPortal: {
      sessions: {
        create: vi.fn().mockResolvedValue({ url: 'https://billing.stripe.com/portal' }),
      },
    },
  }));
  return { default: MockStripe };
});

function createChainDb(results: unknown[][] = []) {
  let callIdx = 0;
  const chain: Record<string, ReturnType<typeof vi.fn>> = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn(() => {
      const val = callIdx < results.length ? results[callIdx] : [];
      callIdx++;
      const p = Promise.resolve(val) as Promise<unknown> & { limit: ReturnType<typeof vi.fn> };
      p.limit = vi.fn(() => Promise.resolve(val));
      return p;
    }),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  };
  return chain;
}

describe('BillingService', () => {
  let service: BillingService;
  let mockDb: ReturnType<typeof createChainDb>;
  let dbService: { db: ReturnType<typeof createChainDb> };
  let config: {
    isSelfHosted: boolean;
    stripeSecretKey: string;
    stripePriceId: string;
    frontendUrl: string;
  };

  describe('cloud mode', () => {
    beforeEach(() => {
      mockDb = createChainDb();
      dbService = { db: mockDb };
      config = {
        isSelfHosted: false,
        stripeSecretKey: 'sk_test_xxx',
        stripePriceId: 'price_test123',
        frontendUrl: 'http://localhost:12412',
      };
      service = new BillingService(
        dbService as unknown as import('../../db/db.service').DbService,
        config as unknown as ConfigService,
      );
    });

    describe('getOrCreateStripeCustomer', () => {
      it('returns existing stripeCustomerId if present', async () => {
        mockDb = createChainDb([[{ stripeCustomerId: 'cus_existing' }]]);
        dbService.db = mockDb;
        service = new BillingService(
          dbService as unknown as import('../../db/db.service').DbService,
          config as unknown as ConfigService,
        );

        const result = await service.getOrCreateStripeCustomer('user-1', 'test@example.com');
        expect(result).toBe('cus_existing');
      });

      it('creates Stripe customer when none exists', async () => {
        mockDb = createChainDb([[{ stripeCustomerId: null }]]);
        dbService.db = mockDb;
        service = new BillingService(
          dbService as unknown as import('../../db/db.service').DbService,
          config as unknown as ConfigService,
        );

        const result = await service.getOrCreateStripeCustomer('user-1', 'test@example.com');
        expect(result).toBe('cus_test123');
        expect(mockDb.update).toHaveBeenCalled();
      });

      it('creates Stripe customer when user has no record', async () => {
        mockDb = createChainDb([[]]);
        dbService.db = mockDb;
        service = new BillingService(
          dbService as unknown as import('../../db/db.service').DbService,
          config as unknown as ConfigService,
        );

        const result = await service.getOrCreateStripeCustomer('user-1', 'test@example.com');
        expect(result).toBe('cus_test123');
      });
    });

    describe('createCheckoutSession', () => {
      it('returns checkout URL', async () => {
        // First call: getOrCreateStripeCustomer select, second: update
        mockDb = createChainDb([[{ stripeCustomerId: 'cus_existing' }]]);
        dbService.db = mockDb;
        service = new BillingService(
          dbService as unknown as import('../../db/db.service').DbService,
          config as unknown as ConfigService,
        );

        const result = await service.createCheckoutSession('user-1', 'test@example.com');
        expect(result).toEqual({ url: 'https://checkout.stripe.com/test' });
      });
    });

    describe('createPortalSession', () => {
      it('returns portal URL when customer exists', async () => {
        mockDb = createChainDb([[{ stripeCustomerId: 'cus_existing' }]]);
        dbService.db = mockDb;
        service = new BillingService(
          dbService as unknown as import('../../db/db.service').DbService,
          config as unknown as ConfigService,
        );

        const result = await service.createPortalSession('user-1');
        expect(result).toEqual({ url: 'https://billing.stripe.com/portal' });
      });

      it('re-creates customer when stripeCustomerId is null', async () => {
        mockDb = createChainDb([[{ stripeCustomerId: null, email: 'test@example.com' }]]);
        dbService.db = mockDb;
        service = new BillingService(
          dbService as unknown as import('../../db/db.service').DbService,
          config as unknown as ConfigService,
        );

        const result = await service.createPortalSession('user-1');
        expect(result).toEqual({ url: 'https://billing.stripe.com/portal' });
      });

      it('throws when user not found', async () => {
        mockDb = createChainDb([[]]);
        dbService.db = mockDb;
        service = new BillingService(
          dbService as unknown as import('../../db/db.service').DbService,
          config as unknown as ConfigService,
        );

        await expect(service.createPortalSession('user-1')).rejects.toThrow('User not found');
      });
    });

    describe('getBillingInfo', () => {
      it('returns pro plan for active subscription', async () => {
        mockDb = createChainDb([
          [{ subscriptionStatus: 'active', subscriptionCurrentPeriodEnd: new Date('2026-04-01') }],
        ]);
        dbService.db = mockDb;
        service = new BillingService(
          dbService as unknown as import('../../db/db.service').DbService,
          config as unknown as ConfigService,
        );

        const info = await service.getBillingInfo('user-1');
        expect(info.plan).toBe('pro');
        expect(info.status).toBe('active');
        expect(info.currentPeriodEnd).toBe('2026-04-01T00:00:00.000Z');
        expect(info.cancelAtPeriodEnd).toBe(false);
      });

      it('returns pro plan for trialing subscription', async () => {
        mockDb = createChainDb([
          [
            {
              subscriptionStatus: 'trialing',
              subscriptionCurrentPeriodEnd: new Date('2026-04-01'),
            },
          ],
        ]);
        dbService.db = mockDb;
        service = new BillingService(
          dbService as unknown as import('../../db/db.service').DbService,
          config as unknown as ConfigService,
        );

        const info = await service.getBillingInfo('user-1');
        expect(info.plan).toBe('pro');
        expect(info.status).toBe('trialing');
      });

      it('returns free plan for canceled subscription', async () => {
        mockDb = createChainDb([
          [{ subscriptionStatus: 'canceled', subscriptionCurrentPeriodEnd: null }],
        ]);
        dbService.db = mockDb;
        service = new BillingService(
          dbService as unknown as import('../../db/db.service').DbService,
          config as unknown as ConfigService,
        );

        const info = await service.getBillingInfo('user-1');
        expect(info.plan).toBe('free');
        expect(info.status).toBe('canceled');
        expect(info.currentPeriodEnd).toBeNull();
      });

      it('returns free plan for past_due subscription', async () => {
        mockDb = createChainDb([
          [{ subscriptionStatus: 'past_due', subscriptionCurrentPeriodEnd: null }],
        ]);
        dbService.db = mockDb;
        service = new BillingService(
          dbService as unknown as import('../../db/db.service').DbService,
          config as unknown as ConfigService,
        );

        const info = await service.getBillingInfo('user-1');
        expect(info.plan).toBe('free');
        expect(info.status).toBe('past_due');
      });

      it('returns free plan when no user found', async () => {
        mockDb = createChainDb([[]]);
        dbService.db = mockDb;
        service = new BillingService(
          dbService as unknown as import('../../db/db.service').DbService,
          config as unknown as ConfigService,
        );

        const info = await service.getBillingInfo('user-1');
        expect(info.plan).toBe('free');
        expect(info.status).toBe('free');
        expect(info.currentPeriodEnd).toBeNull();
      });

      it('returns free when subscriptionStatus is null', async () => {
        mockDb = createChainDb([
          [{ subscriptionStatus: null, subscriptionCurrentPeriodEnd: null }],
        ]);
        dbService.db = mockDb;
        service = new BillingService(
          dbService as unknown as import('../../db/db.service').DbService,
          config as unknown as ConfigService,
        );

        const info = await service.getBillingInfo('user-1');
        expect(info.plan).toBe('free');
        expect(info.status).toBe('free');
      });
    });

    describe('getUserPlan', () => {
      it('returns pro for active user', async () => {
        mockDb = createChainDb([
          [{ subscriptionStatus: 'active', subscriptionCurrentPeriodEnd: new Date() }],
        ]);
        dbService.db = mockDb;
        service = new BillingService(
          dbService as unknown as import('../../db/db.service').DbService,
          config as unknown as ConfigService,
        );

        expect(await service.getUserPlan('user-1')).toBe('pro');
      });

      it('returns free for non-subscribed user', async () => {
        mockDb = createChainDb([[]]);
        dbService.db = mockDb;
        service = new BillingService(
          dbService as unknown as import('../../db/db.service').DbService,
          config as unknown as ConfigService,
        );

        expect(await service.getUserPlan('user-1')).toBe('free');
      });
    });

    describe('isProUser', () => {
      it('returns true for active subscriber', async () => {
        mockDb = createChainDb([
          [{ subscriptionStatus: 'active', subscriptionCurrentPeriodEnd: new Date() }],
        ]);
        dbService.db = mockDb;
        service = new BillingService(
          dbService as unknown as import('../../db/db.service').DbService,
          config as unknown as ConfigService,
        );

        expect(await service.isProUser('user-1')).toBe(true);
      });

      it('returns false for free user', async () => {
        mockDb = createChainDb([[]]);
        dbService.db = mockDb;
        service = new BillingService(
          dbService as unknown as import('../../db/db.service').DbService,
          config as unknown as ConfigService,
        );

        expect(await service.isProUser('user-1')).toBe(false);
      });
    });

    describe('handleWebhookEvent', () => {
      it('handles checkout.session.completed', async () => {
        const event = {
          type: 'checkout.session.completed',
          data: {
            object: {
              client_reference_id: 'user-1',
              customer: 'cus_123',
              subscription: 'sub_123',
            },
          },
        } as unknown as import('stripe').Stripe.Event;

        await service.handleWebhookEvent(event);
        expect(mockDb.update).toHaveBeenCalled();
        expect(mockDb.set).toHaveBeenCalledWith({
          stripeCustomerId: 'cus_123',
          subscriptionId: 'sub_123',
          subscriptionStatus: 'active',
        });
      });

      it('skips checkout.session.completed without client_reference_id', async () => {
        const event = {
          type: 'checkout.session.completed',
          data: { object: { client_reference_id: null, customer: 'cus_123' } },
        } as unknown as import('stripe').Stripe.Event;

        await service.handleWebhookEvent(event);
        expect(mockDb.update).not.toHaveBeenCalled();
      });

      it('handles customer.subscription.updated with active status', async () => {
        const event = {
          type: 'customer.subscription.updated',
          data: {
            object: {
              id: 'sub_123',
              status: 'active',
              customer: 'cus_123',
              current_period_end: 1710000000,
            },
          },
        } as unknown as import('stripe').Stripe.Event;

        await service.handleWebhookEvent(event);
        expect(mockDb.update).toHaveBeenCalled();
        expect(mockDb.set).toHaveBeenCalledWith({
          subscriptionStatus: 'active',
          subscriptionCurrentPeriodEnd: new Date(1710000000 * 1000),
        });
      });

      it('handles customer.subscription.updated with trialing status', async () => {
        const event = {
          type: 'customer.subscription.updated',
          data: {
            object: {
              id: 'sub_123',
              status: 'trialing',
              customer: 'cus_123',
              current_period_end: 1710000000,
            },
          },
        } as unknown as import('stripe').Stripe.Event;

        await service.handleWebhookEvent(event);
        expect(mockDb.set).toHaveBeenCalledWith(
          expect.objectContaining({ subscriptionStatus: 'trialing' }),
        );
      });

      it('handles customer.subscription.updated with past_due status', async () => {
        const event = {
          type: 'customer.subscription.updated',
          data: {
            object: {
              id: 'sub_123',
              status: 'past_due',
              customer: 'cus_123',
              current_period_end: 1710000000,
            },
          },
        } as unknown as import('stripe').Stripe.Event;

        await service.handleWebhookEvent(event);
        expect(mockDb.set).toHaveBeenCalledWith(
          expect.objectContaining({ subscriptionStatus: 'past_due' }),
        );
      });

      it('handles customer.subscription.updated with canceled status', async () => {
        const event = {
          type: 'customer.subscription.updated',
          data: {
            object: {
              id: 'sub_123',
              status: 'canceled',
              customer: 'cus_123',
              current_period_end: 1710000000,
            },
          },
        } as unknown as import('stripe').Stripe.Event;

        await service.handleWebhookEvent(event);
        expect(mockDb.set).toHaveBeenCalledWith(
          expect.objectContaining({ subscriptionStatus: 'canceled' }),
        );
      });

      it('handles customer.subscription.deleted', async () => {
        const event = {
          type: 'customer.subscription.deleted',
          data: {
            object: { id: 'sub_123', customer: 'cus_123' },
          },
        } as unknown as import('stripe').Stripe.Event;

        await service.handleWebhookEvent(event);
        expect(mockDb.set).toHaveBeenCalledWith({
          subscriptionStatus: 'free',
          subscriptionId: null,
          subscriptionCurrentPeriodEnd: null,
        });
      });

      it('handles invoice.payment_failed', async () => {
        const event = {
          type: 'invoice.payment_failed',
          data: {
            object: { customer: 'cus_123' },
          },
        } as unknown as import('stripe').Stripe.Event;

        await service.handleWebhookEvent(event);
        expect(mockDb.set).toHaveBeenCalledWith({ subscriptionStatus: 'past_due' });
      });

      it('skips invoice.payment_failed without customer', async () => {
        const event = {
          type: 'invoice.payment_failed',
          data: { object: { customer: null } },
        } as unknown as import('stripe').Stripe.Event;

        await service.handleWebhookEvent(event);
        expect(mockDb.update).not.toHaveBeenCalled();
      });

      it('handles unknown event type gracefully', async () => {
        const event = {
          type: 'some.unknown.event',
          data: { object: {} },
        } as unknown as import('stripe').Stripe.Event;
        await expect(service.handleWebhookEvent(event)).resolves.toBeUndefined();
      });
    });
  });

  describe('self-hosted mode', () => {
    beforeEach(() => {
      mockDb = createChainDb();
      dbService = { db: mockDb };
      config = {
        isSelfHosted: true,
        stripeSecretKey: '',
        stripePriceId: '',
        frontendUrl: 'http://localhost:12412',
      };
      service = new BillingService(
        dbService as unknown as import('../../db/db.service').DbService,
        config as unknown as ConfigService,
      );
    });

    it('does not initialize Stripe', () => {
      expect((service as unknown as { stripe: unknown }).stripe).toBeNull();
    });

    it('isProUser always returns true', async () => {
      expect(await service.isProUser('any-user')).toBe(true);
      // DB should not have been queried
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });
});

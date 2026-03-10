import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BillingController } from '../billing.controller';
import { BadRequestException } from '@nestjs/common';

vi.mock('stripe', () => {
  const MockStripe = vi.fn().mockImplementation(() => ({
    webhooks: {
      constructEvent: vi.fn(),
    },
  }));
  return { default: MockStripe };
});

describe('BillingController', () => {
  let controller: BillingController;
  let billingService: any;
  let config: any;
  const user = { id: 'user-1', email: 'test@example.com' };

  describe('cloud mode', () => {
    beforeEach(() => {
      billingService = {
        createCheckoutSession: vi.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/test' }),
        createPortalSession: vi.fn().mockResolvedValue({ url: 'https://billing.stripe.com/portal' }),
        getBillingInfo: vi.fn().mockResolvedValue({
          plan: 'pro',
          status: 'active',
          currentPeriodEnd: '2026-04-01T00:00:00.000Z',
          cancelAtPeriodEnd: false,
        }),
        handleWebhookEvent: vi.fn().mockResolvedValue(undefined),
      };
      config = {
        isSelfHosted: false,
        stripeSecretKey: 'sk_test_xxx',
        stripeWebhookSecret: 'whsec_test',
      };
      controller = new BillingController(billingService, config as any);
    });

    describe('POST /checkout', () => {
      it('returns checkout URL', async () => {
        const result = await controller.createCheckout(user);
        expect(result).toEqual({ url: 'https://checkout.stripe.com/test' });
        expect(billingService.createCheckoutSession).toHaveBeenCalledWith('user-1', 'test@example.com');
      });
    });

    describe('POST /portal', () => {
      it('returns portal URL', async () => {
        const result = await controller.createPortal(user);
        expect(result).toEqual({ url: 'https://billing.stripe.com/portal' });
        expect(billingService.createPortalSession).toHaveBeenCalledWith('user-1');
      });
    });

    describe('GET /info', () => {
      it('returns enabled billing info', async () => {
        const result = await controller.getBillingInfo(user);
        expect(result).toEqual({
          enabled: true,
          plan: 'pro',
          status: 'active',
          currentPeriodEnd: '2026-04-01T00:00:00.000Z',
          cancelAtPeriodEnd: false,
        });
      });
    });

    describe('POST /webhook', () => {
      it('verifies signature and processes event', async () => {
        const mockEvent = { type: 'checkout.session.completed', data: { object: {} } };
        const stripe = (controller as any).stripe;
        stripe.webhooks.constructEvent.mockReturnValue(mockEvent);

        const req = { rawBody: Buffer.from('raw') } as any;
        const res = { json: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis() } as any;

        await controller.handleWebhook(req, res, 'sig_test');

        expect(stripe.webhooks.constructEvent).toHaveBeenCalledWith(
          Buffer.from('raw'),
          'sig_test',
          'whsec_test',
        );
        expect(billingService.handleWebhookEvent).toHaveBeenCalledWith(mockEvent);
        expect(res.json).toHaveBeenCalledWith({ received: true });
      });

      it('returns 400 when rawBody is missing', async () => {
        const req = {} as any;
        const res = { json: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis() } as any;

        await controller.handleWebhook(req, res, 'sig_test');

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: 'Raw body not available' });
      });

      it('returns 400 when signature verification fails', async () => {
        const stripe = (controller as any).stripe;
        stripe.webhooks.constructEvent.mockImplementation(() => {
          throw new Error('Invalid signature');
        });

        const req = { rawBody: Buffer.from('raw') } as any;
        const res = { json: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis() } as any;

        await controller.handleWebhook(req, res, 'bad_sig');

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: 'Invalid signature' });
      });
    });
  });

  describe('self-hosted mode', () => {
    beforeEach(() => {
      billingService = {
        createCheckoutSession: vi.fn(),
        createPortalSession: vi.fn(),
        getBillingInfo: vi.fn(),
        handleWebhookEvent: vi.fn(),
      };
      config = {
        isSelfHosted: true,
        stripeSecretKey: '',
        stripeWebhookSecret: '',
      };
      controller = new BillingController(billingService, config as any);
    });

    it('POST /checkout throws BadRequestException', async () => {
      await expect(controller.createCheckout(user)).rejects.toThrow(BadRequestException);
      expect(billingService.createCheckoutSession).not.toHaveBeenCalled();
    });

    it('POST /portal throws BadRequestException', async () => {
      await expect(controller.createPortal(user)).rejects.toThrow(BadRequestException);
      expect(billingService.createPortalSession).not.toHaveBeenCalled();
    });

    it('GET /info returns enabled: false', async () => {
      const result = await controller.getBillingInfo(user);
      expect(result).toEqual({ enabled: false });
      expect(billingService.getBillingInfo).not.toHaveBeenCalled();
    });

    it('POST /webhook returns 400', async () => {
      const req = { rawBody: Buffer.from('raw') } as any;
      const res = { json: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis() } as any;

      await controller.handleWebhook(req, res, 'sig_test');

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Billing not available' });
    });
  });
});

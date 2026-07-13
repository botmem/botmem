import { describe, expect, it } from 'vitest';
import {
  BillingPriceResponseSchema,
  BillingCheckoutStatusResponseSchema,
  BillingStatusResponseSchema,
} from './billing.js';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';

describe('billing contracts', () => {
  it('requires a bounded recurring fixed price', () => {
    expect(
      BillingPriceResponseSchema.parse({
        version: 2,
        currency: 'usd',
        unitAmountMinor: 1_900,
        interval: 'month',
        intervalCount: 1,
        checkoutAvailable: true,
      }),
    ).toMatchObject({ currency: 'usd', unitAmountMinor: 1_900 });
    expect(() =>
      BillingPriceResponseSchema.parse({
        version: 2,
        currency: 'USD',
        unitAmountMinor: 0,
        interval: 'month',
        intervalCount: 1,
        checkoutAvailable: true,
      }),
    ).toThrow();
    expect(
      BillingPriceResponseSchema.parse({
        version: 2,
        currency: 'usd',
        unitAmountMinor: 1_900,
        interval: 'month',
        intervalCount: 1,
        checkoutAvailable: false,
        unavailableReason: 'legal_review_pending',
      }),
    ).toMatchObject({ checkoutAvailable: false });
    expect(() =>
      BillingPriceResponseSchema.parse({
        version: 2,
        currency: 'usd',
        unitAmountMinor: 1_900,
        interval: 'month',
        intervalCount: 1,
        checkoutAvailable: false,
      }),
    ).toThrow();
  });

  it('checkoutStatus_onlyRevealsWorkspaceAfterEntitlementIsActive', () => {
    expect(BillingCheckoutStatusResponseSchema.parse({ version: 2, status: 'pending' })).toEqual({
      version: 2,
      status: 'pending',
    });
    expect(() =>
      BillingCheckoutStatusResponseSchema.parse({
        version: 2,
        status: 'active',
      }),
    ).toThrow();
    expect(
      BillingCheckoutStatusResponseSchema.parse({
        version: 2,
        status: 'active',
        workspaceId: WORKSPACE_ID,
      }),
    ).toMatchObject({ workspaceId: WORKSPACE_ID });
  });

  it('billingStatus_neverEntitlesAnUnpaidStripeState', () => {
    expect(() =>
      BillingStatusResponseSchema.parse({
        version: 2,
        workspaceId: WORKSPACE_ID,
        subscriptionStatus: 'past_due',
        entitled: true,
      }),
    ).toThrow(/active or trialing/u);
  });
});

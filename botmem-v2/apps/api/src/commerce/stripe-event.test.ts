import { describe, expect, it } from 'vitest';
import { parseStripeEvent } from './stripe-event.js';

const SIGNUP_ID = '10000000-0000-4000-8000-000000000001';

describe('parseStripeEvent', () => {
  it('subscriptionEvent_readsTheDurableSignupMetadataWithoutPersistingPayload', () => {
    expect(
      parseStripeEvent({
        id: 'evt_subscription_fixture',
        object: 'event',
        type: 'customer.subscription.updated',
        created: 1_784_284_400,
        data: {
          object: {
            id: 'sub_subscriptionfixture',
            object: 'subscription',
            customer: 'cus_customerfixture',
            metadata: { botmem_signup_id: SIGNUP_ID, ignored: 'not persisted' },
          },
        },
      }),
    ).toMatchObject({
      supported: true,
      envelope: {
        signupId: SIGNUP_ID,
        subscriptionId: 'sub_subscriptionfixture',
      },
    });
  });

  it('unrelatedEvent_isValidButIgnoredWithoutInventingBillingState', () => {
    expect(
      parseStripeEvent({
        id: 'evt_invoice_fixture',
        object: 'event',
        type: 'invoice.created',
        created: 1_784_284_400,
        data: { object: { id: 'in_invoicefixture', object: 'invoice' } },
      }),
    ).toMatchObject({ supported: false, envelope: { eventType: 'invoice.created' } });
  });

  it('invoicePaymentEvent_usesTheCurrentBasilParentSubscriptionShape', () => {
    expect(
      parseStripeEvent({
        id: 'evt_invoice_paidfixture',
        object: 'event',
        type: 'invoice.paid',
        created: 1_784_284_400,
        data: {
          object: {
            id: 'in_invoicepaidfixture',
            object: 'invoice',
            customer: 'cus_customerfixture',
            parent: {
              type: 'subscription_details',
              subscription_details: {
                subscription: 'sub_subscriptionfixture',
                metadata: { botmem_signup_id: SIGNUP_ID },
              },
            },
          },
        },
      }),
    ).toMatchObject({
      supported: true,
      envelope: {
        eventType: 'invoice.paid',
        signupId: SIGNUP_ID,
        subscriptionId: 'sub_subscriptionfixture',
        customerId: 'cus_customerfixture',
      },
    });
  });
});

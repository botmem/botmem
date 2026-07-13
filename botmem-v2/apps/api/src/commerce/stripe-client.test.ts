import { describe, expect, it, vi } from 'vitest';
import { StripeCheckoutHttpClient, StripeReconciliationHttpClient } from './stripe-client.js';

const API_KEY = 'sk_test_123456789_test_fixture';
const SIGNUP_ID = '10000000-0000-4000-8000-000000000001';

describe('StripeHttpClient', () => {
  it('priceRetrieve_requiresTheConfiguredActiveRecurringFixedPrice', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'price_botmempersonal',
          object: 'price',
          active: true,
          type: 'recurring',
          currency: 'usd',
          unit_amount: 1_900,
          recurring: { interval: 'month', interval_count: 1 },
        }),
        { status: 200 },
      ),
    );

    await expect(checkoutClient(fetch).retrievePrice('price_botmempersonal')).resolves.toEqual({
      version: 2,
      currency: 'usd',
      unitAmountMinor: 1_900,
      interval: 'month',
      intervalCount: 1,
    });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      'https://api.stripe.com/v1/prices/price_botmempersonal',
    );
  });

  it('checkout_usesHostedSubscriptionFixedPriceRedirectsMetadataAndIdempotency', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'cs_test_checkoutfixture',
          object: 'checkout.session',
          url: 'https://checkout.stripe.com/c/pay/cs_test_checkoutfixture',
          expires_at: 1_784_370_800,
        }),
        { status: 200 },
      ),
    );
    const client = checkoutClient(fetch);
    await client.createSubscriptionCheckout({
      signupId: SIGNUP_ID,
      email: 'owner@example.com',
      priceId: 'price_botmempersonal',
      successUrl: 'https://app.botmem.example/signup/complete?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'https://app.botmem.example/pricing?checkout=cancelled',
    });

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(init?.headers).toEqual(
      expect.objectContaining({
        'idempotency-key': SIGNUP_ID,
        'stripe-version': '2026-02-25.clover',
      }),
    );
    const body = new URLSearchParams(String(init?.body));
    expect(Object.fromEntries(body)).toMatchObject({
      mode: 'subscription',
      ui_mode: 'hosted',
      client_reference_id: SIGNUP_ID,
      customer_email: 'owner@example.com',
      'line_items[0][price]': 'price_botmempersonal',
      'line_items[0][quantity]': '1',
      'metadata[botmem_signup_id]': SIGNUP_ID,
      'subscription_data[metadata][botmem_signup_id]': SIGNUP_ID,
    });
    expect(String(init?.body)).not.toContain(API_KEY);
  });

  it.each([
    'javascript:alert(document.domain)',
    'data:text/html,<script>alert(1)</script>',
    'http://checkout.stripe.test/session',
    'https://attacker:secret@checkout.stripe.test/session',
  ])('checkout_rejectsAnUnsafeHostedRedirectUrl: %s', async (url) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'cs_test_checkoutfixture',
          object: 'checkout.session',
          url,
          expires_at: 1_784_370_800,
        }),
        { status: 200 },
      ),
    );

    await expect(
      checkoutClient(fetch).createSubscriptionCheckout({
        signupId: SIGNUP_ID,
        email: 'owner@example.com',
        priceId: 'price_botmempersonal',
        successUrl: 'https://app.botmem.example/signup/complete?session_id={CHECKOUT_SESSION_ID}',
        cancelUrl: 'https://app.botmem.example/pricing?checkout=cancelled',
      }),
    ).rejects.toThrow();
  });

  it('subscriptionRetrieve_requiresOneCanonicalSubscriptionItemAndSignupMetadata', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'sub_subscriptionfixture',
          object: 'subscription',
          customer: 'cus_customerfixture',
          status: 'active',
          metadata: { botmem_signup_id: SIGNUP_ID },
          current_period_end: 1_786_963_200,
          items: {
            data: [{ quantity: 1, price: { id: 'price_botmempersonal' } }],
          },
        }),
        { status: 200 },
      ),
    );

    await expect(
      reconciliationClient(fetch).retrieveSubscription('sub_subscriptionfixture'),
    ).resolves.toMatchObject({
      signupId: SIGNUP_ID,
      status: 'active',
      priceId: 'price_botmempersonal',
      quantity: 1,
    });
  });

  it('subscriptionCancel_usesDeleteAndRequiresTheExactCanceledSubscription', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'sub_subscriptionfixture',
          object: 'subscription',
          status: 'canceled',
        }),
        { status: 200 },
      ),
    );

    await expect(
      reconciliationClient(fetch).cancelSubscription('sub_subscriptionfixture'),
    ).resolves.toEqual({
      subscriptionId: 'sub_subscriptionfixture',
      status: 'canceled',
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://api.stripe.com/v1/subscriptions/sub_subscriptionfixture');
    expect(init?.method).toBe('DELETE');
  });

  it('subscriptionCancel_rejectsAProviderResponseForAnotherSubscription', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'sub_anotherfixture',
          object: 'subscription',
          status: 'canceled',
        }),
        { status: 200 },
      ),
    );

    await expect(
      reconciliationClient(fetch).cancelSubscription('sub_subscriptionfixture'),
    ).rejects.toThrow('stripe_subscription_mismatch');
  });
});

function checkoutClient(fetch: typeof globalThis.fetch) {
  return new StripeCheckoutHttpClient({
    apiKey: API_KEY,
    apiVersion: '2026-02-25.clover',
    fetch,
  });
}

function reconciliationClient(fetch: typeof globalThis.fetch) {
  return new StripeReconciliationHttpClient({
    apiKey: API_KEY,
    apiVersion: '2026-02-25.clover',
    fetch,
  });
}

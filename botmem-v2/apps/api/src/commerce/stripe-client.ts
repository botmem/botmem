import {
  StripeCheckoutSessionIdSchema,
  StripeSubscriptionStatusSchema,
} from '@botmem-v2/contracts';
import { z } from 'zod';
import type { StripeSubscriptionSnapshot } from './domain.js';
import type { StripeCheckoutPort, StripeReconciliationPort } from './ports.js';

const HostedRedirectUrlSchema = z
  .string()
  .max(4096)
  .transform((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'invalid hosted redirect URL' });
      return z.NEVER;
    }
    if (url.protocol !== 'https:' || url.username || url.password) {
      context.addIssue({
        code: 'custom',
        message: 'hosted redirect URL must use credential-free HTTPS',
      });
      return z.NEVER;
    }
    return url.toString();
  });

const CheckoutResponseSchema = z
  .object({
    id: StripeCheckoutSessionIdSchema,
    object: z.literal('checkout.session'),
    url: HostedRedirectUrlSchema,
    expires_at: z.number().int().positive(),
  })
  .passthrough();

const PriceResponseSchema = z
  .object({
    id: z.string().regex(/^price_[A-Za-z0-9]{6,255}$/u),
    object: z.literal('price'),
    active: z.literal(true),
    type: z.literal('recurring'),
    currency: z.string().regex(/^[a-z]{3}$/u),
    unit_amount: z.number().int().positive().max(100_000_000),
    recurring: z
      .object({
        interval: z.enum(['day', 'week', 'month', 'year']),
        interval_count: z.number().int().min(1).max(12),
      })
      .passthrough(),
  })
  .passthrough();

const CheckoutRetrieveSchema = z
  .object({
    id: StripeCheckoutSessionIdSchema,
    object: z.literal('checkout.session'),
    client_reference_id: z.string().uuid().nullable().optional(),
    customer: z
      .string()
      .regex(/^cus_[A-Za-z0-9]{6,255}$/u)
      .nullable()
      .optional(),
    subscription: z
      .string()
      .regex(/^sub_[A-Za-z0-9]{6,255}$/u)
      .nullable()
      .optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

const SubscriptionResponseSchema = z
  .object({
    id: z.string().regex(/^sub_[A-Za-z0-9]{6,255}$/u),
    object: z.literal('subscription'),
    customer: z.string().regex(/^cus_[A-Za-z0-9]{6,255}$/u),
    status: StripeSubscriptionStatusSchema,
    metadata: z.record(z.string(), z.string()),
    current_period_end: z.number().int().positive().nullable().optional(),
    items: z
      .object({
        data: z
          .array(
            z
              .object({
                quantity: z.number().int().positive().nullable().optional(),
                current_period_end: z.number().int().positive().nullable().optional(),
                price: z
                  .object({ id: z.string().regex(/^price_[A-Za-z0-9]{6,255}$/u) })
                  .passthrough(),
              })
              .passthrough(),
          )
          .min(1)
          .max(100),
      })
      .passthrough(),
  })
  .passthrough();

const CancellationResponseSchema = z
  .object({
    id: z.string().regex(/^sub_[A-Za-z0-9]{6,255}$/u),
    object: z.literal('subscription'),
    status: z.literal('canceled'),
  })
  .passthrough();

const PortalResponseSchema = z
  .object({
    id: z.string().regex(/^bps_[A-Za-z0-9]{6,255}$/u),
    object: z.literal('billing_portal.session'),
    url: HostedRedirectUrlSchema,
  })
  .passthrough();

export interface StripeHttpClientOptions {
  readonly apiKey: string;
  readonly apiVersion: string;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

/** Restricted API adapter: hosted Checkout creation and Billing Portal only. */
export class StripeCheckoutHttpClient implements StripeCheckoutPort {
  private readonly transport: StripeTransport;

  constructor(options: StripeHttpClientOptions) {
    this.transport = new StripeTransport(options);
  }

  async retrievePrice(priceId: string) {
    if (!/^price_[A-Za-z0-9]{6,255}$/u.test(priceId)) {
      throw new StripeApiError('stripe_price_id_invalid');
    }
    const response = PriceResponseSchema.parse(
      await this.transport.request(`/v1/prices/${encodeURIComponent(priceId)}`, {
        method: 'GET',
      }),
    );
    if (response.id !== priceId) throw new StripeApiError('stripe_price_mismatch');
    return {
      version: 2,
      currency: response.currency,
      unitAmountMinor: response.unit_amount,
      interval: response.recurring.interval,
      intervalCount: response.recurring.interval_count,
    } as const;
  }

  async createSubscriptionCheckout(
    input: Parameters<StripeCheckoutPort['createSubscriptionCheckout']>[0],
  ): Promise<Awaited<ReturnType<StripeCheckoutPort['createSubscriptionCheckout']>>> {
    const body = new URLSearchParams({
      mode: 'subscription',
      ui_mode: 'hosted',
      client_reference_id: input.signupId,
      customer_email: input.email,
      'line_items[0][price]': input.priceId,
      'line_items[0][quantity]': '1',
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      'metadata[botmem_signup_id]': input.signupId,
      'subscription_data[metadata][botmem_signup_id]': input.signupId,
    });
    const response = CheckoutResponseSchema.parse(
      await this.transport.request('/v1/checkout/sessions', {
        method: 'POST',
        body,
        idempotencyKey: input.signupId,
      }),
    );
    return {
      sessionId: response.id,
      url: response.url,
      expiresAt: new Date(response.expires_at * 1_000).toISOString(),
    };
  }

  async createBillingPortal(
    input: Parameters<StripeCheckoutPort['createBillingPortal']>[0],
  ): Promise<{ readonly url: string }> {
    const response = PortalResponseSchema.parse(
      await this.transport.request('/v1/billing_portal/sessions', {
        method: 'POST',
        idempotencyKey: input.idempotencyKey,
        body: new URLSearchParams({
          customer: input.customerId,
          return_url: input.returnUrl,
        }),
      }),
    );
    return { url: response.url };
  }
}

/** Restricted worker adapter: canonical reads plus immediate subscription cancellation. */
export class StripeReconciliationHttpClient implements StripeReconciliationPort {
  private readonly transport: StripeTransport;

  constructor(options: StripeHttpClientOptions) {
    this.transport = new StripeTransport(options);
  }

  async retrieveCheckoutSession(
    sessionId: string,
  ): Promise<Awaited<ReturnType<StripeReconciliationPort['retrieveCheckoutSession']>>> {
    const id = StripeCheckoutSessionIdSchema.parse(sessionId);
    const response = CheckoutRetrieveSchema.parse(
      await this.transport.request(`/v1/checkout/sessions/${encodeURIComponent(id)}`, {
        method: 'GET',
      }),
    );
    const signupId = response.client_reference_id ?? response.metadata?.['botmem_signup_id'];
    return {
      sessionId: response.id,
      ...(signupId ? { signupId } : {}),
      ...(response.subscription ? { subscriptionId: response.subscription } : {}),
      ...(response.customer ? { customerId: response.customer } : {}),
    };
  }

  async retrieveSubscription(subscriptionId: string): Promise<StripeSubscriptionSnapshot> {
    if (!/^sub_[A-Za-z0-9]{6,255}$/u.test(subscriptionId)) {
      throw new StripeApiError('stripe_subscription_id_invalid');
    }
    const response = SubscriptionResponseSchema.parse(
      await this.transport.request(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        method: 'GET',
      }),
    );
    if (response.items.data.length !== 1) {
      throw new StripeApiError('stripe_subscription_items_invalid');
    }
    const item = response.items.data[0];
    const signupId = response.metadata['botmem_signup_id'];
    if (!item || !signupId || !/^[-0-9a-f]{36}$/iu.test(signupId)) {
      throw new StripeApiError('stripe_subscription_metadata_invalid');
    }
    const periodEnd = response.current_period_end ?? item.current_period_end;
    return {
      subscriptionId: response.id,
      customerId: response.customer,
      signupId,
      status: response.status,
      priceId: item.price.id,
      quantity: item.quantity ?? 1,
      ...(periodEnd ? { currentPeriodEnd: new Date(periodEnd * 1_000).toISOString() } : {}),
    };
  }

  async cancelSubscription(subscriptionId: string): Promise<{
    readonly subscriptionId: string;
    readonly status: 'canceled';
  }> {
    if (!/^sub_[A-Za-z0-9]{6,255}$/u.test(subscriptionId)) {
      throw new StripeApiError('stripe_subscription_id_invalid');
    }
    const response = CancellationResponseSchema.parse(
      await this.transport.request(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        method: 'DELETE',
      }),
    );
    if (response.id !== subscriptionId) {
      throw new StripeApiError('stripe_subscription_mismatch');
    }
    return { subscriptionId: response.id, status: response.status };
  }
}

class StripeTransport {
  private readonly apiKey: string;
  private readonly apiVersion: string;
  private readonly endpoint: URL;
  private readonly timeoutMs: number;
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: StripeHttpClientOptions) {
    this.apiKey = options.apiKey.trim();
    this.apiVersion = options.apiVersion.trim();
    this.endpoint = new URL(options.endpoint ?? 'https://api.stripe.com');
    this.timeoutMs = options.timeoutMs ?? 10_000;
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    if (!fetchImplementation) throw new Error('global fetch is unavailable');
    this.fetch = fetchImplementation.bind(globalThis);
    if (!/^(?:sk|rk)_(?:test|live)_[A-Za-z0-9_]{8,}$/u.test(this.apiKey)) {
      throw new Error('Stripe server API key is malformed');
    }
    if (!/^\d{4}-\d{2}-\d{2}(?:\.[a-z]+)?$/u.test(this.apiVersion)) {
      throw new Error('Stripe API version is malformed');
    }
    if (
      this.endpoint.username ||
      this.endpoint.password ||
      this.endpoint.pathname !== '/' ||
      this.endpoint.search ||
      this.endpoint.hash ||
      (this.endpoint.protocol !== 'https:' &&
        this.endpoint.hostname !== '127.0.0.1' &&
        this.endpoint.hostname !== 'localhost')
    ) {
      throw new Error('Stripe API endpoint must be a credential-free HTTPS origin');
    }
    if (this.timeoutMs < 100 || this.timeoutMs > 30_000) {
      throw new RangeError('Stripe timeout must be between 100 and 30000 milliseconds');
    }
  }

  async request(
    path: string,
    input: {
      readonly method: 'DELETE' | 'GET' | 'POST';
      readonly body?: URLSearchParams;
      readonly idempotencyKey?: string;
    },
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(new URL(path, this.endpoint), {
        method: input.method,
        headers: {
          accept: 'application/json',
          authorization: `Basic ${Buffer.from(`${this.apiKey}:`, 'utf8').toString('base64')}`,
          'stripe-version': this.apiVersion,
          ...(input.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...(input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : {}),
        },
        ...(input.body ? { body: input.body.toString() } : {}),
        signal: controller.signal,
      });
      if (!response.ok) throw new StripeApiError('stripe_api_rejected');
      return await response.json();
    } catch (error) {
      if (error instanceof StripeApiError) throw error;
      throw new StripeApiError(
        controller.signal.aborted ? 'stripe_api_timeout' : 'stripe_api_unavailable',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class StripeApiError extends Error {
  override readonly name = 'StripeApiError';
  constructor(readonly code: string) {
    super(code);
  }
}

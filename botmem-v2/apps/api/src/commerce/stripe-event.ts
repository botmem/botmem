import { z } from 'zod';
import type { StripeWebhookEnvelope } from './domain.js';

const StripeIdSchema = z.string().regex(/^[a-z]+_[A-Za-z0-9_]{6,255}$/u);
const SignupIdSchema = z.string().uuid();
const MetadataSchema = z.record(z.string(), z.string()).default({});

const EventSchema = z
  .object({
    id: z.string().regex(/^evt_[A-Za-z0-9_]{6,255}$/u),
    object: z.literal('event'),
    type: z.string().min(1).max(256),
    created: z.number().int().positive(),
    data: z
      .object({
        object: z.object({ id: StripeIdSchema }).passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

const CheckoutObjectSchema = z
  .object({
    id: z.string().regex(/^cs_(?:test_|live_)?[A-Za-z0-9]{6,255}$/u),
    object: z.literal('checkout.session'),
    client_reference_id: SignupIdSchema.nullable().optional(),
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
    metadata: MetadataSchema.optional(),
  })
  .passthrough();

const SubscriptionObjectSchema = z
  .object({
    id: z.string().regex(/^sub_[A-Za-z0-9]{6,255}$/u),
    object: z.literal('subscription'),
    customer: z.string().regex(/^cus_[A-Za-z0-9]{6,255}$/u),
    metadata: MetadataSchema.optional(),
  })
  .passthrough();

const InvoiceObjectSchema = z
  .object({
    id: z.string().regex(/^in_[A-Za-z0-9]{6,255}$/u),
    object: z.literal('invoice'),
    customer: z
      .string()
      .regex(/^cus_[A-Za-z0-9]{6,255}$/u)
      .nullable()
      .optional(),
    parent: z
      .object({
        type: z.string(),
        subscription_details: z
          .object({
            subscription: z.string().regex(/^sub_[A-Za-z0-9]{6,255}$/u),
            metadata: MetadataSchema.optional(),
          })
          .nullable()
          .optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

const CHECKOUT_EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
]);
const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
]);
const INVOICE_EVENTS = new Set(['invoice.paid', 'invoice.payment_failed']);

export interface ParsedStripeEvent {
  readonly envelope: StripeWebhookEnvelope;
  readonly supported: boolean;
}

/** Reduces a verified Stripe Event to the non-sensitive fields required for reconciliation. */
export function parseStripeEvent(value: unknown): ParsedStripeEvent {
  const event = EventSchema.parse(value);
  const eventCreatedAt = new Date(event.created * 1_000).toISOString();
  if (CHECKOUT_EVENTS.has(event.type)) {
    const object = CheckoutObjectSchema.parse(event.data.object);
    const signupId = object.client_reference_id ?? object.metadata?.['botmem_signup_id'];
    return {
      supported: true,
      envelope: {
        eventId: event.id,
        eventType: event.type,
        eventCreatedAt,
        objectId: object.id,
        checkoutSessionId: object.id,
        ...(signupId ? { signupId: SignupIdSchema.parse(signupId) } : {}),
        ...(object.subscription ? { subscriptionId: object.subscription } : {}),
        ...(object.customer ? { customerId: object.customer } : {}),
      },
    };
  }
  if (SUBSCRIPTION_EVENTS.has(event.type)) {
    const object = SubscriptionObjectSchema.parse(event.data.object);
    const signupId = object.metadata?.['botmem_signup_id'];
    return {
      supported: true,
      envelope: {
        eventId: event.id,
        eventType: event.type,
        eventCreatedAt,
        objectId: object.id,
        subscriptionId: object.id,
        customerId: object.customer,
        ...(signupId ? { signupId: SignupIdSchema.parse(signupId) } : {}),
      },
    };
  }
  if (INVOICE_EVENTS.has(event.type)) {
    const object = InvoiceObjectSchema.parse(event.data.object);
    const details =
      object.parent?.type === 'subscription_details'
        ? object.parent.subscription_details
        : undefined;
    const signupId = details?.metadata?.['botmem_signup_id'];
    return {
      supported: true,
      envelope: {
        eventId: event.id,
        eventType: event.type,
        eventCreatedAt,
        objectId: object.id,
        ...(details?.subscription ? { subscriptionId: details.subscription } : {}),
        ...(object.customer ? { customerId: object.customer } : {}),
        ...(signupId ? { signupId: SignupIdSchema.parse(signupId) } : {}),
      },
    };
  }
  return {
    supported: false,
    envelope: {
      eventId: event.id,
      eventType: event.type,
      eventCreatedAt,
      objectId: event.data.object.id,
    },
  };
}

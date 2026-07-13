import { z } from 'zod';
import { WorkspaceIdSchema } from './identity.js';

export const StripeCheckoutSessionIdSchema = z
  .string()
  .regex(/^cs_(?:test_|live_)?[A-Za-z0-9]{8,255}$/u);

export const BillingCheckoutRequestSchema = z
  .object({
    version: z.literal(2),
    email: z.string().trim().email().max(320),
    workspaceName: z.string().trim().min(1).max(128),
  })
  .strict();

export const BillingCheckoutResponseSchema = z
  .object({
    version: z.literal(2),
    checkoutUrl: z.string().url().max(4096),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

const BillingPriceFields = {
  version: z.literal(2),
  currency: z.string().regex(/^[a-z]{3}$/u),
  unitAmountMinor: z.number().int().positive().max(100_000_000),
  interval: z.enum(['day', 'week', 'month', 'year']),
  intervalCount: z.number().int().min(1).max(12),
} as const;

export const BillingPriceResponseSchema = z.discriminatedUnion('checkoutAvailable', [
  z
    .object({
      ...BillingPriceFields,
      checkoutAvailable: z.literal(true),
    })
    .strict(),
  z
    .object({
      ...BillingPriceFields,
      checkoutAvailable: z.literal(false),
      unavailableReason: z.literal('legal_review_pending'),
    })
    .strict(),
]);

const PendingCheckoutStatusSchema = z
  .object({
    version: z.literal(2),
    status: z.enum(['pending', 'inactive', 'expired', 'failed']),
  })
  .strict();

const ActiveCheckoutStatusSchema = z
  .object({
    version: z.literal(2),
    status: z.literal('active'),
    workspaceId: WorkspaceIdSchema,
  })
  .strict();

export const BillingCheckoutStatusResponseSchema = z.discriminatedUnion('status', [
  PendingCheckoutStatusSchema,
  ActiveCheckoutStatusSchema,
]);

export const StripeSubscriptionStatusSchema = z.enum([
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
]);

export const BillingStatusResponseSchema = z
  .object({
    version: z.literal(2),
    workspaceId: WorkspaceIdSchema,
    subscriptionStatus: StripeSubscriptionStatusSchema,
    entitled: z.boolean(),
    currentPeriodEnd: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const active = value.subscriptionStatus === 'active' || value.subscriptionStatus === 'trialing';
    if (value.entitled && !active) {
      context.addIssue({
        code: 'custom',
        path: ['entitled'],
        message: 'only active or trialing subscriptions can be entitled',
      });
    }
  });

export const BillingPortalResponseSchema = z
  .object({
    version: z.literal(2),
    portalUrl: z.string().url().max(4096),
  })
  .strict();

export type BillingCheckoutRequest = z.infer<typeof BillingCheckoutRequestSchema>;
export type BillingCheckoutResponse = z.infer<typeof BillingCheckoutResponseSchema>;
export type BillingPriceResponse = z.infer<typeof BillingPriceResponseSchema>;
export type BillingCheckoutStatusResponse = z.infer<typeof BillingCheckoutStatusResponseSchema>;
export type StripeSubscriptionStatus = z.infer<typeof StripeSubscriptionStatusSchema>;
export type BillingStatusResponse = z.infer<typeof BillingStatusResponseSchema>;
export type BillingPortalResponse = z.infer<typeof BillingPortalResponseSchema>;

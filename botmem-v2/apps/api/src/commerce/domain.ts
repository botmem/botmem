import type { StripeSubscriptionStatus } from '@botmem-v2/contracts';

export interface BillingSignup {
  readonly signupId: string;
  readonly workspaceId: string;
  readonly ownerUserId: string;
  readonly email: string;
  readonly emailLookupHashHex: string;
  readonly workspaceName: string;
  readonly checkoutSessionId?: string;
}

export interface StripeSubscriptionSnapshot {
  readonly subscriptionId: string;
  readonly customerId: string;
  readonly signupId: string;
  readonly status: StripeSubscriptionStatus;
  readonly priceId: string;
  readonly quantity: number;
  readonly currentPeriodEnd?: string;
}

export interface StripeWebhookEnvelope {
  readonly eventId: string;
  readonly eventType: string;
  readonly eventCreatedAt: string;
  readonly objectId: string;
  readonly signupId?: string;
  readonly checkoutSessionId?: string;
  readonly subscriptionId?: string;
  readonly customerId?: string;
}

export interface ClaimedStripeWebhook {
  readonly supported: boolean;
  readonly envelope: StripeWebhookEnvelope;
  readonly attempts: number;
  readonly leaseToken: string;
}

export type CheckoutCompletionStatus = 'pending' | 'active' | 'inactive' | 'expired' | 'failed';

export function normalizeBillingEmail(value: string): string {
  const email = value.trim().normalize('NFKC').toLowerCase();
  if (email.length < 3 || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new BillingInputError('billing email is invalid');
  }
  return email;
}

export function normalizeWorkspaceName(value: string): string {
  const name = value.trim().normalize('NFKC');
  const hasControlCharacter = [...name].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
  if (name.length < 1 || name.length > 128 || hasControlCharacter) {
    throw new BillingInputError('workspace name is invalid');
  }
  return name;
}

export function isEntitledStatus(status: StripeSubscriptionStatus): boolean {
  return status === 'active' || status === 'trialing';
}

export class BillingInputError extends Error {
  override readonly name = 'BillingInputError';
}

export class BillingUnavailableError extends Error {
  override readonly name = 'BillingUnavailableError';
}

export class CheckoutUnavailableError extends Error {
  override readonly name = 'CheckoutUnavailableError';
}

export class CheckoutRateLimitError extends Error {
  override readonly name = 'CheckoutRateLimitError';
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('checkout request rate limited');
    this.retryAfterSeconds = Math.max(1, Math.min(900, Math.trunc(retryAfterSeconds)));
  }
}

export class BillingNotFoundError extends Error {
  override readonly name = 'BillingNotFoundError';
}

export class EntitlementRequiredError extends Error {
  override readonly name = 'EntitlementRequiredError';
}

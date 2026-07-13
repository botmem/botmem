import type { BillingCheckoutStatusResponse, BillingStatusResponse } from '@botmem-v2/contracts';
import type {
  BillingSignup,
  ClaimedStripeWebhook,
  StripeSubscriptionSnapshot,
  StripeWebhookEnvelope,
} from './domain.js';
import type { ParsedStripeEvent } from './stripe-event.js';

export interface BillingClockPort {
  nowMs(): number;
}

export interface BillingIdsPort {
  uuid(): string;
}

export interface StripePrice {
  readonly version: 2;
  readonly currency: string;
  readonly unitAmountMinor: number;
  readonly interval: 'day' | 'week' | 'month' | 'year';
  readonly intervalCount: number;
}

export interface StripeCheckoutPort {
  retrievePrice(priceId: string): Promise<StripePrice>;
  createSubscriptionCheckout(input: {
    readonly signupId: string;
    readonly email: string;
    readonly priceId: string;
    readonly successUrl: string;
    readonly cancelUrl: string;
  }): Promise<{
    readonly sessionId: string;
    readonly url: string;
    readonly expiresAt: string;
  }>;
  createBillingPortal(input: {
    readonly customerId: string;
    readonly returnUrl: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly url: string }>;
}

export interface StripeReconciliationPort {
  retrieveCheckoutSession(sessionId: string): Promise<{
    readonly sessionId: string;
    readonly signupId?: string;
    readonly subscriptionId?: string;
    readonly customerId?: string;
  }>;
  retrieveSubscription(subscriptionId: string): Promise<StripeSubscriptionSnapshot>;
  cancelSubscription(subscriptionId: string): Promise<{
    readonly subscriptionId: string;
    readonly status: 'canceled';
  }>;
}

export interface CommerceRepositoryPort {
  createSignup(
    signup: BillingSignup & {
      readonly createdAt: string;
      readonly expiresAt: string;
    },
  ): Promise<void>;
  attachCheckout(input: {
    readonly signupId: string;
    readonly sessionId: string;
    readonly expiresAt: string;
  }): Promise<void>;
  markCheckoutState(input: {
    readonly signupId: string;
    readonly state: 'failed' | 'expired';
    readonly updatedAt: string;
  }): Promise<void>;
  getCheckoutStatus(
    sessionId: string,
    expectedPriceId: string,
  ): Promise<BillingCheckoutStatusResponse | null>;
  getBillingStatus(
    workspaceId: string,
    expectedPriceId: string,
  ): Promise<BillingStatusResponse | null>;
  getStripeCustomer(workspaceId: string, expectedPriceId: string): Promise<string | null>;
  hasActiveEntitlement(workspaceId: string, expectedPriceId: string): Promise<boolean>;
  findSignup(signupId: string): Promise<BillingSignup | null>;
  enqueueWebhook(input: {
    readonly event: ParsedStripeEvent;
    readonly receivedAt: string;
  }): Promise<'queued' | 'duplicate'>;
  claimWebhook(input: {
    readonly workerId: string;
    readonly claimedAt: string;
    readonly leaseExpiresAt: string;
    readonly maxAttempts: number;
  }): Promise<ClaimedStripeWebhook | null>;
  applySubscription(input: {
    readonly event: StripeWebhookEnvelope;
    readonly subscription: StripeSubscriptionSnapshot;
    readonly priceMatches: boolean;
    readonly checkoutSessionId?: string;
    readonly observedAt: string;
    readonly provisionedAt?: string;
  }): Promise<void>;
  settleWebhook(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly outcome: 'processed' | 'ignored';
    readonly completedAt: string;
  }): Promise<void>;
  retryWebhook(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly failureCode: string;
    readonly failedAt: string;
    readonly availableAt: string;
    readonly deadLetter: boolean;
  }): Promise<void>;
  heartbeat(input: {
    readonly workerId: string;
    readonly startedAt: string;
    readonly seenAt: string;
  }): Promise<void>;
  reconcilerReady(now: string, maximumAgeSeconds: number): Promise<boolean>;
  readiness(): Promise<boolean>;
}

export interface IdentityProvisionerPort {
  provision(signup: BillingSignup, provisionedAt: string): Promise<void>;
  readiness(): Promise<boolean>;
}

export interface EmailLookupHashPort {
  hashCanonicalEmail(email: string): Promise<string>;
}

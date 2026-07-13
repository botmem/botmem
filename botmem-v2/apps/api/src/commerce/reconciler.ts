import {
  isEntitledStatus,
  type ClaimedStripeWebhook,
  type StripeWebhookEnvelope,
} from './domain.js';
import type {
  BillingClockPort,
  CommerceRepositoryPort,
  IdentityProvisionerPort,
  StripeReconciliationPort,
} from './ports.js';

export interface CommerceReconcilerOptions {
  readonly priceId: string;
  readonly leaseMs?: number;
  readonly maxAttempts?: number;
  readonly backoffBaseMs?: number;
  readonly backoffMaximumMs?: number;
}

export type CommerceReconciliationResult =
  | 'idle'
  | 'processed'
  | 'ignored'
  | 'retry_scheduled'
  | 'dead_letter';

/**
 * Pull worker for reduced, verified Stripe envelopes. It always re-reads the
 * canonical Stripe objects, so event delivery order cannot become local truth.
 */
export class CommerceReconciler {
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaximumMs: number;

  constructor(
    private readonly repository: CommerceRepositoryPort,
    private readonly stripe: StripeReconciliationPort,
    private readonly provisioner: IdentityProvisionerPort,
    private readonly clock: BillingClockPort,
    private readonly options: CommerceReconcilerOptions,
  ) {
    this.leaseMs = options.leaseMs ?? 60_000;
    this.maxAttempts = options.maxAttempts ?? 12;
    this.backoffBaseMs = options.backoffBaseMs ?? 1_000;
    this.backoffMaximumMs = options.backoffMaximumMs ?? 300_000;
    if (!/^price_[A-Za-z0-9]{6,255}$/u.test(options.priceId)) {
      throw new Error('Stripe price ID is malformed');
    }
    if (this.leaseMs < 5_000 || this.leaseMs > 5 * 60_000) {
      throw new RangeError('webhook lease must be between 5 seconds and 5 minutes');
    }
    if (this.maxAttempts < 1 || this.maxAttempts > 100) {
      throw new RangeError('webhook maximum attempts must be between 1 and 100');
    }
    if (
      this.backoffBaseMs < 100 ||
      this.backoffMaximumMs < this.backoffBaseMs ||
      this.backoffMaximumMs > 3_600_000
    ) {
      throw new RangeError('webhook retry backoff is invalid');
    }
  }

  async reconcileOne(workerId: string): Promise<CommerceReconciliationResult> {
    const claimedAtMs = this.clock.nowMs();
    const claimed = await this.repository.claimWebhook({
      workerId,
      claimedAt: new Date(claimedAtMs).toISOString(),
      leaseExpiresAt: new Date(claimedAtMs + this.leaseMs).toISOString(),
      maxAttempts: this.maxAttempts,
    });
    if (!claimed) return 'idle';
    let outcome: 'processed' | 'ignored';
    try {
      outcome = await this.process(claimed);
    } catch (error) {
      return this.scheduleRetry(workerId, claimed, error);
    }
    try {
      await this.repository.settleWebhook({
        eventId: claimed.envelope.eventId,
        workerId,
        leaseToken: claimed.leaseToken,
        outcome,
        completedAt: new Date(this.clock.nowMs()).toISOString(),
      });
    } catch {
      return 'idle';
    }
    return outcome;
  }

  private async scheduleRetry(
    workerId: string,
    claimed: ClaimedStripeWebhook,
    error: unknown,
  ): Promise<CommerceReconciliationResult> {
    const failureCode =
      error instanceof CommerceReconciliationStageError
        ? error.code
        : 'BILLING_RECONCILIATION_FAILED';
    const failedAtMs = this.clock.nowMs();
    const deadLetter = claimed.attempts >= this.maxAttempts;
    try {
      await this.repository.retryWebhook({
        eventId: claimed.envelope.eventId,
        workerId,
        leaseToken: claimed.leaseToken,
        failureCode,
        failedAt: new Date(failedAtMs).toISOString(),
        availableAt: new Date(failedAtMs + this.retryDelay(claimed.attempts)).toISOString(),
        deadLetter,
      });
    } catch {
      return 'idle';
    }
    return deadLetter ? 'dead_letter' : 'retry_scheduled';
  }

  async heartbeat(workerId: string, startedAt: string): Promise<void> {
    await this.repository.heartbeat({
      workerId,
      startedAt,
      seenAt: new Date(this.clock.nowMs()).toISOString(),
    });
  }

  async readiness(): Promise<boolean> {
    const [repository, provisioner] = await Promise.all([
      this.repository.readiness().catch(() => false),
      this.provisioner.readiness().catch(() => false),
    ]);
    return repository && provisioner;
  }

  private async process(claimed: ClaimedStripeWebhook): Promise<'processed' | 'ignored'> {
    const event = claimed.envelope;
    if (!claimed.supported) return 'ignored';
    if (
      event.eventType === 'checkout.session.async_payment_failed' ||
      event.eventType === 'checkout.session.expired'
    ) {
      if (!event.signupId) return 'ignored';
      try {
        await this.repository.markCheckoutState({
          signupId: event.signupId,
          state: event.eventType.endsWith('expired') ? 'expired' : 'failed',
          updatedAt: new Date(this.clock.nowMs()).toISOString(),
        });
      } catch {
        throw new CommerceReconciliationStageError('CHECKOUT_STATE_APPLY_FAILED');
      }
      return 'processed';
    }
    let resolved: Awaited<ReturnType<CommerceReconciler['resolveSubscription']>>;
    try {
      resolved = await this.resolveSubscription(event);
    } catch {
      throw new CommerceReconciliationStageError('STRIPE_CANONICAL_READ_FAILED');
    }
    if (!resolved) return 'ignored';
    let signup: Awaited<ReturnType<CommerceRepositoryPort['findSignup']>>;
    try {
      signup = await this.repository.findSignup(resolved.subscription.signupId);
    } catch {
      throw new CommerceReconciliationStageError('SIGNUP_LOOKUP_FAILED');
    }
    if (!signup) return 'ignored';
    const observedAt = new Date(this.clock.nowMs()).toISOString();
    const priceMatches =
      resolved.subscription.priceId === this.options.priceId &&
      resolved.subscription.quantity === 1;
    let provisionedAt: string | undefined;
    if (priceMatches && isEntitledStatus(resolved.subscription.status)) {
      provisionedAt = observedAt;
      try {
        await this.provisioner.provision(signup, provisionedAt);
      } catch {
        throw new CommerceReconciliationStageError('IDENTITY_PROVISION_FAILED');
      }
    }
    try {
      await this.repository.applySubscription({
        event,
        subscription: resolved.subscription,
        priceMatches,
        ...(resolved.checkoutSessionId ? { checkoutSessionId: resolved.checkoutSessionId } : {}),
        observedAt,
        ...(provisionedAt ? { provisionedAt } : {}),
      });
    } catch {
      throw new CommerceReconciliationStageError('SUBSCRIPTION_APPLY_FAILED');
    }
    return 'processed';
  }

  private async resolveSubscription(envelope: StripeWebhookEnvelope): Promise<{
    readonly subscription: Awaited<ReturnType<StripeReconciliationPort['retrieveSubscription']>>;
    readonly checkoutSessionId?: string;
  } | null> {
    let signupId = envelope.signupId;
    let subscriptionId = envelope.subscriptionId;
    let checkoutSessionId = envelope.checkoutSessionId;
    if (checkoutSessionId) {
      const session = await this.stripe.retrieveCheckoutSession(checkoutSessionId);
      if (signupId && session.signupId && signupId !== session.signupId) return null;
      if (envelope.customerId && session.customerId && envelope.customerId !== session.customerId) {
        return null;
      }
      signupId = signupId ?? session.signupId;
      subscriptionId = subscriptionId ?? session.subscriptionId;
      checkoutSessionId = session.sessionId;
    }
    if (!subscriptionId) return null;
    const subscription = await this.stripe.retrieveSubscription(subscriptionId);
    if (signupId && subscription.signupId !== signupId) return null;
    if (envelope.customerId && subscription.customerId !== envelope.customerId) return null;
    return {
      subscription,
      ...(checkoutSessionId ? { checkoutSessionId } : {}),
    };
  }

  private retryDelay(attempts: number): number {
    return Math.min(
      this.backoffMaximumMs,
      this.backoffBaseMs * 2 ** Math.min(20, Math.max(0, attempts - 1)),
    );
  }
}

class CommerceReconciliationStageError extends Error {
  override readonly name = 'CommerceReconciliationStageError';
  constructor(readonly code: string) {
    super(code);
  }
}

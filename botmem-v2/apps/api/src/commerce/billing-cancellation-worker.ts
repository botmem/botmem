import type { BillingCancellationRepositoryPort } from '../lifecycle/ports.js';
import type { BillingClockPort, StripeReconciliationPort } from './ports.js';

export type BillingCancellationResult = 'idle' | 'processed' | 'retry_scheduled' | 'dead_letter';

export interface BillingCancellationProcessorOptions {
  readonly leaseMs?: number;
  readonly maxAttempts?: number;
  readonly backoffBaseMs?: number;
  readonly backoffMaximumMs?: number;
}

/** Durable Stripe cancellation lane used only by the commerce worker. */
export class BillingCancellationProcessor {
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaximumMs: number;

  constructor(
    private readonly repository: BillingCancellationRepositoryPort,
    private readonly stripe: StripeReconciliationPort,
    private readonly clock: BillingClockPort,
    options: BillingCancellationProcessorOptions = {},
  ) {
    this.leaseMs = options.leaseMs ?? 60_000;
    this.maxAttempts = options.maxAttempts ?? 12;
    this.backoffBaseMs = options.backoffBaseMs ?? 1_000;
    this.backoffMaximumMs = options.backoffMaximumMs ?? 300_000;
    if (this.leaseMs < 5_000 || this.leaseMs > 5 * 60_000) {
      throw new RangeError('billing cancellation lease must be between 5 seconds and 5 minutes');
    }
    if (this.maxAttempts < 1 || this.maxAttempts > 20) {
      throw new RangeError('billing cancellation maximum attempts must be between 1 and 20');
    }
    if (
      this.backoffBaseMs < 100 ||
      this.backoffMaximumMs < this.backoffBaseMs ||
      this.backoffMaximumMs > 3_600_000
    ) {
      throw new RangeError('billing cancellation retry backoff is invalid');
    }
  }

  async reconcileOne(workerId: string): Promise<BillingCancellationResult> {
    const claimedAtMs = this.clock.nowMs();
    const claimed = await this.repository.claim({
      workerId,
      claimedAt: new Date(claimedAtMs).toISOString(),
      leaseExpiresAt: new Date(claimedAtMs + this.leaseMs).toISOString(),
      maxAttempts: this.maxAttempts,
    });
    if (!claimed) return 'idle';
    try {
      const current = await this.stripe.retrieveSubscription(claimed.stripeSubscriptionId);
      if (current.subscriptionId !== claimed.stripeSubscriptionId) {
        throw new BillingCancellationError();
      }
      if (current.status !== 'canceled') {
        const canceled = await this.stripe.cancelSubscription(claimed.stripeSubscriptionId);
        if (
          canceled.subscriptionId !== claimed.stripeSubscriptionId ||
          canceled.status !== 'canceled'
        ) {
          throw new BillingCancellationError();
        }
      }
      const confirmed = await this.repository.confirm({
        jobId: claimed.jobId,
        workerId,
        leaseToken: claimed.leaseToken,
        confirmedAt: new Date(this.clock.nowMs()).toISOString(),
        observedStripeStatus: 'canceled',
      });
      if (!confirmed) throw new BillingCancellationError();
      return 'processed';
    } catch {
      const failedAtMs = this.clock.nowMs();
      const state = await this.repository.fail({
        jobId: claimed.jobId,
        workerId,
        leaseToken: claimed.leaseToken,
        failedAt: new Date(failedAtMs).toISOString(),
        retryAt: new Date(failedAtMs + this.retryDelay(claimed.attempts)).toISOString(),
        maxAttempts: this.maxAttempts,
        failureCode: 'STRIPE_CANCELLATION_FAILED',
      });
      if (!state) throw new BillingCancellationPersistenceError();
      return state === 'dead' ? 'dead_letter' : 'retry_scheduled';
    }
  }

  private retryDelay(attempts: number): number {
    return Math.min(
      this.backoffMaximumMs,
      this.backoffBaseMs * 2 ** Math.min(20, Math.max(0, attempts - 1)),
    );
  }
}

class BillingCancellationError extends Error {
  override readonly name = 'BillingCancellationError';
}

class BillingCancellationPersistenceError extends Error {
  override readonly name = 'BillingCancellationPersistenceError';
}

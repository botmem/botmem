import { describe, expect, it, vi } from 'vitest';
import type {
  BillingCancellationClaim,
  BillingCancellationRepositoryPort,
} from '../lifecycle/ports.js';
import type { StripeSubscriptionSnapshot } from './domain.js';
import type { StripeReconciliationPort } from './ports.js';
import { BillingCancellationProcessor } from './billing-cancellation-worker.js';

const CLAIM: BillingCancellationClaim = {
  jobId: 'c1000000-0000-4000-8000-000000000001',
  tenantId: 'c1000000-0000-4000-8000-000000000002',
  workspaceId: 'c1000000-0000-4000-8000-000000000002',
  stripeSubscriptionId: 'sub_cancellationfixture',
  attempts: 3,
};

describe('BillingCancellationProcessor', () => {
  it('confirmsAnAlreadyCanceledCanonicalSubscriptionWithoutDeletingAgain', async () => {
    const repository = new CancellationRepository();
    const stripe = new CancellationStripe('canceled');
    const processor = build(repository, stripe);

    await expect(processor.reconcileOne('commerce.cancel')).resolves.toBe('processed');
    expect(stripe.cancel).not.toHaveBeenCalled();
    expect(repository.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: CLAIM.jobId,
        observedStripeStatus: 'canceled',
      }),
    );
  });

  it('deletesAnActiveSubscriptionThenPersistsConfirmation', async () => {
    const repository = new CancellationRepository();
    const stripe = new CancellationStripe('active');

    await expect(build(repository, stripe).reconcileOne('commerce.cancel')).resolves.toBe(
      'processed',
    );
    expect(stripe.cancel).toHaveBeenCalledWith(CLAIM.stripeSubscriptionId);
    expect(repository.confirm).toHaveBeenCalledOnce();
  });

  it('persistsAReasonOnlyBoundedRetryWhenStripeIsUnavailable', async () => {
    const repository = new CancellationRepository();
    const stripe = new CancellationStripe('active');
    stripe.retrieve.mockRejectedValueOnce(new Error('provider unavailable'));

    await expect(build(repository, stripe).reconcileOne('commerce.cancel')).resolves.toBe(
      'retry_scheduled',
    );
    expect(repository.fail).toHaveBeenCalledWith({
      jobId: CLAIM.jobId,
      workerId: 'commerce.cancel',
      failedAt: '2026-07-13T10:00:00.000Z',
      retryAt: '2026-07-13T10:00:04.000Z',
      maxAttempts: 12,
      failureCode: 'STRIPE_CANCELLATION_FAILED',
    });
  });

  it('surfacesLostFailurePersistenceInsteadOfReportingAFalseRetry', async () => {
    const repository = new CancellationRepository();
    repository.fail.mockResolvedValueOnce(null);
    const stripe = new CancellationStripe('active');
    stripe.retrieve.mockRejectedValueOnce(new Error('provider unavailable'));

    await expect(build(repository, stripe).reconcileOne('commerce.cancel')).rejects.toThrow();
  });
});

class CancellationRepository implements BillingCancellationRepositoryPort {
  readonly claim = vi.fn(async () => CLAIM as BillingCancellationClaim | null);
  readonly confirm = vi.fn(async () => true);
  readonly fail = vi.fn(async () => 'pending' as const as 'pending' | 'dead' | null);
}

class CancellationStripe implements StripeReconciliationPort {
  readonly retrieve = vi.fn(async (): Promise<StripeSubscriptionSnapshot> => snapshot('active'));
  readonly cancel = vi.fn(async () => ({
    subscriptionId: CLAIM.stripeSubscriptionId,
    status: 'canceled' as const,
  }));

  constructor(status: StripeSubscriptionSnapshot['status']) {
    this.retrieve.mockResolvedValue(snapshot(status));
  }

  async retrieveCheckoutSession() {
    return { sessionId: 'cs_test_cancellationfixture' };
  }

  retrieveSubscription(subscriptionId: string) {
    return this.retrieve(subscriptionId);
  }

  cancelSubscription(subscriptionId: string) {
    return this.cancel(subscriptionId);
  }
}

function build(repository: BillingCancellationRepositoryPort, stripe: StripeReconciliationPort) {
  return new BillingCancellationProcessor(
    repository,
    stripe,
    { nowMs: () => Date.parse('2026-07-13T10:00:00.000Z') },
    {
      leaseMs: 60_000,
      maxAttempts: 12,
      backoffBaseMs: 1_000,
      backoffMaximumMs: 60_000,
    },
  );
}

function snapshot(status: StripeSubscriptionSnapshot['status']): StripeSubscriptionSnapshot {
  return {
    subscriptionId: CLAIM.stripeSubscriptionId,
    customerId: 'cus_cancellationfixture',
    signupId: 'c1000000-0000-4000-8000-000000000003',
    status,
    priceId: 'price_cancellationfixture',
    quantity: 1,
  };
}

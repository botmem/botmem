import { describe, expect, it } from 'vitest';
import type { BillingSignup, ClaimedStripeWebhook, StripeSubscriptionSnapshot } from './domain.js';
import type {
  CommerceRepositoryPort,
  IdentityProvisionerPort,
  StripeReconciliationPort,
} from './ports.js';
import { CommerceReconciler } from './reconciler.js';

const SIGNUP_ID = '81000000-0000-4000-8000-000000000001';
const SESSION_ID = 'cs_test_commerce123456';
const PRICE_ID = 'price_commerce123456';

describe('CommerceReconciler', () => {
  it('provisions only from canonical active state and is event-id idempotent', async () => {
    const repository = new QueueRepository(checkoutJob('evt_active_commerce123456'));
    const stripe = new FakeReconciliationStripe('active');
    const provisioner = new FakeProvisioner();
    const reconciler = build(repository, stripe, provisioner);

    await expect(reconciler.reconcileOne('commerce.test')).resolves.toBe('processed');
    await expect(reconciler.reconcileOne('commerce.test')).resolves.toBe('idle');
    expect(provisioner.provisions).toHaveLength(1);
    expect(repository.subscription?.status).toBe('active');
  });

  it('uses canonical state for unordered deletion and invoice payment events', async () => {
    const repository = new QueueRepository({
      ...subscriptionJob('evt_delete_commerce123456', 'customer.subscription.deleted'),
      attempts: 1,
    });
    const stripe = new FakeReconciliationStripe('active');
    const provisioner = new FakeProvisioner();
    const reconciler = build(repository, stripe, provisioner);

    await reconciler.reconcileOne('commerce.test');

    expect(repository.subscription?.status).toBe('active');
    expect(stripe.subscriptionReads).toBe(1);
    expect(provisioner.provisions).toHaveLength(1);
  });

  it('does not provision past-due or wrong-price state and dead-letters bounded failures', async () => {
    const inactive = new QueueRepository(
      subscriptionJob('evt_pastdue_commerce123456', 'invoice.payment_failed'),
    );
    const stripe = new FakeReconciliationStripe('past_due');
    stripe.snapshot = { ...stripe.snapshot, priceId: 'price_wrong123456' };
    const provisioner = new FakeProvisioner();
    await build(inactive, stripe, provisioner).reconcileOne('commerce.test');
    expect(provisioner.provisions).toHaveLength(0);

    const failing = new QueueRepository({
      ...subscriptionJob('evt_failure_commerce123456', 'invoice.paid'),
      attempts: 12,
    });
    stripe.fail = true;
    await expect(build(failing, stripe, provisioner).reconcileOne('commerce.test')).resolves.toBe(
      'dead_letter',
    );
    expect(failing.deadLetter).toBe(true);
  });
});

class FakeReconciliationStripe implements StripeReconciliationPort {
  snapshot: StripeSubscriptionSnapshot;
  subscriptionReads = 0;
  fail = false;
  constructor(status: StripeSubscriptionSnapshot['status']) {
    this.snapshot = subscription(status);
  }
  async retrieveCheckoutSession() {
    return {
      sessionId: SESSION_ID,
      signupId: SIGNUP_ID,
      subscriptionId: 'sub_commerce123456',
      customerId: 'cus_commerce123456',
    };
  }
  async retrieveSubscription() {
    this.subscriptionReads += 1;
    if (this.fail) throw new Error('stripe unavailable');
    return this.snapshot;
  }
  async cancelSubscription() {
    return { subscriptionId: this.snapshot.subscriptionId, status: 'canceled' as const };
  }
}

class FakeProvisioner implements IdentityProvisionerPort {
  readonly provisions: BillingSignup[] = [];
  async provision(signup: BillingSignup) {
    this.provisions.push(signup);
  }
  async readiness() {
    return true;
  }
}

class QueueRepository implements CommerceRepositoryPort {
  subscription?: StripeSubscriptionSnapshot;
  deadLetter = false;
  private job: ClaimedStripeWebhook | null;
  constructor(job: ClaimedStripeWebhook) {
    this.job = job;
  }
  async claimWebhook() {
    const job = this.job;
    this.job = null;
    return job;
  }
  async findSignup() {
    return signup();
  }
  async applySubscription(input: Parameters<CommerceRepositoryPort['applySubscription']>[0]) {
    this.subscription = input.subscription;
  }
  async retryWebhook(input: Parameters<CommerceRepositoryPort['retryWebhook']>[0]) {
    this.deadLetter = input.deadLetter;
  }
  async createSignup() {}
  async attachCheckout() {}
  async markCheckoutState() {}
  async getCheckoutStatus() {
    return null;
  }
  async getBillingStatus() {
    return null;
  }
  async getStripeCustomer() {
    return null;
  }
  async hasActiveEntitlement() {
    return false;
  }
  async enqueueWebhook() {
    return 'queued' as const;
  }
  async settleWebhook() {}
  async heartbeat() {}
  async reconcilerReady() {
    return true;
  }
  async readiness() {
    return true;
  }
}

function build(
  repository: CommerceRepositoryPort,
  stripe: StripeReconciliationPort,
  provisioner: IdentityProvisionerPort,
) {
  return new CommerceReconciler(
    repository,
    stripe,
    provisioner,
    { nowMs: () => Date.parse('2026-07-13T12:00:00.000Z') },
    { priceId: PRICE_ID, maxAttempts: 12 },
  );
}

function signup(): BillingSignup {
  return {
    signupId: SIGNUP_ID,
    workspaceId: SIGNUP_ID,
    ownerUserId: '81000000-0000-4000-8000-000000000002',
    email: 'owner@example.test',
    emailLookupHashHex: '1'.repeat(64),
    workspaceName: 'Commerce Test',
    checkoutSessionId: SESSION_ID,
  };
}

function subscription(status: StripeSubscriptionSnapshot['status']): StripeSubscriptionSnapshot {
  return {
    subscriptionId: 'sub_commerce123456',
    customerId: 'cus_commerce123456',
    signupId: SIGNUP_ID,
    status,
    priceId: PRICE_ID,
    quantity: 1,
  };
}

function checkoutJob(eventId: string): ClaimedStripeWebhook {
  return {
    supported: true,
    attempts: 1,
    leaseToken: '82000000-0000-4000-8000-000000000001',
    envelope: {
      eventId,
      eventType: 'checkout.session.completed',
      eventCreatedAt: '2026-07-13T12:00:00.000Z',
      objectId: SESSION_ID,
      checkoutSessionId: SESSION_ID,
      signupId: SIGNUP_ID,
      subscriptionId: 'sub_commerce123456',
      customerId: 'cus_commerce123456',
    },
  };
}

function subscriptionJob(eventId: string, eventType: string): ClaimedStripeWebhook {
  return {
    supported: true,
    attempts: 1,
    leaseToken: '82000000-0000-4000-8000-000000000001',
    envelope: {
      eventId,
      eventType,
      eventCreatedAt: '2026-07-13T11:00:00.000Z',
      objectId: 'sub_commerce123456',
      signupId: SIGNUP_ID,
      subscriptionId: 'sub_commerce123456',
      customerId: 'cus_commerce123456',
    },
  };
}

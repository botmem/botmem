import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { NodePostgresPoolAdapter } from '../search/node-postgres.js';
import type { StripeSubscriptionSnapshot } from './domain.js';
import { PostgresCommerceRepository } from './postgres-commerce-repository.js';
import { PostgresIdentityProvisioner } from './postgres-identity-provisioner.js';
import type { StripeReconciliationPort } from './ports.js';
import { CommerceReconciler } from './reconciler.js';

const COMMERCE_URL = process.env['BOTMEM_TEST_COMMERCE_DATABASE_URL'];
const API_URL = process.env['BOTMEM_TEST_API_DATABASE_URL'];
const IDENTITY_URL = process.env['BOTMEM_TEST_IDENTITY_ADMIN_DATABASE_URL'];
const ADMIN_URL = process.env['BOTMEM_TEST_ADMIN_DATABASE_URL'];
const enabled = Boolean(COMMERCE_URL && API_URL && IDENTITY_URL && ADMIN_URL);
const SIGNUP_ID = '89000000-0000-4000-8000-000000000001';
const OWNER_ID = '89000000-0000-4000-8000-000000000002';
const SESSION_ID = 'cs_test_integration123456';
const PRICE_ID = 'price_integration123456';

describe.skipIf(!enabled)('commerce queue and isolated provisioner real PostgreSQL', () => {
  const commercePool = new NodePostgresPoolAdapter({ connectionString: COMMERCE_URL! });
  const apiPool = new NodePostgresPoolAdapter({ connectionString: API_URL! });
  const identityPool = new NodePostgresPoolAdapter({ connectionString: IDENTITY_URL! });
  const admin = new Pool({ connectionString: ADMIN_URL! });
  const apiRepository = new PostgresCommerceRepository(apiPool, 'botmem_api');
  const repository = new PostgresCommerceRepository(commercePool, 'botmem_commerce');
  const provisioner = new PostgresIdentityProvisioner(identityPool);
  const stripe = new CanonicalStripe();
  // Reconciliation observations must be newer than the database-side checkout
  // attachment timestamp, regardless of when the integration suite runs.
  let nowMs = Date.now() + 60_000;
  const reconciler = new CommerceReconciler(
    repository,
    stripe,
    provisioner,
    { nowMs: () => nowMs },
    { priceId: PRICE_ID, maxAttempts: 3, backoffBaseMs: 100, backoffMaximumMs: 1_000 },
  );

  afterAll(async () => {
    await Promise.all([commercePool.close(), apiPool.close(), identityPool.close(), admin.end()]);
  });

  it('persists, claims, provisions idempotently, and revokes from canonical unordered state', async () => {
    await apiRepository.createSignup({
      signupId: SIGNUP_ID,
      workspaceId: SIGNUP_ID,
      ownerUserId: OWNER_ID,
      email: 'commerce-integration@example.test',
      emailLookupHashHex: '9'.repeat(64),
      workspaceName: 'Commerce integration',
      createdAt: '2026-07-13T12:00:00.000Z',
      expiresAt: '2026-07-14T12:00:00.000Z',
    });
    await apiRepository.attachCheckout({
      signupId: SIGNUP_ID,
      sessionId: SESSION_ID,
      expiresAt: '2026-07-14T12:00:00.000Z',
    });

    stripe.status = 'past_due';
    await expect(
      apiRepository.enqueueWebhook({
        event: event('evt_integration_failed123456', 'invoice.payment_failed'),
        receivedAt: '2026-07-13T13:09:00.000Z',
      }),
    ).resolves.toBe('queued');
    const failedPaymentResult = await reconciler.reconcileOne('commerce.integration');
    expect(failedPaymentResult, await webhookDiagnostic('evt_integration_failed123456')).toBe(
      'processed',
    );
    await expect(identityCount()).resolves.toBe(0);

    stripe.status = 'active';
    const paid = event('evt_integration_paid123456', 'invoice.paid');
    await expect(
      apiRepository.enqueueWebhook({
        event: paid,
        receivedAt: '2026-07-13T13:10:01.000Z',
      }),
    ).resolves.toBe('queued');
    await expect(
      apiRepository.enqueueWebhook({
        event: paid,
        receivedAt: '2026-07-13T13:10:02.000Z',
      }),
    ).resolves.toBe('duplicate');
    nowMs += 60_000;
    await expect(reconciler.reconcileOne('commerce.integration')).resolves.toBe('processed');
    await expect(identityCount()).resolves.toBe(1);
    await expect(apiRepository.hasActiveEntitlement(SIGNUP_ID, PRICE_ID)).resolves.toBe(true);

    await reconciler.heartbeat('commerce.integration', '2026-07-13T13:00:00.000Z');
    await expect(
      repository.reconcilerReady(new Date(nowMs + 10_000).toISOString(), 30),
    ).resolves.toBe(true);

    stripe.status = 'canceled';
    await apiRepository.enqueueWebhook({
      event: event(
        'evt_integration_unordered123456',
        'customer.subscription.deleted',
        '2026-07-13T12:05:00.000Z',
      ),
      receivedAt: '2026-07-13T13:11:01.000Z',
    });
    nowMs += 60_000;
    await reconciler.reconcileOne('commerce.integration');
    await expect(apiRepository.hasActiveEntitlement(SIGNUP_ID, PRICE_ID)).resolves.toBe(false);
    await expect(identityCount()).resolves.toBe(1);
  });

  async function identityCount(): Promise<number> {
    const result = await admin.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM botmem.workspace WHERE id = $1::uuid',
      [SIGNUP_ID],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  async function webhookDiagnostic(eventId: string): Promise<string> {
    const result = await admin.query<{ state: string; failure_code: string | null }>(
      'SELECT state, failure_code FROM botmem.stripe_webhook_event WHERE id = $1',
      [eventId],
    );
    return JSON.stringify(result.rows[0] ?? { state: 'missing' });
  }
});

class CanonicalStripe implements StripeReconciliationPort {
  status: StripeSubscriptionSnapshot['status'] = 'past_due';
  async retrieveCheckoutSession() {
    return {
      sessionId: SESSION_ID,
      signupId: SIGNUP_ID,
      subscriptionId: 'sub_integration123456',
      customerId: 'cus_integration123456',
    };
  }
  async retrieveSubscription(): Promise<StripeSubscriptionSnapshot> {
    return {
      subscriptionId: 'sub_integration123456',
      customerId: 'cus_integration123456',
      signupId: SIGNUP_ID,
      status: this.status,
      priceId: PRICE_ID,
      quantity: 1,
      currentPeriodEnd: '2026-08-13T12:00:00.000Z',
    };
  }
  async cancelSubscription() {
    return { subscriptionId: 'sub_integration123456', status: 'canceled' as const };
  }
}

function event(eventId: string, eventType: string, eventCreatedAt = '2026-07-13T12:09:00.000Z') {
  return {
    supported: true,
    envelope: {
      eventId,
      eventType,
      eventCreatedAt,
      objectId: eventType.startsWith('invoice.') ? 'in_integration123456' : 'sub_integration123456',
      signupId: SIGNUP_ID,
      subscriptionId: 'sub_integration123456',
      customerId: 'cus_integration123456',
    },
  } as const;
}

import {
  BillingCheckoutStatusResponseSchema,
  BillingStatusResponseSchema,
  type BillingCheckoutStatusResponse,
  type BillingStatusResponse,
  type StripeSubscriptionStatus,
} from '@botmem-v2/contracts';
import { randomUUID } from 'node:crypto';
import type { SqlClientPort, SqlPoolPort } from '../search/postgres-ports.js';
import type { BillingSignup } from './domain.js';
import type { CommerceRepositoryPort } from './ports.js';

interface CheckoutStatusRow {
  readonly workspace_id: string;
  readonly checkout_state: 'pending' | 'open' | 'complete' | 'expired' | 'failed';
  readonly stripe_status: StripeSubscriptionStatus | null;
  readonly stripe_price_id: string | null;
  readonly price_matches: boolean | null;
  readonly provisioned_at: Date | string | null;
}

interface BillingStatusRow {
  readonly workspace_id: string;
  readonly stripe_status: StripeSubscriptionStatus;
  readonly stripe_price_id: string;
  readonly price_matches: boolean;
  readonly provisioned_at: Date | string | null;
  readonly current_period_end: Date | string | null;
  readonly stripe_customer_id: string;
}

interface SignupRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly owner_user_id: string;
  readonly owner_email: string;
  readonly owner_email_lookup_hash: Buffer;
  readonly workspace_name: string;
  readonly stripe_checkout_session_id: string | null;
}

interface ClaimedWebhookRow {
  readonly event_id: string;
  readonly event_type: string;
  readonly event_created_at: Date | string;
  readonly object_id: string;
  readonly supported: boolean;
  readonly signup_id: string | null;
  readonly stripe_checkout_session_id: string | null;
  readonly stripe_subscription_id: string | null;
  readonly stripe_customer_id: string | null;
  readonly attempts: number;
  readonly lease_token: string;
}

export class PostgresCommerceRepository implements CommerceRepositoryPort {
  constructor(
    private readonly pool: SqlPoolPort,
    private readonly runtimeRole: 'botmem_api' | 'botmem_commerce' = 'botmem_api',
  ) {}

  async createSignup(
    signup: BillingSignup & { readonly createdAt: string; readonly expiresAt: string },
  ): Promise<void> {
    await this.transaction(async (client) => {
      await setSignup(client, signup.signupId);
      await client.query({
        text: `INSERT INTO botmem.billing_signup (
                 id, tenant_id, workspace_id, owner_user_id, owner_email,
                 owner_email_lookup_hash, workspace_name, checkout_state,
                 created_at, expires_at, updated_at
               ) VALUES (
                 $1::uuid, $1::uuid, $1::uuid, $2::uuid, $3,
                 decode($4, 'hex'), $5, 'pending',
                 $6::timestamptz, $7::timestamptz, $6::timestamptz
               )`,
        values: [
          signup.signupId,
          signup.ownerUserId,
          signup.email,
          signup.emailLookupHashHex,
          signup.workspaceName,
          signup.createdAt,
          signup.expiresAt,
        ],
      });
    });
  }

  async attachCheckout(input: {
    readonly signupId: string;
    readonly sessionId: string;
    readonly expiresAt: string;
  }): Promise<void> {
    await this.transaction(async (client) => {
      await setSignup(client, input.signupId);
      const result = await client.query({
        text: `UPDATE botmem.billing_signup
                  SET stripe_checkout_session_id = $2,
                      checkout_state = 'open',
                      expires_at = $3::timestamptz,
                      updated_at = statement_timestamp()
                WHERE id = $1::uuid
                  AND stripe_checkout_session_id IS NULL
                  AND checkout_state = 'pending'`,
        values: [input.signupId, input.sessionId, input.expiresAt],
      });
      if (result.rowCount !== 1) throw new CommercePersistenceError();
    });
  }

  async markCheckoutState(input: {
    readonly signupId: string;
    readonly state: 'failed' | 'expired';
    readonly updatedAt: string;
  }): Promise<void> {
    await this.transaction(async (client) => {
      await setSignup(client, input.signupId);
      await client.query({
        text: `UPDATE botmem.billing_signup
                  SET checkout_state = $2, updated_at = $3::timestamptz
                WHERE id = $1::uuid AND checkout_state <> 'complete'`,
        values: [input.signupId, input.state, input.updatedAt],
      });
    });
  }

  async getCheckoutStatus(
    sessionId: string,
    expectedPriceId: string,
  ): Promise<BillingCheckoutStatusResponse | null> {
    return this.transaction(async (client) => {
      await client.query({
        text: "SELECT set_config('botmem.stripe_checkout_session_id', $1, true)",
        values: [sessionId],
      });
      const result = await client.query<CheckoutStatusRow>({
        text: `SELECT signup.workspace_id, signup.checkout_state,
                      subscription.stripe_status, subscription.stripe_price_id,
                      subscription.price_matches, subscription.provisioned_at
                 FROM botmem.billing_signup signup
                 LEFT JOIN botmem.billing_subscription subscription
                   ON subscription.signup_id = signup.id
                WHERE signup.stripe_checkout_session_id = $1`,
        values: [sessionId],
      });
      const row = result.rows[0];
      if (!row) return null;
      const entitled =
        (row.stripe_status === 'active' || row.stripe_status === 'trialing') &&
        row.stripe_price_id === expectedPriceId &&
        row.price_matches === true &&
        row.provisioned_at !== null;
      if (entitled) {
        return BillingCheckoutStatusResponseSchema.parse({
          version: 2,
          status: 'active',
          workspaceId: row.workspace_id,
        });
      }
      const status = row.stripe_status
        ? 'inactive'
        : row.checkout_state === 'expired'
          ? 'expired'
          : row.checkout_state === 'failed'
            ? 'failed'
            : 'pending';
      return BillingCheckoutStatusResponseSchema.parse({ version: 2, status });
    });
  }

  async getBillingStatus(
    workspaceId: string,
    expectedPriceId: string,
  ): Promise<BillingStatusResponse | null> {
    const row = await this.readWorkspaceSubscription(workspaceId);
    if (!row) return null;
    const entitled = active(row, expectedPriceId);
    return BillingStatusResponseSchema.parse({
      version: 2,
      workspaceId: row.workspace_id,
      subscriptionStatus: row.stripe_status,
      entitled,
      ...(row.current_period_end ? { currentPeriodEnd: iso(row.current_period_end) } : {}),
    });
  }

  async getStripeCustomer(workspaceId: string, expectedPriceId: string): Promise<string | null> {
    const row = await this.readWorkspaceSubscription(workspaceId);
    return row && row.stripe_price_id === expectedPriceId && row.price_matches
      ? row.stripe_customer_id
      : null;
  }

  async hasActiveEntitlement(workspaceId: string, expectedPriceId: string): Promise<boolean> {
    const row = await this.readWorkspaceSubscription(workspaceId);
    return row ? active(row, expectedPriceId) : false;
  }

  async findSignup(signupId: string): Promise<BillingSignup | null> {
    return this.transaction(async (client) => {
      await setSignup(client, signupId);
      const result = await client.query<SignupRow>({
        text: `SELECT id, workspace_id, owner_user_id, owner_email,
                      owner_email_lookup_hash, workspace_name, stripe_checkout_session_id
                 FROM botmem.billing_signup
                WHERE id = $1::uuid`,
        values: [signupId],
      });
      const row = result.rows[0];
      return row
        ? {
            signupId: row.id,
            workspaceId: row.workspace_id,
            ownerUserId: row.owner_user_id,
            email: row.owner_email,
            emailLookupHashHex: row.owner_email_lookup_hash.toString('hex'),
            workspaceName: row.workspace_name,
            ...(row.stripe_checkout_session_id
              ? { checkoutSessionId: row.stripe_checkout_session_id }
              : {}),
          }
        : null;
    });
  }

  async enqueueWebhook(
    input: Parameters<CommerceRepositoryPort['enqueueWebhook']>[0],
  ): Promise<'queued' | 'duplicate'> {
    return this.transaction(async (client) => {
      const event = input.event.envelope;
      await setEvent(client, event.eventId);
      const inserted = await client.query({
        text: `INSERT INTO botmem.stripe_webhook_event (
                 id, event_type, event_created_at, object_id, supported, signup_id,
                 stripe_checkout_session_id, stripe_subscription_id, stripe_customer_id,
                 state, attempts, received_at, available_at
               ) VALUES (
                 $1, $2, $3::timestamptz, $4, $5, $6::uuid,
                 $7, $8, $9, 'pending', 0, $10::timestamptz, $10::timestamptz
               ) ON CONFLICT (id) DO NOTHING`,
        values: [
          event.eventId,
          event.eventType,
          event.eventCreatedAt,
          event.objectId,
          input.event.supported,
          event.signupId ?? null,
          event.checkoutSessionId ?? null,
          event.subscriptionId ?? null,
          event.customerId ?? null,
          input.receivedAt,
        ],
      });
      return inserted.rowCount === 1 ? 'queued' : 'duplicate';
    });
  }

  async claimWebhook(input: Parameters<CommerceRepositoryPort['claimWebhook']>[0]) {
    return this.transaction(async (client) => {
      const leaseToken = randomUUID();
      const result = await client.query<ClaimedWebhookRow>({
        text: `SELECT * FROM botmem.claim_stripe_webhook(
                 $1, $2::uuid, $3::timestamptz, $4::timestamptz, $5
               )`,
        values: [
          input.workerId,
          leaseToken,
          input.claimedAt,
          input.leaseExpiresAt,
          input.maxAttempts,
        ],
      });
      const row = result.rows[0];
      if (!row) return null;
      return {
        supported: row.supported,
        attempts: row.attempts,
        leaseToken: row.lease_token,
        envelope: {
          eventId: row.event_id,
          eventType: row.event_type,
          eventCreatedAt: iso(row.event_created_at),
          objectId: row.object_id,
          ...(row.signup_id ? { signupId: row.signup_id } : {}),
          ...(row.stripe_checkout_session_id
            ? { checkoutSessionId: row.stripe_checkout_session_id }
            : {}),
          ...(row.stripe_subscription_id ? { subscriptionId: row.stripe_subscription_id } : {}),
          ...(row.stripe_customer_id ? { customerId: row.stripe_customer_id } : {}),
        },
      };
    });
  }

  async applySubscription(
    input: Parameters<CommerceRepositoryPort['applySubscription']>[0],
  ): Promise<void> {
    await this.transaction(async (client) => {
      await setSignup(client, input.subscription.signupId);
      const signup = await client.query<{
        readonly stripe_checkout_session_id: string | null;
      }>({
        text: `SELECT stripe_checkout_session_id
                 FROM botmem.billing_signup
                WHERE id = $1::uuid FOR UPDATE`,
        values: [input.subscription.signupId],
      });
      const sessionId = input.checkoutSessionId ?? signup.rows[0]?.stripe_checkout_session_id;
      if (!sessionId) throw new CommercePersistenceError();
      const subscription = input.subscription;
      const applied = await client.query({
        text: `INSERT INTO botmem.billing_subscription (
                 signup_id, tenant_id, workspace_id, owner_user_id,
                 stripe_checkout_session_id, stripe_customer_id, stripe_subscription_id,
                 stripe_price_id, quantity, stripe_status, price_matches,
                 stripe_observed_at, last_event_created_at, last_event_id,
                 current_period_end, provisioned_at, created_at, updated_at
               )
               SELECT signup.id, signup.tenant_id, signup.workspace_id, signup.owner_user_id,
                      $2, $3, $4, $5, $6, $7, $8,
                      $9::timestamptz, $10::timestamptz, $11,
                      $12::timestamptz, $13::timestamptz,
                      signup.created_at, $9::timestamptz
                 FROM botmem.billing_signup signup WHERE signup.id = $1::uuid
               ON CONFLICT (signup_id) DO UPDATE
                  SET stripe_price_id = EXCLUDED.stripe_price_id,
                      quantity = EXCLUDED.quantity,
                      stripe_status = EXCLUDED.stripe_status,
                      price_matches = EXCLUDED.price_matches,
                      stripe_observed_at = EXCLUDED.stripe_observed_at,
                      last_event_created_at = GREATEST(
                          botmem.billing_subscription.last_event_created_at,
                          EXCLUDED.last_event_created_at
                      ),
                      last_event_id = CASE
                          WHEN EXCLUDED.last_event_created_at >=
                               botmem.billing_subscription.last_event_created_at
                          THEN EXCLUDED.last_event_id
                          ELSE botmem.billing_subscription.last_event_id
                      END,
                      current_period_end = EXCLUDED.current_period_end,
                      provisioned_at = COALESCE(
                          botmem.billing_subscription.provisioned_at,
                          EXCLUDED.provisioned_at
                      ),
                      updated_at = EXCLUDED.updated_at
                WHERE botmem.billing_subscription.stripe_checkout_session_id =
                      EXCLUDED.stripe_checkout_session_id
                  AND botmem.billing_subscription.stripe_customer_id = EXCLUDED.stripe_customer_id
                  AND botmem.billing_subscription.stripe_subscription_id =
                      EXCLUDED.stripe_subscription_id
                  AND EXCLUDED.stripe_observed_at >=
                      botmem.billing_subscription.stripe_observed_at`,
        values: [
          subscription.signupId,
          sessionId,
          subscription.customerId,
          subscription.subscriptionId,
          subscription.priceId,
          subscription.quantity,
          subscription.status,
          input.priceMatches,
          input.observedAt,
          input.event.eventCreatedAt,
          input.event.eventId,
          subscription.currentPeriodEnd ?? null,
          input.provisionedAt ?? null,
        ],
      });
      if (applied.rowCount !== 1) throw new CommercePersistenceError();
      const signupUpdated = await client.query({
        text: `UPDATE botmem.billing_signup
                  SET checkout_state = 'complete', updated_at = $3::timestamptz
                WHERE id = $1::uuid AND stripe_checkout_session_id = $2`,
        values: [subscription.signupId, sessionId, input.observedAt],
      });
      if (signupUpdated.rowCount !== 1) throw new CommercePersistenceError();
    });
  }

  async settleWebhook(
    input: Parameters<CommerceRepositoryPort['settleWebhook']>[0],
  ): Promise<void> {
    await this.transaction(async (client) => {
      await setEvent(client, input.eventId);
      await lockWebhookClaim(client, input);
      const result = await client.query({
        text: `UPDATE botmem.stripe_webhook_event
                  SET state = $2, worker_id = NULL, claimed_at = NULL,
                      lease_token = NULL, lease_expires_at = NULL,
                      processed_at = $3::timestamptz, failure_code = NULL
                WHERE id = $1 AND state = 'processing' AND worker_id = $4
                  AND lease_token = $5::uuid
                  AND lease_expires_at > clock_timestamp()`,
        values: [
          input.eventId,
          input.outcome,
          input.completedAt,
          input.workerId,
          input.leaseToken,
        ],
      });
      if (result.rowCount !== 1) throw new CommerceLeaseLostError();
    });
  }

  async retryWebhook(input: Parameters<CommerceRepositoryPort['retryWebhook']>[0]): Promise<void> {
    await this.transaction(async (client) => {
      await setEvent(client, input.eventId);
      await lockWebhookClaim(client, input);
      const result = await client.query({
        text: `UPDATE botmem.stripe_webhook_event
                  SET state = CASE WHEN $5 THEN 'dead_letter' ELSE 'pending' END,
                      worker_id = NULL, claimed_at = NULL,
                      lease_token = NULL, lease_expires_at = NULL,
                      processed_at = CASE WHEN $5 THEN $3::timestamptz ELSE NULL END,
                      failure_code = $2,
                      available_at = $4::timestamptz
                WHERE id = $1 AND state = 'processing' AND worker_id = $6
                  AND lease_token = $7::uuid
                  AND lease_expires_at > clock_timestamp()`,
        values: [
          input.eventId,
          input.failureCode,
          input.failedAt,
          input.availableAt,
          input.deadLetter,
          input.workerId,
          input.leaseToken,
        ],
      });
      if (result.rowCount !== 1) throw new CommerceLeaseLostError();
    });
  }

  async heartbeat(input: Parameters<CommerceRepositoryPort['heartbeat']>[0]): Promise<void> {
    await this.transaction(async (client) => {
      await client.query({
        text: 'SELECT botmem.heartbeat_commerce_reconciler($1, $2::timestamptz, $3::timestamptz)',
        values: [input.workerId, input.startedAt, input.seenAt],
      });
    });
  }

  async reconcilerReady(now: string, maximumAgeSeconds: number): Promise<boolean> {
    try {
      return await this.transaction(async (client) => {
        const result = await client.query<{ readonly ready: boolean }>({
          text: 'SELECT botmem.commerce_reconciler_ready($1::timestamptz, $2) AS ready',
          values: [now, maximumAgeSeconds],
        });
        return result.rows[0]?.ready === true;
      });
    } catch {
      return false;
    }
  }

  async readiness(): Promise<boolean> {
    try {
      return await this.transaction(async (client) => {
        const result = await client.query<{ readonly installed: boolean }>({
          text: "SELECT to_regclass('botmem.billing_subscription') IS NOT NULL AS installed",
        });
        return result.rows[0]?.installed === true;
      });
    } catch {
      return false;
    }
  }

  private async readWorkspaceSubscription(workspaceId: string): Promise<BillingStatusRow | null> {
    return this.transaction(async (client) => {
      await client.query({
        text: `SELECT set_config('botmem.tenant_id', $1, true),
                      set_config('botmem.workspace_id', $1, true)`,
        values: [workspaceId],
      });
      const result = await client.query<BillingStatusRow>({
        text: `SELECT workspace_id, stripe_status, stripe_price_id, price_matches,
                      provisioned_at, current_period_end, stripe_customer_id
                 FROM botmem.billing_subscription
                WHERE tenant_id = $1::uuid AND workspace_id = $1::uuid`,
        values: [workspaceId],
      });
      return result.rows[0] ?? null;
    });
  }

  private async transaction<Result>(
    operation: (client: SqlClientPort) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.pool.connect();
    let open = false;
    try {
      await client.query({ text: 'BEGIN' });
      open = true;
      await client.query({ text: `SET LOCAL ROLE ${this.runtimeRole}` });
      const result = await operation(client);
      await client.query({ text: 'COMMIT' });
      open = false;
      return result;
    } catch (error) {
      if (open) await client.query({ text: 'ROLLBACK' }).catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function active(row: BillingStatusRow, expectedPriceId: string): boolean {
  return (
    (row.stripe_status === 'active' || row.stripe_status === 'trialing') &&
    row.stripe_price_id === expectedPriceId &&
    row.price_matches &&
    row.provisioned_at !== null
  );
}

function setSignup(client: SqlClientPort, signupId: string): Promise<unknown> {
  return client.query({
    text: "SELECT set_config('botmem.billing_signup_id', $1, true)",
    values: [signupId],
  });
}

function setEvent(client: SqlClientPort, eventId: string): Promise<unknown> {
  return client.query({
    text: "SELECT set_config('botmem.stripe_event_id', $1, true)",
    values: [eventId],
  });
}

function lockWebhookClaim(
  client: SqlClientPort,
  input: { readonly eventId: string; readonly workerId: string; readonly leaseToken: string },
): Promise<unknown> {
  return client.query({
    text: `SELECT 1
             FROM botmem.stripe_webhook_event
            WHERE id = $1 AND state = 'processing' AND worker_id = $2
              AND lease_token = $3::uuid
            FOR UPDATE`,
    values: [input.eventId, input.workerId, input.leaseToken],
  });
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export class CommercePersistenceError extends Error {
  override readonly name = 'CommercePersistenceError';
}

export class CommerceLeaseLostError extends Error {
  override readonly name = 'CommerceLeaseLostError';
}

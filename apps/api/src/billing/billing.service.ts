import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Queue } from 'bullmq';
import Stripe from 'stripe';
import { eq, sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { ConfigService } from '../config/config.service';
import { users } from '../db/schema';
import type { BillingInfo, SubscriptionPlan } from '@botmem/shared';

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private stripe: Stripe | null = null;

  constructor(
    private db: DbService,
    private config: ConfigService,
    @Optional() @InjectQueue('memory') private memoryQueue?: Queue,
  ) {
    if (!this.config.isSelfHosted) {
      this.stripe = new Stripe(this.config.stripeSecretKey);
      this.logger.log('Stripe initialized');
    } else {
      this.logger.log('Self-hosted mode — billing disabled');
    }
  }

  async getOrCreateStripeCustomer(userId: string, email: string): Promise<string> {
    const [user] = await this.db.userDb(userId, (db) =>
      db
        .select({ stripeCustomerId: users.stripeCustomerId })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
    );

    if (user?.stripeCustomerId) return user.stripeCustomerId;

    const customer = await this.stripe!.customers.create({
      email,
      metadata: { userId },
    });

    await this.db.userDb(userId, (db) =>
      db.update(users).set({ stripeCustomerId: customer.id }).where(eq(users.id, userId)),
    );

    return customer.id;
  }

  async createCheckoutSession(userId: string, email: string): Promise<{ url: string }> {
    const customerId = await this.getOrCreateStripeCustomer(userId, email);

    const session = await this.stripe!.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: this.config.stripePriceId, quantity: 1 }],
      subscription_data: { metadata: { userId } },
      success_url: `${this.config.frontendUrl}/settings?tab=billing&success=1`,
      cancel_url: `${this.config.frontendUrl}/settings?tab=billing`,
      client_reference_id: userId,
    });

    return { url: session.url! };
  }

  async createPortalSession(userId: string): Promise<{ url: string }> {
    const [user] = await this.db.userDb(userId, (db) =>
      db
        .select({ stripeCustomerId: users.stripeCustomerId, email: users.email })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
    );

    if (!user) throw new Error('User not found');

    // Ensure we have a valid Stripe customer — re-create if stale/invalid
    let customerId = user.stripeCustomerId;
    if (customerId) {
      try {
        await this.stripe!.customers.retrieve(customerId);
      } catch {
        this.logger.warn(`Stale Stripe customer ${customerId} for user ${userId}, re-creating`);
        customerId = null;
      }
    }
    if (!customerId) {
      customerId = await this.getOrCreateStripeCustomer(userId, user.email);
    }

    const session = await this.stripe!.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${this.config.frontendUrl}/settings?tab=billing`,
    });

    return { url: session.url };
  }

  async getBillingInfo(userId: string): Promise<BillingInfo> {
    const rows = await this.db.userDb(userId, (db) =>
      db
        .select({
          subscriptionStatus: users.subscriptionStatus,
          subscriptionCurrentPeriodEnd: users.subscriptionCurrentPeriodEnd,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
    );
    const user = rows[0];

    const status = (user?.subscriptionStatus || 'free') as BillingInfo['status'];
    const plan: SubscriptionPlan = ['active', 'trialing'].includes(status) ? 'pro' : 'free';

    return {
      plan,
      status,
      currentPeriodEnd: user?.subscriptionCurrentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: false,
    };
  }

  async getUserPlan(userId: string): Promise<SubscriptionPlan> {
    const info = await this.getBillingInfo(userId);
    return info.plan;
  }

  async isProUser(userId: string): Promise<boolean> {
    if (this.config.isSelfHosted) return true;
    const plan = await this.getUserPlan(userId);
    return plan === 'pro';
  }

  async handleWebhookEvent(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.client_reference_id;
        if (!userId) {
          this.logger.warn('Checkout session missing client_reference_id');
          return;
        }
        await this.db.systemDb((db) =>
          db
            .update(users)
            .set({
              stripeCustomerId: session.customer as string,
              subscriptionId: session.subscription as string,
              subscriptionStatus: 'active',
            })
            .where(eq(users.id, userId)),
        );
        await this.enqueueRawEventDebtForUser(userId, 'checkout.session.completed');
        this.logger.log(`User ${userId} subscribed (checkout completed)`);
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        const userId =
          subscription.metadata?.userId ||
          (await this.findUserIdByStripeCustomer(subscription.customer as string));
        const status =
          subscription.status === 'active'
            ? 'active'
            : subscription.status === 'trialing'
              ? 'trialing'
              : subscription.status === 'past_due'
                ? 'past_due'
                : subscription.status === 'canceled'
                  ? 'canceled'
                  : subscription.status;
        await this.db.systemDb((db) =>
          db
            .update(users)
            .set({
              subscriptionStatus: status,
              subscriptionCurrentPeriodEnd: new Date(
                (subscription as unknown as Record<string, number>).current_period_end * 1000,
              ),
            })
            .where(eq(users.stripeCustomerId, subscription.customer as string)),
        );
        if (userId && ['active', 'trialing'].includes(status)) {
          await this.enqueueRawEventDebtForUser(userId, 'customer.subscription.updated');
        }
        this.logger.log(`Subscription ${subscription.id} updated → ${status}`);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        await this.db.systemDb((db) =>
          db
            .update(users)
            .set({
              subscriptionStatus: 'free',
              subscriptionId: null,
              subscriptionCurrentPeriodEnd: null,
            })
            .where(eq(users.stripeCustomerId, subscription.customer as string)),
        );
        this.logger.log(`Subscription ${subscription.id} deleted → free`);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        if (invoice.customer) {
          await this.db.systemDb((db) =>
            db
              .update(users)
              .set({ subscriptionStatus: 'past_due' })
              .where(eq(users.stripeCustomerId, invoice.customer as string)),
          );
          this.logger.warn(`Payment failed for customer ${invoice.customer}`);
        }
        break;
      }

      default:
        this.logger.debug(`Unhandled Stripe event: ${event.type}`);
    }
  }

  private async findUserIdByStripeCustomer(
    customerId: string | null | undefined,
  ): Promise<string | null> {
    if (!customerId) return null;
    const rows = await this.db.systemDb((db) =>
      db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.stripeCustomerId, customerId))
        .limit(1),
    );
    return rows[0]?.id ?? null;
  }

  private async enqueueRawEventDebtForUser(userId: string, reason: string): Promise<void> {
    if (!this.memoryQueue) return;

    const result = await this.db.systemDb((db) =>
      db.execute<{ id: string }>(sql`
        SELECT re.id
        FROM raw_events re
        INNER JOIN accounts a ON a.id = re.account_id
        WHERE a.user_id = ${userId}
          AND re.processing_state IN ('pending', 'failed', 'quota_blocked')
          AND re.source_type NOT IN ('contact', 'group')
          AND NOT (re.connector_type = 'telegram' AND re.source_id LIKE 'telegram:contact:%')
          AND NOT EXISTS (
            SELECT 1 FROM memories m
            WHERE m.account_id = re.account_id
              AND m.source_id = re.source_id
              AND m.connector_type = re.connector_type
          )
        ORDER BY re.created_at ASC
        LIMIT 10000
      `),
    );

    let enqueued = 0;
    for (const row of result.rows) {
      await this.memoryQueue.add(
        'process',
        { rawEventId: row.id },
        {
          attempts: 5,
          backoff: { type: 'exponential', delay: 5000 },
          jobId: `quota-resume:${row.id}`,
        },
      );
      enqueued++;
    }

    if (enqueued > 0) {
      this.logger.log(`Enqueued ${enqueued} raw event(s) after ${reason} for user ${userId}`);
    }
  }
}

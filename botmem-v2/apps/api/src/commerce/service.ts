import {
  BillingPriceResponseSchema,
  BillingCheckoutResponseSchema,
  BillingPortalResponseSchema,
  type BillingCheckoutRequest,
  type BillingCheckoutResponse,
  type BillingCheckoutStatusResponse,
  type BillingPortalResponse,
  type BillingPriceResponse,
  type BillingStatusResponse,
} from '@botmem-v2/contracts';
import {
  WorkspaceAuthorizationError,
  type WorkspaceAuthorizer,
  type WorkspaceCredentials,
} from '../search-api.js';
import {
  BillingNotFoundError,
  BillingUnavailableError,
  CheckoutUnavailableError,
  normalizeBillingEmail,
  normalizeWorkspaceName,
} from './domain.js';
import type {
  BillingClockPort,
  BillingIdsPort,
  CommerceRepositoryPort,
  EmailLookupHashPort,
  StripeCheckoutPort,
} from './ports.js';
import type { ParsedStripeEvent } from './stripe-event.js';

export interface CommerceServiceOptions {
  readonly priceId: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly portalReturnUrl: string;
  readonly checkoutAvailable: boolean;
  readonly signupTtlMs?: number;
  readonly reconcilerMaximumAgeSeconds?: number;
  readonly priceCacheTtlMs?: number;
}

export class CommerceService {
  private readonly signupTtlMs: number;
  private readonly reconcilerMaximumAgeSeconds: number;
  private readonly priceCacheTtlMs: number;
  private cachedPrice?: { readonly value: BillingPriceResponse; readonly expiresAt: number };
  private priceRequest: Promise<BillingPriceResponse> | undefined;

  constructor(
    private readonly repository: CommerceRepositoryPort,
    private readonly stripe: StripeCheckoutPort,
    private readonly emailLookup: EmailLookupHashPort,
    private readonly ids: BillingIdsPort,
    private readonly clock: BillingClockPort,
    private readonly options: CommerceServiceOptions,
  ) {
    this.signupTtlMs = options.signupTtlMs ?? 24 * 60 * 60_000;
    this.reconcilerMaximumAgeSeconds = options.reconcilerMaximumAgeSeconds ?? 60;
    this.priceCacheTtlMs = options.priceCacheTtlMs ?? 5 * 60_000;
    if (!/^price_[A-Za-z0-9]{6,255}$/u.test(options.priceId)) {
      throw new Error('Stripe price ID is malformed');
    }
    if (this.signupTtlMs < 30 * 60_000 || this.signupTtlMs > 24 * 60 * 60_000) {
      throw new RangeError('signup TTL must be between 30 minutes and 24 hours');
    }
    if (this.reconcilerMaximumAgeSeconds < 10 || this.reconcilerMaximumAgeSeconds > 300) {
      throw new RangeError('reconciler maximum age must be between 10 and 300 seconds');
    }
    if (this.priceCacheTtlMs < 60_000 || this.priceCacheTtlMs > 60 * 60_000) {
      throw new RangeError('price cache TTL must be between one minute and one hour');
    }
  }

  async publicPrice(): Promise<BillingPriceResponse> {
    const now = this.clock.nowMs();
    if (this.cachedPrice && this.cachedPrice.expiresAt > now) return this.cachedPrice.value;
    if (this.priceRequest) return this.priceRequest;
    this.priceRequest = this.stripe
      .retrievePrice(this.options.priceId)
      .then((price) => {
        const value = BillingPriceResponseSchema.parse({
          ...price,
          checkoutAvailable: this.options.checkoutAvailable,
          ...(this.options.checkoutAvailable
            ? {}
            : { unavailableReason: 'legal_review_pending' as const }),
        });
        this.cachedPrice = { value, expiresAt: this.clock.nowMs() + this.priceCacheTtlMs };
        return value;
      })
      .catch(() => {
        throw new BillingUnavailableError();
      })
      .finally(() => {
        this.priceRequest = undefined;
      });
    return this.priceRequest;
  }

  async createCheckout(input: BillingCheckoutRequest): Promise<BillingCheckoutResponse> {
    if (!this.options.checkoutAvailable) throw new CheckoutUnavailableError();
    const email = normalizeBillingEmail(input.email);
    const workspaceName = normalizeWorkspaceName(input.workspaceName);
    const signupId = this.ids.uuid();
    const ownerUserId = this.ids.uuid();
    const nowMs = this.clock.nowMs();
    const createdAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + this.signupTtlMs).toISOString();
    await this.repository.createSignup({
      signupId,
      workspaceId: signupId,
      ownerUserId,
      email,
      emailLookupHashHex: await this.emailLookup.hashCanonicalEmail(email),
      workspaceName,
      createdAt,
      expiresAt,
    });
    let checkout: Awaited<ReturnType<StripeCheckoutPort['createSubscriptionCheckout']>>;
    try {
      checkout = await this.stripe.createSubscriptionCheckout({
        signupId,
        email,
        priceId: this.options.priceId,
        successUrl: this.options.successUrl,
        cancelUrl: this.options.cancelUrl,
      });
      await this.repository.attachCheckout({
        signupId,
        sessionId: checkout.sessionId,
        expiresAt: checkout.expiresAt,
      });
    } catch {
      await this.repository
        .markCheckoutState({
          signupId,
          state: 'failed',
          updatedAt: new Date(this.clock.nowMs()).toISOString(),
        })
        .catch(() => undefined);
      throw new BillingUnavailableError();
    }
    return BillingCheckoutResponseSchema.parse({
      version: 2,
      checkoutUrl: checkout.url,
      expiresAt: checkout.expiresAt,
    });
  }

  async checkoutStatus(sessionId: string): Promise<BillingCheckoutStatusResponse> {
    const status = await this.repository.getCheckoutStatus(sessionId, this.options.priceId);
    if (!status) throw new BillingNotFoundError();
    return status;
  }

  async billingStatus(workspaceId: string): Promise<BillingStatusResponse> {
    const status = await this.repository.getBillingStatus(workspaceId, this.options.priceId);
    if (!status) throw new BillingNotFoundError();
    return status;
  }

  async createPortal(workspaceId: string): Promise<BillingPortalResponse> {
    const customerId = await this.repository.getStripeCustomer(workspaceId, this.options.priceId);
    if (!customerId) throw new BillingNotFoundError();
    try {
      const portal = await this.stripe.createBillingPortal({
        customerId,
        returnUrl: this.options.portalReturnUrl,
        idempotencyKey: this.ids.uuid(),
      });
      return BillingPortalResponseSchema.parse({ version: 2, portalUrl: portal.url });
    } catch {
      throw new BillingUnavailableError();
    }
  }

  /** Signature verification happens in the HTTP adapter before this durable intake. */
  async acceptWebhook(event: ParsedStripeEvent): Promise<'queued' | 'duplicate'> {
    try {
      return await this.repository.enqueueWebhook({
        event,
        receivedAt: new Date(this.clock.nowMs()).toISOString(),
      });
    } catch {
      throw new BillingUnavailableError();
    }
  }

  async readiness(): Promise<boolean> {
    const now = new Date(this.clock.nowMs()).toISOString();
    const [repository, reconciler] = await Promise.all([
      this.repository.readiness().catch(() => false),
      this.repository.reconcilerReady(now, this.reconcilerMaximumAgeSeconds).catch(() => false),
    ]);
    return repository && reconciler;
  }

  entitledAuthorizer(authorizer: WorkspaceAuthorizer): WorkspaceAuthorizer {
    return new EntitledWorkspaceAuthorizer(authorizer, this.repository, this.options.priceId);
  }
}

export class EntitledWorkspaceAuthorizer implements WorkspaceAuthorizer {
  constructor(
    private readonly authorizer: WorkspaceAuthorizer,
    private readonly entitlements: Pick<CommerceRepositoryPort, 'hasActiveEntitlement'>,
    private readonly expectedPriceId: string,
  ) {}

  async authorize(
    requestedWorkspaceId: string,
    credentials: WorkspaceCredentials,
  ): Promise<string> {
    const workspaceId = await this.authorizer.authorize(requestedWorkspaceId, credentials);
    if (!(await this.entitlements.hasActiveEntitlement(workspaceId, this.expectedPriceId))) {
      throw new WorkspaceAuthorizationError(
        402,
        'subscription_required',
        'An active Botmem subscription is required',
      );
    }
    return workspaceId;
  }
}

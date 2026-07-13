import type { AuthenticatedPrincipal } from './domain.js';
import type { IssuedCredential } from './credential-service.js';
import { OpaqueCredentialService } from './credential-service.js';
import type {
  IdentityClockPort,
  LoginChallengeRepositoryPort,
  LoginDeliveryPort,
  TokenSecurityPort,
} from './ports.js';

const LOGIN_PREFIX = 'bml_v2.';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export interface EmailLoginOptions {
  readonly publicWebBaseUrl: string;
  readonly challengeTtlMs?: number;
  readonly maximumAttemptsPerWindow?: number;
  readonly maximumClientAttemptsPerWindow?: number;
  readonly maximumGlobalAttemptsPerWindow?: number;
  readonly rateWindowSeconds?: number;
}

export class EmailLoginService {
  private readonly webBase: URL;
  private readonly challengeTtlMs: number;
  private readonly maximumAttemptsPerWindow: number;
  private readonly maximumClientAttemptsPerWindow: number;
  private readonly maximumGlobalAttemptsPerWindow: number;
  private readonly rateWindowSeconds: number;

  constructor(
    private readonly challenges: LoginChallengeRepositoryPort,
    private readonly delivery: LoginDeliveryPort,
    private readonly credentials: OpaqueCredentialService,
    private readonly tokenSecurity: TokenSecurityPort,
    private readonly clock: IdentityClockPort,
    options: EmailLoginOptions,
  ) {
    this.webBase = new URL(options.publicWebBaseUrl);
    this.challengeTtlMs = options.challengeTtlMs ?? 15 * 60_000;
    this.maximumAttemptsPerWindow = options.maximumAttemptsPerWindow ?? 5;
    this.maximumClientAttemptsPerWindow = options.maximumClientAttemptsPerWindow ?? 30;
    this.maximumGlobalAttemptsPerWindow = options.maximumGlobalAttemptsPerWindow ?? 1_000;
    this.rateWindowSeconds = options.rateWindowSeconds ?? 15 * 60;
    if (
      this.webBase.protocol !== 'https:' &&
      this.webBase.hostname !== '127.0.0.1' &&
      this.webBase.hostname !== 'localhost'
    ) {
      throw new Error('email login web origin must use HTTPS');
    }
    if (this.challengeTtlMs < 60_000 || this.challengeTtlMs > 60 * 60_000) {
      throw new RangeError('login challenge TTL must be between one minute and one hour');
    }
    if (
      this.maximumAttemptsPerWindow < 1 ||
      this.maximumAttemptsPerWindow > 100 ||
      this.maximumClientAttemptsPerWindow < 1 ||
      this.maximumClientAttemptsPerWindow > 1_000 ||
      this.maximumGlobalAttemptsPerWindow < 1 ||
      this.maximumGlobalAttemptsPerWindow > 100_000 ||
      this.rateWindowSeconds < 60 ||
      this.rateWindowSeconds > 86_400
    ) {
      throw new RangeError('login rate policy is invalid');
    }
  }

  async readiness(): Promise<boolean> {
    return this.delivery.readiness().catch(() => false);
  }

  async begin(rawEmail: string, requestAddress: string): Promise<void> {
    if (!(await this.readiness())) throw new LoginDeliveryUnavailableError();
    const email = normalizeEmail(rawEmail);
    const now = this.clock.nowMs();
    const nowIso = new Date(now).toISOString();
    const client = normalizeRequestAddress(requestAddress);
    const [emailAllowed, clientAllowed, globalAllowed] = await Promise.all([
      this.consumeRateBucket(`email:${email}`, this.maximumAttemptsPerWindow, nowIso),
      this.consumeRateBucket(`client:${client}`, this.maximumClientAttemptsPerWindow, nowIso),
      this.consumeRateBucket('global', this.maximumGlobalAttemptsPerWindow, nowIso),
    ]);
    // A limited request intentionally looks identical to an unknown account.
    if (!emailAllowed || !clientAllowed || !globalAllowed) return;
    const token = await this.tokenSecurity.issueLoginToken();
    const deliver = await this.challenges.begin({
      emailLookupHashHex: await this.tokenSecurity.hash(`email:${email}`),
      challengeId: this.tokenSecurity.uuid(),
      secretHashHex: token.hashHex,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.challengeTtlMs).toISOString(),
    });
    if (!deliver) return;
    const url = new URL('/', this.webBase);
    url.hash = new URLSearchParams({
      loginToken: token.value,
    }).toString();
    try {
      await this.delivery.deliverSignInLink({
        email,
        url: url.toString(),
        expiresAt: new Date(now + this.challengeTtlMs).toISOString(),
      });
    } catch {
      await this.challenges.cancel({
        secretHashHex: token.hashHex,
        cancelledAt: new Date(this.clock.nowMs()).toISOString(),
      });
      throw new LoginDeliveryUnavailableError();
    }
  }

  async complete(rawToken: string): Promise<IssuedCredential> {
    if (!validLoginToken(rawToken)) throw new LoginChallengeRejectedError();
    const challenge = await this.challenges.consume({
      secretHashHex: await this.tokenSecurity.hash(rawToken),
      consumedAt: new Date(this.clock.nowMs()).toISOString(),
    });
    if (!challenge) throw new LoginChallengeRejectedError();
    const principal: AuthenticatedPrincipal = {
      tenantId: challenge.tenantId,
      workspaceId: challenge.workspaceId,
      userId: challenge.userId,
      membershipRole: challenge.membershipRole,
      credentialId: challenge.challengeId,
      credentialKind: 'browser_session',
      scopes: ['browser'],
      expiresAt: new Date(this.clock.nowMs() + 60_000).toISOString(),
    };
    return this.credentials.issueBrowserSession(principal);
  }

  private async consumeRateBucket(
    discriminator: string,
    maximumAttempts: number,
    now: string,
  ): Promise<boolean> {
    return this.challenges.consumeRateLimit({
      bucketHashHex: await this.tokenSecurity.hash(`email-login-rate:${discriminator}`),
      now,
      maximumAttempts,
      windowSeconds: this.rateWindowSeconds,
    });
  }
}

export class LoginDeliveryUnavailableError extends Error {
  override readonly name = 'LoginDeliveryUnavailableError';
}

export class LoginChallengeRejectedError extends Error {
  override readonly name = 'LoginChallengeRejectedError';
}

export class UnavailableLoginDelivery implements LoginDeliveryPort {
  async readiness(): Promise<boolean> {
    return false;
  }

  async deliverSignInLink(): Promise<void> {
    throw new LoginDeliveryUnavailableError();
  }
}

function normalizeEmail(value: string): string {
  const email = value.trim().normalize('NFKC').toLowerCase();
  if (email.length < 3 || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new LoginInputError();
  }
  return email;
}

function normalizeRequestAddress(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > 128 || !/^[a-f0-9:.]+$/u.test(normalized)) {
    return 'unknown';
  }
  return normalized;
}

function validLoginToken(value: string): boolean {
  return value.startsWith(LOGIN_PREFIX) && TOKEN_PATTERN.test(value.slice(LOGIN_PREFIX.length));
}

export class LoginInputError extends Error {
  override readonly name = 'LoginInputError';
}

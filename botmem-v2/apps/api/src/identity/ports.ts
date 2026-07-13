import type {
  AuthenticatedPrincipal,
  CredentialKind,
  CredentialSnapshot,
  PersonalAccessTokenMetadata,
} from './domain.js';

export interface CredentialRepositoryPort {
  authenticate(input: {
    readonly secretHashHex: string;
    readonly expectedKind: CredentialKind;
    readonly now: string;
  }): Promise<AuthenticatedPrincipal | null>;

  issue(credential: CredentialSnapshot): Promise<void>;

  rotate(input: {
    readonly currentSecretHashHex: string;
    readonly currentKind: CredentialKind;
    readonly replacement: CredentialSnapshot;
    readonly rotatedAt: string;
  }): Promise<void>;

  revoke(input: {
    readonly secretHashHex: string;
    readonly expectedKind: CredentialKind;
    readonly revokedAt: string;
  }): Promise<boolean>;

  listPersonalAccessTokens(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly now: string;
  }): Promise<readonly PersonalAccessTokenMetadata[]>;

  revokePersonalAccessToken(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly credentialId: string;
    readonly revokedAt: string;
  }): Promise<boolean>;
}

export interface TokenSecurityPort {
  issue(kind: CredentialKind): Promise<{
    readonly value: string;
    readonly hashHex: string;
    readonly prefix: string;
  }>;
  issueLoginToken(): Promise<{
    readonly value: string;
    readonly hashHex: string;
  }>;
  hash(value: string): Promise<string>;
  uuid(): string;
}

export interface IdentityClockPort {
  nowMs(): number;
}

/** A real login flow must implement this port; the runtime never pretends delivery succeeded. */
export interface LoginDeliveryPort {
  readiness(): Promise<boolean>;
  deliverSignInLink(input: {
    readonly email: string;
    readonly url: string;
    readonly expiresAt: string;
  }): Promise<void>;
}

export interface LoginChallengePrincipal {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly membershipRole: 'owner' | 'member';
  readonly challengeId: string;
}

export interface LoginChallengeRepositoryPort {
  begin(input: {
    readonly emailLookupHashHex: string;
    readonly challengeId: string;
    readonly secretHashHex: string;
    readonly createdAt: string;
    readonly expiresAt: string;
  }): Promise<boolean>;
  consumeRateLimit(input: {
    readonly bucketHashHex: string;
    readonly now: string;
    readonly maximumAttempts: number;
    readonly windowSeconds: number;
  }): Promise<boolean>;
  consume(input: {
    readonly secretHashHex: string;
    readonly consumedAt: string;
  }): Promise<LoginChallengePrincipal | null>;
  cancel(input: { readonly secretHashHex: string; readonly cancelledAt: string }): Promise<void>;
}

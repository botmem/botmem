export type CredentialKind = 'browser_session' | 'personal_access_token';

export interface AuthenticatedPrincipal {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly membershipRole: 'owner' | 'member';
  readonly credentialId: string;
  readonly credentialKind: CredentialKind;
  readonly scopes: readonly string[];
  readonly expiresAt: string;
}

export interface CredentialSnapshot {
  readonly credentialId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly kind: CredentialKind;
  readonly secretHashHex: string;
  readonly tokenPrefix: string;
  readonly label: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly rotatedFromCredentialId?: string;
}

/** Safe, non-authenticating metadata that may be returned to its exact owner. */
export type PersonalAccessTokenScope =
  | 'botmem:search'
  | 'botmem:connections:read'
  | 'botmem:devices:read';

export interface PersonalAccessTokenMetadata {
  readonly credentialId: string;
  readonly label: string;
  readonly tokenPrefix: string;
  readonly scopes: readonly PersonalAccessTokenScope[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
}

/** Security-sensitive credential lifecycle invariants, independent of HTTP and PostgreSQL. */
export class CredentialAggregate {
  private constructor(private readonly state: CredentialSnapshot) {}

  static issue(input: CredentialSnapshot): CredentialAggregate {
    if (!isUuid(input.credentialId) || !isUuid(input.tenantId) || !isUuid(input.workspaceId)) {
      throw new CredentialInvariantError('credential ownership IDs must be UUIDs');
    }
    if (!isUuid(input.userId)) {
      throw new CredentialInvariantError('credential user ID must be a UUID');
    }
    if (!/^[0-9a-f]{64}$/u.test(input.secretHashHex)) {
      throw new CredentialInvariantError('credential hash must be a lowercase SHA-256 digest');
    }
    if (!/^[A-Za-z0-9_-]{8,24}$/u.test(input.tokenPrefix)) {
      throw new CredentialInvariantError('credential token prefix is invalid');
    }
    if (input.label.trim().length < 1 || input.label.trim().length > 128) {
      throw new CredentialInvariantError('credential label must contain 1 to 128 characters');
    }
    if (input.scopes.length < 1 || input.scopes.length > 16) {
      throw new CredentialInvariantError('credential requires between 1 and 16 scopes');
    }
    if (new Set(input.scopes).size !== input.scopes.length) {
      throw new CredentialInvariantError('credential scopes must be unique');
    }
    if (input.kind === 'browser_session' && input.scopes.join(',') !== 'browser') {
      throw new CredentialInvariantError('browser sessions must have only the browser scope');
    }
    if (input.kind === 'personal_access_token' && !input.scopes.includes('botmem:search')) {
      throw new CredentialInvariantError('personal access tokens require botmem:search');
    }
    if (
      input.kind === 'personal_access_token' &&
      input.scopes.some(
        (scope) =>
          !['botmem:search', 'botmem:connections:read', 'botmem:devices:read'].includes(scope),
      )
    ) {
      throw new CredentialInvariantError('personal access token scope is unsupported');
    }
    const createdAt = Date.parse(input.createdAt);
    const expiresAt = Date.parse(input.expiresAt);
    if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt) {
      throw new CredentialInvariantError('credential expiry must follow creation');
    }
    if (input.rotatedFromCredentialId && !isUuid(input.rotatedFromCredentialId)) {
      throw new CredentialInvariantError('rotated credential ID must be a UUID');
    }
    return new CredentialAggregate(
      Object.freeze({
        ...input,
        label: input.label.trim(),
        scopes: Object.freeze([...input.scopes]),
      }),
    );
  }

  view(): CredentialSnapshot {
    return this.state;
  }
}

export class CredentialInvariantError extends Error {
  override readonly name = 'CredentialInvariantError';
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

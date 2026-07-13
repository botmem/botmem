import type { BrowserSession } from '@botmem-v2/contracts';
import {
  WorkspaceAuthorizationError,
  type WorkspaceAuthorizer,
  type WorkspaceCredentials,
} from '../search-api.js';
import {
  CredentialAggregate,
  type AuthenticatedPrincipal,
  type CredentialKind,
  type PersonalAccessTokenMetadata,
  type PersonalAccessTokenScope,
} from './domain.js';
import type { CredentialRepositoryPort, IdentityClockPort, TokenSecurityPort } from './ports.js';

const SESSION_PREFIX = 'bms_v2.';
const PAT_PREFIX = 'bmp_v2.';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export interface OpaqueCredentialServiceOptions {
  readonly cookieName: string;
  readonly sessionTtlMs: number;
  readonly patMaxTtlMs: number;
}

export interface IssuedCredential {
  readonly credentialId: string;
  readonly value: string;
  readonly expiresAt: string;
}

export class OpaqueCredentialService implements WorkspaceAuthorizer {
  constructor(
    private readonly repository: CredentialRepositoryPort,
    private readonly tokenSecurity: TokenSecurityPort,
    private readonly clock: IdentityClockPort,
    private readonly options: OpaqueCredentialServiceOptions,
  ) {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(options.cookieName)) {
      throw new Error('session cookie name is invalid');
    }
    if (options.sessionTtlMs < 60_000 || options.sessionTtlMs > 31 * 86_400_000) {
      throw new RangeError('session TTL must be between one minute and 31 days');
    }
    if (options.patMaxTtlMs < 60_000 || options.patMaxTtlMs > 366 * 86_400_000) {
      throw new RangeError('PAT maximum TTL must be between one minute and 366 days');
    }
  }

  async authorize(
    requestedWorkspaceId: string,
    credentials: WorkspaceCredentials,
  ): Promise<string> {
    const principal = await this.authorizePrincipal(requestedWorkspaceId, credentials);
    if (principal.credentialKind !== 'browser_session') {
      throw new WorkspaceAuthorizationError(403, 'workspace_forbidden', 'Browser session required');
    }
    return principal.workspaceId;
  }

  /** Explicit capability for the read-only search REST and MCP surfaces only. */
  readOnlySearchAuthorizer(): WorkspaceAuthorizer {
    return this.readOnlyScopeAuthorizer('botmem:search');
  }

  readOnlyScopeAuthorizer(scope: PersonalAccessTokenScope): WorkspaceAuthorizer {
    return Object.freeze({
      authorize: async (requestedWorkspaceId: string, credentials: WorkspaceCredentials) => {
        const principal = await this.authorizePrincipal(requestedWorkspaceId, credentials);
        if (
          principal.credentialKind === 'personal_access_token' &&
          !principal.scopes.includes(scope)
        ) {
          throw new WorkspaceAuthorizationError(403, 'workspace_forbidden', 'Token scope denied');
        }
        return principal.workspaceId;
      },
    });
  }

  private async authorizePrincipal(
    requestedWorkspaceId: string,
    credentials: WorkspaceCredentials,
  ): Promise<AuthenticatedPrincipal> {
    let principal: AuthenticatedPrincipal;
    try {
      principal = await this.authenticate(credentials);
    } catch (error) {
      if (error instanceof CredentialAuthenticationError) {
        throw new WorkspaceAuthorizationError(
          401,
          'authentication_required',
          'Authentication required',
        );
      }
      throw error;
    }
    if (principal.workspaceId !== requestedWorkspaceId) {
      throw new WorkspaceAuthorizationError(403, 'workspace_forbidden', 'Workspace access denied');
    }
    return principal;
  }

  async readBrowserSession(cookieHeader: string | undefined): Promise<BrowserSession | null> {
    if (!cookieHeader) return null;
    try {
      const principal = await this.authenticate({ cookieHeader });
      if (principal.credentialKind !== 'browser_session') return null;
      return { version: 2, workspaceId: principal.workspaceId };
    } catch (error) {
      if (error instanceof CredentialAuthenticationError) return null;
      throw error;
    }
  }

  async authenticate(credentials: WorkspaceCredentials): Promise<AuthenticatedPrincipal> {
    const hasBearer = Boolean(credentials.authorizationHeader);
    const hasCookie = Boolean(credentials.cookieHeader);
    if (hasBearer === hasCookie) {
      throw new CredentialAuthenticationError();
    }
    const parsed = hasBearer
      ? parseBearer(credentials.authorizationHeader)
      : parseSessionCookie(credentials.cookieHeader, this.options.cookieName);
    const principal = await this.repository.authenticate({
      secretHashHex: await this.tokenSecurity.hash(parsed.value),
      expectedKind: parsed.kind,
      now: new Date(this.clock.nowMs()).toISOString(),
    });
    if (!principal) throw new CredentialAuthenticationError();
    return principal;
  }

  /** Called only after an external login verifier has proved the principal. */
  async issueBrowserSession(principal: AuthenticatedPrincipal): Promise<IssuedCredential> {
    return this.issue(principal, 'browser_session', 'Browser session', this.options.sessionTtlMs);
  }

  async issuePersonalAccessToken(
    principal: AuthenticatedPrincipal,
    label: string,
    requestedTtlMs: number,
    scopes: readonly PersonalAccessTokenScope[] = ['botmem:search'],
  ): Promise<IssuedCredential> {
    if (principal.credentialKind !== 'browser_session') {
      throw new CredentialAuthorizationError('a browser session is required to create a PAT');
    }
    if (requestedTtlMs < 60_000 || requestedTtlMs > this.options.patMaxTtlMs) {
      throw new CredentialInputError('PAT TTL is outside the configured range');
    }
    return this.issue(principal, 'personal_access_token', label, requestedTtlMs, scopes);
  }

  async listPersonalAccessTokens(
    principal: AuthenticatedPrincipal,
  ): Promise<readonly PersonalAccessTokenMetadata[]> {
    this.requireBrowserSession(principal);
    return this.repository.listPersonalAccessTokens({
      principal,
      now: new Date(this.clock.nowMs()).toISOString(),
    });
  }

  async revokePersonalAccessToken(
    principal: AuthenticatedPrincipal,
    credentialId: string,
  ): Promise<void> {
    this.requireBrowserSession(principal);
    const revoked = await this.repository.revokePersonalAccessToken({
      principal,
      credentialId,
      revokedAt: new Date(this.clock.nowMs()).toISOString(),
    });
    if (!revoked) throw new CredentialNotFoundError();
  }

  async rotate(credentials: WorkspaceCredentials): Promise<{
    readonly principal: AuthenticatedPrincipal;
    readonly credential: IssuedCredential;
  }> {
    const principal = await this.authenticate(credentials);
    const current = credentialFromStructured(credentials, this.options.cookieName);
    const issued = await this.tokenSecurity.issue(principal.credentialKind);
    const nowMs = this.clock.nowMs();
    const ttlMs = Math.min(
      Date.parse(principal.expiresAt) - nowMs,
      principal.credentialKind === 'browser_session'
        ? this.options.sessionTtlMs
        : this.options.patMaxTtlMs,
    );
    if (ttlMs < 60_000) throw new CredentialAuthenticationError();
    const createdAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + ttlMs).toISOString();
    const replacement = CredentialAggregate.issue({
      credentialId: this.tokenSecurity.uuid(),
      tenantId: principal.tenantId,
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      kind: principal.credentialKind,
      secretHashHex: issued.hashHex,
      tokenPrefix: issued.prefix,
      label: principal.credentialKind === 'browser_session' ? 'Browser session' : 'Rotated PAT',
      scopes: principal.scopes,
      createdAt,
      expiresAt,
      rotatedFromCredentialId: principal.credentialId,
    }).view();
    await this.repository.rotate({
      currentSecretHashHex: await this.tokenSecurity.hash(current.value),
      currentKind: current.kind,
      replacement,
      rotatedAt: createdAt,
    });
    return {
      principal,
      credential: { credentialId: replacement.credentialId, value: issued.value, expiresAt },
    };
  }

  async revoke(credentials: WorkspaceCredentials): Promise<boolean> {
    const parsed = credentialFromStructured(credentials, this.options.cookieName);
    return this.repository.revoke({
      secretHashHex: await this.tokenSecurity.hash(parsed.value),
      expectedKind: parsed.kind,
      revokedAt: new Date(this.clock.nowMs()).toISOString(),
    });
  }

  private async issue(
    principal: AuthenticatedPrincipal,
    kind: CredentialKind,
    label: string,
    ttlMs: number,
    scopes?: readonly PersonalAccessTokenScope[],
  ): Promise<IssuedCredential> {
    const issued = await this.tokenSecurity.issue(kind);
    const createdAt = new Date(this.clock.nowMs()).toISOString();
    const expiresAt = new Date(Date.parse(createdAt) + ttlMs).toISOString();
    const credential = CredentialAggregate.issue({
      credentialId: this.tokenSecurity.uuid(),
      tenantId: principal.tenantId,
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      kind,
      secretHashHex: issued.hashHex,
      tokenPrefix: issued.prefix,
      label,
      scopes: kind === 'browser_session' ? ['browser'] : [...(scopes ?? ['botmem:search'])],
      createdAt,
      expiresAt,
    }).view();
    await this.repository.issue(credential);
    return { credentialId: credential.credentialId, value: issued.value, expiresAt };
  }

  private requireBrowserSession(principal: AuthenticatedPrincipal): void {
    if (principal.credentialKind !== 'browser_session') {
      throw new CredentialAuthorizationError('a browser session is required');
    }
  }
}

export class CredentialAuthenticationError extends Error {
  override readonly name = 'CredentialAuthenticationError';
}

export class CredentialAuthorizationError extends Error {
  override readonly name = 'CredentialAuthorizationError';
}

export class CredentialInputError extends Error {
  override readonly name = 'CredentialInputError';
}

export class CredentialNotFoundError extends Error {
  override readonly name = 'CredentialNotFoundError';
}

function credentialFromStructured(
  credentials: WorkspaceCredentials,
  cookieName: string,
): { readonly kind: CredentialKind; readonly value: string } {
  if (credentials.authorizationHeader && !credentials.cookieHeader) {
    return parseBearer(credentials.authorizationHeader);
  }
  if (credentials.cookieHeader && !credentials.authorizationHeader) {
    return parseSessionCookie(credentials.cookieHeader, cookieName);
  }
  throw new CredentialAuthenticationError();
}

function parseBearer(value: string | undefined): {
  readonly kind: 'personal_access_token';
  readonly value: string;
} {
  const match = /^Bearer ([^\s]+)$/u.exec(value ?? '');
  if (!match?.[1] || !validToken(match[1], PAT_PREFIX)) {
    throw new CredentialAuthenticationError();
  }
  return { kind: 'personal_access_token', value: match[1] };
}

function parseSessionCookie(
  header: string | undefined,
  cookieName: string,
): { readonly kind: 'browser_session'; readonly value: string } {
  if (!header || header.length > 8_192) throw new CredentialAuthenticationError();
  const values: string[] = [];
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name === cookieName) values.push(value);
  }
  if (values.length !== 1 || !validToken(values[0] ?? '', SESSION_PREFIX)) {
    throw new CredentialAuthenticationError();
  }
  return { kind: 'browser_session', value: values[0] ?? '' };
}

function validToken(value: string, marker: string): boolean {
  return value.startsWith(marker) && TOKEN_PATTERN.test(value.slice(marker.length));
}

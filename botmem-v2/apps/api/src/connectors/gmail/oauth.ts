import type { ConnectorAccountId, TenantId } from '@botmem-v2/connector-domain';
import {
  GmailOAuthCallbackError,
  GmailOAuthStateError,
  GmailProviderError,
  GmailReconnectRequiredError,
} from './errors.js';
import type {
  GmailApiPort,
  GmailAuthorizationSession,
  GmailClockPort,
  GmailCredentialVaultPort,
  GmailCryptoPort,
  GmailOAuthProviderPort,
  GmailOAuthStateRepository,
  OAuthTokenSet,
} from './ports.js';

export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_IDENTITY_SCOPES = Object.freeze(['openid', 'email'] as const);
export const GMAIL_OAUTH_SCOPE = Object.freeze([
  GMAIL_READONLY_SCOPE,
  ...GMAIL_IDENTITY_SCOPES,
]).join(' ');
export const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const PROFILE_POLICY = Object.freeze({ timeoutMs: 15_000, maxResponseBytes: 64 * 1024 });

export interface GmailOAuthConfig {
  readonly clientId: string;
  readonly redirectUri: string;
}

export interface BeginGmailAuthorizationResult {
  readonly authorizationUrl: string;
  readonly expiresAt: string;
}

export interface CompleteGmailAuthorizationResult {
  readonly tenantId: TenantId;
  readonly accountId: ConnectorAccountId;
  readonly credentialRef: string;
  readonly providerSubjectHash: string;
  readonly emailAddress: string;
  readonly initialCursor: {
    readonly connector: 'gmail';
    readonly version: 1;
    readonly mode: 'full';
    readonly pageToken: null;
    readonly anchorHistoryId: null;
  };
}

export class GmailOAuthService {
  public constructor(
    private readonly config: GmailOAuthConfig,
    private readonly states: GmailOAuthStateRepository,
    private readonly crypto: GmailCryptoPort,
    private readonly clock: GmailClockPort,
    private readonly provider: GmailOAuthProviderPort,
    private readonly gmail: GmailApiPort,
    private readonly vault: GmailCredentialVaultPort,
  ) {
    const redirect = new URL(config.redirectUri);
    if (redirect.hash || redirect.username || redirect.password) {
      throw new Error('Gmail redirect URI must not contain credentials or a fragment');
    }
    if (redirect.protocol !== 'https:' && redirect.hostname !== 'localhost') {
      throw new Error('Gmail redirect URI must use HTTPS outside localhost');
    }
  }

  public async beginAuthorization(input: {
    readonly tenantId: TenantId;
    readonly accountId: ConnectorAccountId;
  }): Promise<BeginGmailAuthorizationResult> {
    const createdAt = this.clock.now();
    const expiresAt = new Date(Date.parse(createdAt) + OAUTH_STATE_TTL_MS).toISOString();
    const state = await this.crypto.randomUrlSafe(32);
    const verifier = await this.crypto.randomUrlSafe(64);
    const challenge = await this.crypto.sha256Base64Url(verifier);
    const stateDigest = await this.crypto.sha256Hex(state);
    await this.states.save({
      stateDigest,
      tenantId: input.tenantId,
      accountId: input.accountId,
      sealedPkceVerifier: await this.crypto.sealEphemeral(verifier),
      redirectUri: this.config.redirectUri,
      scope: GMAIL_OAUTH_SCOPE,
      createdAt,
      expiresAt,
    });

    const query = new URLSearchParams({
      access_type: 'offline',
      client_id: this.config.clientId,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      include_granted_scopes: 'false',
      prompt: 'consent',
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: GMAIL_OAUTH_SCOPE,
      state,
    });
    return Object.freeze({
      authorizationUrl: `${GOOGLE_AUTHORIZATION_ENDPOINT}?${query.toString()}`,
      expiresAt,
    });
  }

  public async completeAuthorization(input: {
    readonly state: string;
    readonly code?: string;
    readonly error?: string;
    readonly signal?: AbortSignal;
  }): Promise<CompleteGmailAuthorizationResult> {
    const stateDigest = await this.crypto.sha256Hex(input.state);
    const pending = await this.states.consume(stateDigest, this.clock.now());
    if (!pending) {
      throw new GmailOAuthStateError();
    }
    if (
      pending.redirectUri !== this.config.redirectUri ||
      pending.scope !== GMAIL_OAUTH_SCOPE ||
      input.error ||
      !input.code
    ) {
      throw new GmailOAuthCallbackError();
    }

    let tokens: OAuthTokenSet;
    try {
      tokens = await this.provider.exchangeAuthorizationCode({
        code: input.code,
        codeVerifier: await this.crypto.openEphemeral(pending.sealedPkceVerifier),
        redirectUri: this.config.redirectUri,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      if (error instanceof GmailProviderError && error.failure === 'revoked') {
        throw new GmailReconnectRequiredError();
      }
      throw error;
    }
    if (!GMAIL_OAUTH_SCOPE.split(' ').every((scope) => tokens.grantedScopes.includes(scope))) {
      throw new GmailOAuthCallbackError();
    }

    const authorization: GmailAuthorizationSession = {
      getTokens: () => tokens,
      onTokenRotation: async (rotated) => {
        tokens = rotated;
      },
    };
    let profile;
    let identity;
    try {
      [profile, identity] = await Promise.all([
        this.gmail.getProfile(authorization, {
          ...PROFILE_POLICY,
          ...(input.signal ? { signal: input.signal } : {}),
        }),
        this.gmail.getIdentity(authorization, {
          ...PROFILE_POLICY,
          ...(input.signal ? { signal: input.signal } : {}),
        }),
      ]);
    } catch (error) {
      if (error instanceof GmailProviderError && error.failure === 'revoked') {
        throw new GmailReconnectRequiredError();
      }
      throw error;
    }
    if (
      !identity.emailVerified ||
      identity.emailAddress.trim().toLowerCase() !== profile.emailAddress.trim().toLowerCase()
    ) {
      throw new GmailOAuthCallbackError();
    }
    const providerSubjectHash = await this.crypto.sha256Hex(`google:${identity.subject}`);
    const credentialRef = await this.vault.store(
      { tenantId: pending.tenantId, accountId: pending.accountId },
      tokens,
    );
    return Object.freeze({
      tenantId: pending.tenantId,
      accountId: pending.accountId,
      credentialRef,
      providerSubjectHash,
      emailAddress: profile.emailAddress,
      initialCursor: Object.freeze({
        connector: 'gmail',
        version: 1,
        mode: 'full',
        pageToken: null,
        anchorHistoryId: null,
      }),
    });
  }
}

import type { ConnectorAccountId, TenantId } from '@botmem-v2/connector-domain';
import {
  OutlookOAuthCallbackError,
  OutlookOAuthStateError,
  OutlookProviderError,
  OutlookReconnectRequiredError,
} from './errors.js';
import type {
  OutlookAuthorizationSession,
  OutlookClockPort,
  OutlookCredentialVaultPort,
  OutlookCryptoPort,
  OutlookGraphApiPort,
  OutlookOAuthProviderPort,
  OutlookOAuthStateRepository,
  OutlookOAuthTokenSet,
} from './ports.js';

export const MICROSOFT_AUTHORITY = 'common' as const;
export const MICROSOFT_AUTHORIZATION_ENDPOINT =
  'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
export const OUTLOOK_MAIL_READ_SCOPE = 'https://graph.microsoft.com/Mail.Read';
export const OUTLOOK_USER_READ_SCOPE = 'https://graph.microsoft.com/User.Read';
export const OUTLOOK_OFFLINE_ACCESS_SCOPE = 'offline_access';
export const OUTLOOK_SCOPES = Object.freeze([
  OUTLOOK_OFFLINE_ACCESS_SCOPE,
  OUTLOOK_MAIL_READ_SCOPE,
  OUTLOOK_USER_READ_SCOPE,
] as const);
export const OUTLOOK_SCOPE = OUTLOOK_SCOPES.join(' ');
const REQUIRED_ACCESS_TOKEN_SCOPES = Object.freeze([
  OUTLOOK_MAIL_READ_SCOPE,
  OUTLOOK_USER_READ_SCOPE,
]);

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const PROFILE_POLICY = Object.freeze({ timeoutMs: 15_000, maxResponseBytes: 64 * 1024 });

export interface OutlookOAuthConfig {
  readonly clientId: string;
  readonly redirectUri: string;
}

export interface BeginOutlookAuthorizationResult {
  readonly authorizationUrl: string;
  readonly expiresAt: string;
}

export interface CompleteOutlookAuthorizationResult {
  readonly tenantId: TenantId;
  readonly accountId: ConnectorAccountId;
  readonly credentialRef: string;
  readonly providerSubjectHash: string;
  readonly providerUserId: string;
  readonly displayAddress: string | null;
  readonly initialCursor: {
    readonly connector: 'outlook';
    readonly version: 1;
    readonly folders: readonly [];
  };
}

export class OutlookOAuthService {
  public constructor(
    private readonly config: OutlookOAuthConfig,
    private readonly states: OutlookOAuthStateRepository,
    private readonly crypto: OutlookCryptoPort,
    private readonly clock: OutlookClockPort,
    private readonly provider: OutlookOAuthProviderPort,
    private readonly graph: OutlookGraphApiPort,
    private readonly vault: OutlookCredentialVaultPort,
  ) {
    const redirect = new URL(config.redirectUri);
    if (redirect.hash || redirect.username || redirect.password) {
      throw new Error('Outlook redirect URI must not contain credentials or a fragment');
    }
    if (redirect.protocol !== 'https:' && redirect.hostname !== 'localhost') {
      throw new Error('Outlook redirect URI must use HTTPS outside localhost');
    }
  }

  public async beginAuthorization(input: {
    readonly tenantId: TenantId;
    readonly accountId: ConnectorAccountId;
  }): Promise<BeginOutlookAuthorizationResult> {
    const createdAt = this.clock.now();
    const expiresAt = new Date(Date.parse(createdAt) + OAUTH_STATE_TTL_MS).toISOString();
    const state = await this.crypto.randomUrlSafe(32);
    const verifier = await this.crypto.randomUrlSafe(64);
    const challenge = await this.crypto.sha256Base64Url(verifier);
    await this.states.save({
      stateDigest: await this.crypto.sha256Hex(state),
      tenantId: input.tenantId,
      accountId: input.accountId,
      sealedPkceVerifier: await this.crypto.sealEphemeral(verifier),
      redirectUri: this.config.redirectUri,
      authority: MICROSOFT_AUTHORITY,
      scope: OUTLOOK_SCOPE,
      createdAt,
      expiresAt,
    });

    const query = new URLSearchParams({
      client_id: this.config.clientId,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      redirect_uri: this.config.redirectUri,
      response_mode: 'query',
      response_type: 'code',
      scope: OUTLOOK_SCOPE,
      state,
    });
    return Object.freeze({
      authorizationUrl: `${MICROSOFT_AUTHORIZATION_ENDPOINT}?${query.toString()}`,
      expiresAt,
    });
  }

  public async completeAuthorization(input: {
    readonly state: string;
    readonly code?: string;
    readonly error?: string;
    readonly signal?: AbortSignal;
  }): Promise<CompleteOutlookAuthorizationResult> {
    const pending = await this.states.consume(
      await this.crypto.sha256Hex(input.state),
      this.clock.now(),
    );
    if (!pending) {
      throw new OutlookOAuthStateError();
    }
    if (
      pending.redirectUri !== this.config.redirectUri ||
      pending.authority !== MICROSOFT_AUTHORITY ||
      pending.scope !== OUTLOOK_SCOPE ||
      input.error ||
      !input.code
    ) {
      throw new OutlookOAuthCallbackError();
    }

    let tokens: OutlookOAuthTokenSet;
    try {
      tokens = await this.provider.exchangeAuthorizationCode({
        code: input.code,
        codeVerifier: await this.crypto.openEphemeral(pending.sealedPkceVerifier),
        redirectUri: this.config.redirectUri,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      if (error instanceof OutlookProviderError && error.failure === 'invalid_grant') {
        throw new OutlookOAuthCallbackError();
      }
      if (error instanceof OutlookProviderError && error.failure === 'revoked') {
        throw new OutlookReconnectRequiredError();
      }
      throw error;
    }
    // Microsoft may normalize scope casing and does not have to echo the
    // offline_access consent scope in an access token's resource-scope list.
    // A refresh token is already mandatory in OutlookOAuthTokenSet.
    const grantedScopes = new Set(tokens.grantedScopes.map((scope) => scope.toLowerCase()));
    if (!REQUIRED_ACCESS_TOKEN_SCOPES.every((scope) => grantedScopes.has(scope.toLowerCase()))) {
      throw new OutlookOAuthCallbackError();
    }

    const authorization: OutlookAuthorizationSession = {
      getTokens: () => tokens,
      onTokenRotation: async (rotated) => {
        tokens = rotated;
      },
    };
    let profile;
    try {
      profile = await this.graph.getProfile(authorization, {
        ...PROFILE_POLICY,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      if (error instanceof OutlookProviderError && error.failure === 'revoked') {
        throw new OutlookReconnectRequiredError();
      }
      throw error;
    }

    // Graph object IDs are the durable account identifier returned for the
    // authenticated /me principal. Email/UPN remain display data only.
    const providerSubjectHash = await this.crypto.sha256Hex(`outlook:graph-user:${profile.id}`);
    const credentialRef = await this.vault.store(
      { tenantId: pending.tenantId, accountId: pending.accountId },
      tokens,
    );
    return Object.freeze({
      tenantId: pending.tenantId,
      accountId: pending.accountId,
      credentialRef,
      providerSubjectHash,
      providerUserId: profile.id,
      displayAddress: profile.mail ?? profile.userPrincipalName,
      initialCursor: Object.freeze({
        connector: 'outlook',
        version: 1,
        folders: [] as const,
      }),
    });
  }
}

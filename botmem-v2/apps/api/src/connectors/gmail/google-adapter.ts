import { GmailProviderError } from './errors.js';
import type {
  BoundedHttpClientPort,
  BoundedHttpResponse,
  GmailApiPort,
  GmailAuthorizationSession,
  GmailClockPort,
  GmailHistoryPage,
  GmailHistoryRecord,
  GmailIdentity,
  GmailMessage,
  GmailMessageListPage,
  GmailOAuthProviderPort,
  GmailProfile,
  GmailRequestPolicy,
  OAuthTokenSet,
} from './ports.js';

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GMAIL_API_ROOT = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const TOKEN_POLICY = Object.freeze({ timeoutMs: 15_000, maxResponseBytes: 64 * 1024 });
const REFRESH_SKEW_MS = 60_000;
const MESSAGE_METADATA_HEADERS = Object.freeze([
  'Bcc',
  'Cc',
  'Date',
  'From',
  'Reply-To',
  'Sender',
  'Subject',
  'To',
]);

interface GoogleProviderConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GmailProviderError('invalid_response');
  }
  return value as Record<string, unknown>;
}

function parseJson(response: BoundedHttpResponse): Record<string, unknown> {
  try {
    return record(JSON.parse(response.body));
  } catch (error) {
    if (error instanceof GmailProviderError) {
      throw error;
    }
    throw new GmailProviderError('invalid_response', response.status);
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GmailProviderError('invalid_response');
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function mapStatus(status: number): GmailProviderError {
  if (status === 401) return new GmailProviderError('revoked', status);
  if (status === 429) return new GmailProviderError('rate_limited', status);
  if (status === 413) return new GmailProviderError('response_too_large', status);
  if (status >= 500) return new GmailProviderError('unavailable', status);
  return new GmailProviderError('invalid_response', status);
}

export class GoogleGmailAdapter implements GmailOAuthProviderPort, GmailApiPort {
  private readonly inflightRefresh = new WeakMap<
    GmailAuthorizationSession,
    Promise<OAuthTokenSet>
  >();

  public constructor(
    private readonly config: GoogleProviderConfig,
    private readonly http: BoundedHttpClientPort,
    private readonly clock: GmailClockPort,
  ) {}

  public async getIdentity(
    authorization: GmailAuthorizationSession,
    policy: GmailRequestPolicy,
  ): Promise<GmailIdentity> {
    const body = await this.authorizedJson(authorization, GOOGLE_USERINFO_ENDPOINT, policy);
    if (typeof body.email_verified !== 'boolean') {
      throw new GmailProviderError('invalid_response');
    }
    return Object.freeze({
      subject: requiredString(body.sub),
      emailAddress: requiredString(body.email),
      emailVerified: body.email_verified,
    });
  }

  public async exchangeAuthorizationCode(request: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
    readonly signal?: AbortSignal;
  }): Promise<OAuthTokenSet> {
    const response = await this.http.request({
      method: 'POST',
      url: GOOGLE_TOKEN_ENDPOINT,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code: request.code,
        code_verifier: request.codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: request.redirectUri,
      }).toString(),
      ...TOKEN_POLICY,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (response.status < 200 || response.status >= 300) {
      const body = this.errorBody(response);
      if (body.error === 'invalid_grant') {
        throw new GmailProviderError('revoked', response.status);
      }
      throw mapStatus(response.status);
    }
    const body = parseJson(response);
    return this.parseTokens(body, null);
  }

  public async getProfile(
    authorization: GmailAuthorizationSession,
    policy: GmailRequestPolicy,
  ): Promise<GmailProfile> {
    const body = await this.authorizedJson(authorization, `${GMAIL_API_ROOT}/profile`, policy);
    const messagesTotal = body.messagesTotal;
    if (
      typeof messagesTotal !== 'number' ||
      !Number.isInteger(messagesTotal) ||
      messagesTotal < 0
    ) {
      throw new GmailProviderError('invalid_response');
    }
    return Object.freeze({
      emailAddress: requiredString(body.emailAddress),
      historyId: requiredString(body.historyId),
      messagesTotal,
    });
  }

  public async listMessages(
    authorization: GmailAuthorizationSession,
    request: {
      readonly pageToken: string | null;
      readonly maxResults: number;
      readonly includeSpamTrash: true;
    },
    policy: GmailRequestPolicy,
  ): Promise<GmailMessageListPage> {
    const query = new URLSearchParams({
      includeSpamTrash: 'true',
      maxResults: String(request.maxResults),
    });
    if (request.pageToken) query.set('pageToken', request.pageToken);
    const body = await this.authorizedJson(
      authorization,
      `${GMAIL_API_ROOT}/messages?${query.toString()}`,
      policy,
    );
    const rawMessages = body.messages ?? [];
    if (!Array.isArray(rawMessages)) {
      throw new GmailProviderError('invalid_response');
    }
    const messages = rawMessages.map((value) => {
      const item = record(value);
      return Object.freeze({ id: requiredString(item.id) });
    });
    return Object.freeze({ messages, nextPageToken: nullableString(body.nextPageToken) });
  }

  public async listHistory(
    authorization: GmailAuthorizationSession,
    request: {
      readonly startHistoryId: string;
      readonly pageToken: string | null;
      readonly maxResults: number;
    },
    policy: GmailRequestPolicy,
  ): Promise<GmailHistoryPage> {
    const query = new URLSearchParams({
      maxResults: String(request.maxResults),
      startHistoryId: request.startHistoryId,
    });
    if (request.pageToken) query.set('pageToken', request.pageToken);
    const response = await this.authorizedResponse(
      authorization,
      `${GMAIL_API_ROOT}/history?${query.toString()}`,
      policy,
    );
    if (response.status === 404) {
      throw new GmailProviderError('history_expired', 404);
    }
    if (response.status < 200 || response.status >= 300) {
      throw mapStatus(response.status);
    }
    const body = parseJson(response);
    const rawHistory = body.history ?? [];
    if (!Array.isArray(rawHistory)) {
      throw new GmailProviderError('invalid_response');
    }
    const history = rawHistory.map((value) => record(value) as unknown as GmailHistoryRecord);
    history.forEach((entry) => requiredString(entry.id));
    return Object.freeze({
      history,
      historyId: nullableString(body.historyId),
      nextPageToken: nullableString(body.nextPageToken),
    });
  }

  public async getMessage(
    authorization: GmailAuthorizationSession,
    messageId: string,
    policy: GmailRequestPolicy,
  ): Promise<GmailMessage | null> {
    for (const format of ['full', 'metadata', 'minimal'] as const) {
      try {
        return await this.getMessageWithFormat(authorization, messageId, policy, format);
      } catch (error) {
        if (
          !(error instanceof GmailProviderError) ||
          error.failure !== 'response_too_large' ||
          format === 'minimal'
        ) {
          throw error;
        }
      }
    }
    throw new GmailProviderError('invalid_response');
  }

  private async getMessageWithFormat(
    authorization: GmailAuthorizationSession,
    messageId: string,
    policy: GmailRequestPolicy,
    format: 'full' | 'metadata' | 'minimal',
  ): Promise<GmailMessage | null> {
    const query = new URLSearchParams({ format });
    if (format === 'metadata') {
      MESSAGE_METADATA_HEADERS.forEach((header) => query.append('metadataHeaders', header));
    }
    const response = await this.authorizedResponse(
      authorization,
      `${GMAIL_API_ROOT}/messages/${encodeURIComponent(messageId)}?${query.toString()}`,
      policy,
    );
    if (response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) {
      throw mapStatus(response.status);
    }
    const body = parseJson(response);
    requiredString(body.id);
    return body as unknown as GmailMessage;
  }

  private async authorizedJson(
    authorization: GmailAuthorizationSession,
    url: string,
    policy: GmailRequestPolicy,
  ): Promise<Record<string, unknown>> {
    const response = await this.authorizedResponse(authorization, url, policy);
    if (response.status < 200 || response.status >= 300) {
      throw mapStatus(response.status);
    }
    return parseJson(response);
  }

  private async authorizedResponse(
    authorization: GmailAuthorizationSession,
    url: string,
    policy: GmailRequestPolicy,
  ): Promise<BoundedHttpResponse> {
    let tokens = authorization.getTokens();
    if (Date.parse(tokens.expiresAt) <= Date.parse(this.clock.now()) + REFRESH_SKEW_MS) {
      tokens = await this.refresh(tokens, authorization, policy.signal);
    }
    let response = await this.get(url, tokens.accessToken, policy);
    if (response.status === 401) {
      tokens = await this.refresh(authorization.getTokens(), authorization, policy.signal);
      response = await this.get(url, tokens.accessToken, policy);
    }
    return response;
  }

  private get(url: string, accessToken: string, policy: GmailRequestPolicy) {
    return this.http.request({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${accessToken}` },
      timeoutMs: policy.timeoutMs,
      maxResponseBytes: policy.maxResponseBytes,
      ...(policy.signal ? { signal: policy.signal } : {}),
    });
  }

  private refresh(
    previous: OAuthTokenSet,
    authorization: GmailAuthorizationSession,
    signal?: AbortSignal,
  ): Promise<OAuthTokenSet> {
    const existing = this.inflightRefresh.get(authorization);
    if (existing) return existing;
    const pending = this.performRefresh(previous, authorization, signal).finally(() => {
      this.inflightRefresh.delete(authorization);
    });
    this.inflightRefresh.set(authorization, pending);
    return pending;
  }

  private async performRefresh(
    previous: OAuthTokenSet,
    authorization: GmailAuthorizationSession,
    signal?: AbortSignal,
  ): Promise<OAuthTokenSet> {
    const response = await this.http.request({
      method: 'POST',
      url: GOOGLE_TOKEN_ENDPOINT,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: previous.refreshToken,
      }).toString(),
      ...TOKEN_POLICY,
      ...(signal ? { signal } : {}),
    });
    if (response.status < 200 || response.status >= 300) {
      const body = this.errorBody(response);
      if (body.error === 'invalid_grant') {
        throw new GmailProviderError('revoked', response.status);
      }
      throw mapStatus(response.status);
    }
    const body = parseJson(response);
    const rotated = this.parseTokens(body, previous);
    await authorization.onTokenRotation(rotated);
    return rotated;
  }

  private parseTokens(
    body: Record<string, unknown>,
    previous: OAuthTokenSet | null,
  ): OAuthTokenSet {
    const expiresIn = body.expires_in;
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new GmailProviderError('invalid_response');
    }
    const refreshToken =
      typeof body.refresh_token === 'string' && body.refresh_token
        ? body.refresh_token
        : previous?.refreshToken;
    if (!refreshToken) {
      throw new GmailProviderError('invalid_response');
    }
    const scope = typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : null;
    const grantedScopes = scope?.length ? scope : previous?.grantedScopes;
    if (!grantedScopes?.length) {
      throw new GmailProviderError('invalid_response');
    }
    const tokenType =
      typeof body.token_type === 'string' ? body.token_type.toLowerCase() : 'bearer';
    if (tokenType !== 'bearer') {
      throw new GmailProviderError('invalid_response');
    }
    return Object.freeze({
      accessToken: requiredString(body.access_token),
      refreshToken,
      expiresAt: new Date(Date.parse(this.clock.now()) + expiresIn * 1000).toISOString(),
      grantedScopes: Object.freeze([...grantedScopes]),
      tokenType: 'Bearer',
    });
  }

  private errorBody(response: BoundedHttpResponse): Record<string, unknown> {
    try {
      return record(JSON.parse(response.body));
    } catch {
      return {};
    }
  }
}

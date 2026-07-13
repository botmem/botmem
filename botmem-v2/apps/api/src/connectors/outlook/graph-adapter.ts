import { OutlookProviderError } from './errors.js';
import { OUTLOOK_SCOPE } from './oauth.js';
import type {
  OutlookAuthorizationSession,
  OutlookBoundedHttpClientPort,
  OutlookBoundedHttpResponse,
  OutlookClockPort,
  OutlookDeltaPage,
  OutlookGraphApiPort,
  OutlookMailFolder,
  OutlookMessage,
  OutlookOAuthProviderPort,
  OutlookOAuthTokenSet,
  OutlookProfile,
  OutlookRequestPolicy,
} from './ports.js';

export const MICROSOFT_TOKEN_ENDPOINT =
  'https://login.microsoftonline.com/common/oauth2/v2.0/token';
export const MICROSOFT_GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';

const TOKEN_POLICY = Object.freeze({ timeoutMs: 15_000, maxResponseBytes: 64 * 1024 });
const REFRESH_SKEW_MS = 60_000;
const MAX_FOLDER_PAGES = 10_000;
const MAX_FOLDERS = 10_000;
const MESSAGE_FIELDS = [
  'id',
  'changeKey',
  'createdDateTime',
  'lastModifiedDateTime',
  'receivedDateTime',
  'sentDateTime',
  'subject',
  'bodyPreview',
  'body',
  'from',
  'sender',
  'toRecipients',
  'ccRecipients',
  'bccRecipients',
  'replyTo',
  'conversationId',
  'conversationIndex',
  'internetMessageId',
  'parentFolderId',
  'isDraft',
  'isRead',
  'hasAttachments',
  'importance',
  'categories',
  'flag',
].join(',');
const ATTACHMENT_FIELDS = 'id,name,contentType,size,isInline,lastModifiedDateTime';

interface MicrosoftProviderConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OutlookProviderError('invalid_response');
  }
  return value as Record<string, unknown>;
}

function parseJson(response: OutlookBoundedHttpResponse): Record<string, unknown> {
  try {
    return record(JSON.parse(response.body));
  } catch (error) {
    if (error instanceof OutlookProviderError) throw error;
    throw new OutlookProviderError('invalid_response', response.status);
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OutlookProviderError('invalid_response');
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function mapStatus(status: number): OutlookProviderError {
  if (status === 401) return new OutlookProviderError('revoked', status);
  if (status === 429) return new OutlookProviderError('rate_limited', status);
  if (status === 413) return new OutlookProviderError('response_too_large', status);
  if (status >= 500) return new OutlookProviderError('unavailable', status);
  return new OutlookProviderError('invalid_response', status);
}

function errorCode(response: OutlookBoundedHttpResponse): string | null {
  try {
    const body = record(JSON.parse(response.body));
    if (typeof body.error === 'string') return body.error;
    const error = record(body.error);
    return nullableString(error.code);
  } catch {
    return null;
  }
}

function isInvalidDelta(response: OutlookBoundedHttpResponse): boolean {
  if (response.status === 410) return true;
  if (response.status !== 400 && response.status !== 404) return false;
  const code = errorCode(response)?.toLowerCase();
  return (
    code === 'invaliddeltatoken' ||
    code === 'resyncrequired' ||
    code === 'resyncchangesapplydifferences' ||
    code === 'resyncchangesuploaddifferences' ||
    code === 'syncstatenotfound'
  );
}

/**
 * Delta links are opaque provider state, but still need an SSRF/token-exfiltration
 * boundary before an Authorization header is attached.
 */
function validateGraphUrl(value: string, expectedPath: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OutlookProviderError('invalid_response');
  }
  let decodedPath: string;
  let decodedExpectedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
    decodedExpectedPath = decodeURIComponent(expectedPath);
  } catch {
    throw new OutlookProviderError('invalid_response');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'graph.microsoft.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    decodedPath !== decodedExpectedPath
  ) {
    throw new OutlookProviderError('invalid_response');
  }
  return value;
}

function encodedPathSegment(value: string): string {
  if (!value || value.length > 2048) throw new OutlookProviderError('invalid_response');
  return encodeURIComponent(value);
}

function deltaPath(folderId: string): string {
  return `/v1.0/me/mailFolders/${encodedPathSegment(folderId)}/messages/delta`;
}

export function validateMicrosoftDeltaLink(value: string, folderId: string): string {
  return validateGraphUrl(value, deltaPath(folderId));
}

function folderCollectionPath(parentFolderId: string | null): string {
  return parentFolderId === null
    ? '/v1.0/me/mailFolders'
    : `/v1.0/me/mailFolders/${encodedPathSegment(parentFolderId)}/childFolders`;
}

function initialFolderCollectionUrl(parentFolderId: string | null): string {
  const query = new URLSearchParams({
    $select: 'id,childFolderCount',
    $top: '100',
    includeHiddenFolders: 'true',
  });
  return `${MICROSOFT_GRAPH_ROOT}${folderCollectionPath(parentFolderId).slice('/v1.0'.length)}?${query.toString()}`;
}

function initialDeltaUrl(folderId: string): string {
  const query = new URLSearchParams({
    $expand: `attachments($select=${ATTACHMENT_FIELDS})`,
    $select: MESSAGE_FIELDS,
    $top: '100',
  });
  return `${MICROSOFT_GRAPH_ROOT}${deltaPath(folderId).slice('/v1.0'.length)}?${query.toString()}`;
}

export class MicrosoftGraphOutlookAdapter implements OutlookOAuthProviderPort, OutlookGraphApiPort {
  public constructor(
    private readonly config: MicrosoftProviderConfig,
    private readonly http: OutlookBoundedHttpClientPort,
    private readonly clock: OutlookClockPort,
  ) {}

  public async exchangeAuthorizationCode(request: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
    readonly signal?: AbortSignal;
  }): Promise<OutlookOAuthTokenSet> {
    const response = await this.http.request({
      method: 'POST',
      url: MICROSOFT_TOKEN_ENDPOINT,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code: request.code,
        code_verifier: request.codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: request.redirectUri,
        scope: OUTLOOK_SCOPE,
      }).toString(),
      ...TOKEN_POLICY,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (response.status < 200 || response.status >= 300) {
      if (errorCode(response)?.toLowerCase() === 'invalid_grant') {
        throw new OutlookProviderError('invalid_grant', response.status);
      }
      throw mapStatus(response.status);
    }
    return this.parseTokens(parseJson(response), null);
  }

  public async getProfile(
    authorization: OutlookAuthorizationSession,
    policy: OutlookRequestPolicy,
  ): Promise<OutlookProfile> {
    const query = new URLSearchParams({ $select: 'id,mail,userPrincipalName' });
    const body = await this.authorizedJson(
      authorization,
      `${MICROSOFT_GRAPH_ROOT}/me?${query.toString()}`,
      policy,
    );
    return Object.freeze({
      id: requiredString(body.id),
      mail: nullableString(body.mail),
      userPrincipalName: nullableString(body.userPrincipalName),
    });
  }

  public async discoverMailFolders(
    authorization: OutlookAuthorizationSession,
    policy: OutlookRequestPolicy,
  ): Promise<readonly OutlookMailFolder[]> {
    const queue: { readonly url: string; readonly path: string }[] = [
      {
        url: initialFolderCollectionUrl(null),
        path: folderCollectionPath(null),
      },
    ];
    const seenPageUrls = new Set<string>();
    const expandedFolders = new Set<string>();
    const folders = new Map<string, OutlookMailFolder>();

    for (let pageCount = 0; queue.length > 0; pageCount += 1) {
      if (pageCount >= MAX_FOLDER_PAGES) {
        throw new OutlookProviderError('invalid_response');
      }
      const current = queue.shift()!;
      if (seenPageUrls.has(current.url)) {
        throw new OutlookProviderError('invalid_response');
      }
      seenPageUrls.add(current.url);
      const body = await this.authorizedJson(authorization, current.url, policy);
      if (!Array.isArray(body.value)) {
        throw new OutlookProviderError('invalid_response');
      }
      for (const item of body.value) {
        const folder = record(item);
        const id = requiredString(folder.id);
        const childFolderCount = folder.childFolderCount;
        if (
          typeof childFolderCount !== 'number' ||
          !Number.isInteger(childFolderCount) ||
          childFolderCount < 0
        ) {
          throw new OutlookProviderError('invalid_response');
        }
        folders.set(id, Object.freeze({ id, childFolderCount }));
        if (folders.size > MAX_FOLDERS) {
          throw new OutlookProviderError('invalid_response');
        }
        if (childFolderCount > 0 && !expandedFolders.has(id)) {
          expandedFolders.add(id);
          queue.push({
            url: initialFolderCollectionUrl(id),
            path: folderCollectionPath(id),
          });
        }
      }
      const nextLink = nullableString(body['@odata.nextLink']);
      if (nextLink) {
        validateGraphUrl(nextLink, current.path);
        queue.push({ url: nextLink, path: current.path });
      }
    }
    return Object.freeze(
      [...folders.values()].sort((left, right) => left.id.localeCompare(right.id)),
    );
  }

  public async listMessageDelta(
    authorization: OutlookAuthorizationSession,
    folderId: string,
    cursorLink: string | null,
    policy: OutlookRequestPolicy,
  ): Promise<OutlookDeltaPage> {
    const url =
      cursorLink === null
        ? initialDeltaUrl(folderId)
        : validateMicrosoftDeltaLink(cursorLink, folderId);
    const response = await this.authorizedResponse(authorization, url, policy, {
      prefer: 'IdType="ImmutableId", odata.maxpagesize=100',
    });
    if (isInvalidDelta(response)) {
      throw new OutlookProviderError('invalid_delta', response.status);
    }
    if (response.status < 200 || response.status >= 300) {
      throw mapStatus(response.status);
    }
    const body = parseJson(response);
    if (!Array.isArray(body.value)) {
      throw new OutlookProviderError('invalid_response', response.status);
    }
    const messages = body.value.map((item) => {
      const message = record(item);
      requiredString(message.id);
      return message as unknown as OutlookMessage;
    });
    const nextLink = nullableString(body['@odata.nextLink']);
    const deltaLink = nullableString(body['@odata.deltaLink']);
    if ((nextLink === null) === (deltaLink === null)) {
      throw new OutlookProviderError('invalid_response', response.status);
    }
    if (nextLink) validateMicrosoftDeltaLink(nextLink, folderId);
    if (deltaLink) validateMicrosoftDeltaLink(deltaLink, folderId);
    return Object.freeze({
      messages: Object.freeze(messages),
      nextLink,
      deltaLink,
    });
  }

  private async authorizedJson(
    authorization: OutlookAuthorizationSession,
    url: string,
    policy: OutlookRequestPolicy,
  ): Promise<Record<string, unknown>> {
    const response = await this.authorizedResponse(authorization, url, policy);
    if (response.status < 200 || response.status >= 300) {
      throw mapStatus(response.status);
    }
    return parseJson(response);
  }

  private async authorizedResponse(
    authorization: OutlookAuthorizationSession,
    url: string,
    policy: OutlookRequestPolicy,
    additionalHeaders: Readonly<Record<string, string>> = {},
  ): Promise<OutlookBoundedHttpResponse> {
    let tokens = authorization.getTokens();
    if (Date.parse(tokens.expiresAt) <= Date.parse(this.clock.now()) + REFRESH_SKEW_MS) {
      tokens = await this.refresh(tokens, authorization, policy.signal);
    }
    let response = await this.get(url, tokens.accessToken, policy, additionalHeaders);
    if (response.status === 401) {
      tokens = await this.refresh(authorization.getTokens(), authorization, policy.signal);
      response = await this.get(url, tokens.accessToken, policy, additionalHeaders);
    }
    return response;
  }

  private get(
    url: string,
    accessToken: string,
    policy: OutlookRequestPolicy,
    additionalHeaders: Readonly<Record<string, string>>,
  ) {
    return this.http.request({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${accessToken}`, ...additionalHeaders },
      timeoutMs: policy.timeoutMs,
      maxResponseBytes: policy.maxResponseBytes,
      ...(policy.signal ? { signal: policy.signal } : {}),
    });
  }

  private async refresh(
    previous: OutlookOAuthTokenSet,
    authorization: OutlookAuthorizationSession,
    signal?: AbortSignal,
  ): Promise<OutlookOAuthTokenSet> {
    const response = await this.http.request({
      method: 'POST',
      url: MICROSOFT_TOKEN_ENDPOINT,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: previous.refreshToken,
        scope: OUTLOOK_SCOPE,
      }).toString(),
      ...TOKEN_POLICY,
      ...(signal ? { signal } : {}),
    });
    if (response.status < 200 || response.status >= 300) {
      if (errorCode(response)?.toLowerCase() === 'invalid_grant') {
        throw new OutlookProviderError('revoked', response.status);
      }
      throw mapStatus(response.status);
    }
    const rotated = this.parseTokens(parseJson(response), previous);
    // Persistence must succeed before an authorized request uses the new token.
    await authorization.onTokenRotation(rotated);
    return rotated;
  }

  private parseTokens(
    body: Record<string, unknown>,
    previous: OutlookOAuthTokenSet | null,
  ): OutlookOAuthTokenSet {
    const expiresIn = body.expires_in;
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new OutlookProviderError('invalid_response');
    }
    const refreshToken =
      typeof body.refresh_token === 'string' && body.refresh_token
        ? body.refresh_token
        : previous?.refreshToken;
    if (!refreshToken) throw new OutlookProviderError('invalid_response');
    const scopes = typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : null;
    const grantedScopes = scopes?.length ? scopes : previous?.grantedScopes;
    if (!grantedScopes?.length) throw new OutlookProviderError('invalid_response');
    if (requiredString(body.token_type).toLowerCase() !== 'bearer') {
      throw new OutlookProviderError('invalid_response');
    }
    return Object.freeze({
      accessToken: requiredString(body.access_token),
      refreshToken,
      expiresAt: new Date(Date.parse(this.clock.now()) + expiresIn * 1000).toISOString(),
      grantedScopes: Object.freeze([...grantedScopes]),
      tokenType: 'Bearer',
    });
  }
}

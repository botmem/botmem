import type { ConnectorAccountId, JsonValue, TenantId } from '@botmem-v2/connector-domain';

export interface OutlookOAuthTokenSet {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: string;
  readonly grantedScopes: readonly string[];
  readonly tokenType: 'Bearer';
}

export interface OutlookAuthorizationSession {
  getTokens(): OutlookOAuthTokenSet;
  onTokenRotation(tokens: OutlookOAuthTokenSet): Promise<void>;
}

export interface PendingOutlookOAuthState {
  readonly stateDigest: string;
  readonly tenantId: TenantId;
  readonly accountId: ConnectorAccountId;
  readonly sealedPkceVerifier: string;
  readonly redirectUri: string;
  readonly authority: 'common';
  readonly scope: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/**
 * Durable repository contract. consume must atomically delete/mark-used before
 * returning and return null for expired records. Callback failure burns state.
 */
export interface OutlookOAuthStateRepository {
  save(state: PendingOutlookOAuthState): Promise<void>;
  consume(stateDigest: string, now: string): Promise<PendingOutlookOAuthState | null>;
}

export interface OutlookCryptoPort {
  randomUrlSafe(byteLength: number): Promise<string>;
  sha256Base64Url(value: string): Promise<string>;
  sha256Hex(value: string): Promise<string>;
  sealEphemeral(value: string): Promise<string>;
  openEphemeral(sealedValue: string): Promise<string>;
}

export interface OutlookClockPort {
  now(): string;
}

export interface OutlookOAuthProviderPort {
  exchangeAuthorizationCode(request: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
    readonly signal?: AbortSignal;
  }): Promise<OutlookOAuthTokenSet>;
}

export interface OutlookCredentialVaultPort {
  store(
    owner: { readonly tenantId: TenantId; readonly accountId: ConnectorAccountId },
    tokens: OutlookOAuthTokenSet,
  ): Promise<string>;
  read(
    owner: { readonly tenantId: TenantId; readonly accountId: ConnectorAccountId },
    credentialRef: string,
  ): Promise<OutlookOAuthTokenSet>;
  rotate(
    owner: { readonly tenantId: TenantId; readonly accountId: ConnectorAccountId },
    credentialRef: string,
    tokens: OutlookOAuthTokenSet,
  ): Promise<void>;
  revoke(
    owner: { readonly tenantId: TenantId; readonly accountId: ConnectorAccountId },
    credentialRef: string,
  ): Promise<void>;
}

export interface OutlookProfile {
  /** Stable Microsoft Graph object id. Never use mail/UPN as account identity. */
  readonly id: string;
  readonly mail: string | null;
  readonly userPrincipalName: string | null;
}

export interface OutlookEmailAddress {
  readonly name?: string | null;
  readonly address?: string | null;
}

export interface OutlookRecipient {
  readonly emailAddress?: OutlookEmailAddress | null;
}

export interface OutlookAttachment {
  readonly id?: string;
  readonly name?: string | null;
  readonly contentType?: string | null;
  readonly size?: number | null;
  readonly isInline?: boolean | null;
  readonly lastModifiedDateTime?: string | null;
  readonly [key: string]: unknown;
}

export interface OutlookMessage {
  readonly id: string;
  readonly changeKey?: string | null;
  readonly '@odata.etag'?: string | null;
  readonly '@removed'?: { readonly reason?: string | null };
  readonly createdDateTime?: string | null;
  readonly lastModifiedDateTime?: string | null;
  readonly receivedDateTime?: string | null;
  readonly sentDateTime?: string | null;
  readonly subject?: string | null;
  readonly bodyPreview?: string | null;
  readonly body?: { readonly contentType?: string | null; readonly content?: string | null } | null;
  readonly from?: OutlookRecipient | null;
  readonly sender?: OutlookRecipient | null;
  readonly toRecipients?: readonly OutlookRecipient[];
  readonly ccRecipients?: readonly OutlookRecipient[];
  readonly bccRecipients?: readonly OutlookRecipient[];
  readonly replyTo?: readonly OutlookRecipient[];
  readonly conversationId?: string | null;
  readonly conversationIndex?: string | null;
  readonly internetMessageId?: string | null;
  readonly parentFolderId?: string | null;
  readonly hasAttachments?: boolean | null;
  readonly attachments?: readonly OutlookAttachment[];
  readonly [key: string]: unknown;
}

export interface OutlookDeltaPage {
  readonly messages: readonly OutlookMessage[];
  readonly nextLink: string | null;
  readonly deltaLink: string | null;
}

export interface OutlookMailFolder {
  readonly id: string;
  readonly childFolderCount: number;
}

export interface OutlookRequestPolicy {
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly signal?: AbortSignal;
}

export interface OutlookGraphApiPort {
  getProfile(
    authorization: OutlookAuthorizationSession,
    policy: OutlookRequestPolicy,
  ): Promise<OutlookProfile>;
  discoverMailFolders(
    authorization: OutlookAuthorizationSession,
    policy: OutlookRequestPolicy,
  ): Promise<readonly OutlookMailFolder[]>;
  listMessageDelta(
    authorization: OutlookAuthorizationSession,
    folderId: string,
    cursorLink: string | null,
    policy: OutlookRequestPolicy,
  ): Promise<OutlookDeltaPage>;
}

export interface OutlookBoundedHttpRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly signal?: AbortSignal;
}

export interface OutlookBoundedHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}

/**
 * Adapter must enforce timeout and response-size bounds before returning. It
 * must never log headers, URL query strings, or request/response bodies.
 */
export interface OutlookBoundedHttpClientPort {
  request(request: OutlookBoundedHttpRequest): Promise<OutlookBoundedHttpResponse>;
}

export type OutlookCursorJson = JsonValue;

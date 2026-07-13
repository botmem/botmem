import type { ConnectorAccountId, JsonValue, TenantId } from '@botmem-v2/connector-domain';

export interface OAuthTokenSet {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: string;
  readonly grantedScopes: readonly string[];
  readonly tokenType: 'Bearer';
}

export interface GmailAuthorizationSession {
  getTokens(): OAuthTokenSet;
  onTokenRotation(tokens: OAuthTokenSet): Promise<void>;
}

export interface PendingGmailOAuthState {
  readonly stateDigest: string;
  readonly tenantId: TenantId;
  readonly accountId: ConnectorAccountId;
  readonly sealedPkceVerifier: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/**
 * Durable repository contract. consume must atomically delete/mark-used before
 * returning and must return null for expired records. A failed callback can
 * never make a state reusable.
 */
export interface GmailOAuthStateRepository {
  save(state: PendingGmailOAuthState): Promise<void>;
  consume(stateDigest: string, now: string): Promise<PendingGmailOAuthState | null>;
}

export interface GmailCryptoPort {
  randomUrlSafe(byteLength: number): Promise<string>;
  sha256Base64Url(value: string): Promise<string>;
  sha256Hex(value: string): Promise<string>;
  sealEphemeral(value: string): Promise<string>;
  openEphemeral(sealedValue: string): Promise<string>;
}

export interface GmailClockPort {
  now(): string;
}

export interface GmailOAuthProviderPort {
  exchangeAuthorizationCode(request: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
    readonly signal?: AbortSignal;
  }): Promise<OAuthTokenSet>;
}

export interface GmailCredentialVaultPort {
  store(
    owner: { readonly tenantId: TenantId; readonly accountId: ConnectorAccountId },
    tokens: OAuthTokenSet,
  ): Promise<string>;
  read(
    owner: { readonly tenantId: TenantId; readonly accountId: ConnectorAccountId },
    credentialRef: string,
  ): Promise<OAuthTokenSet>;
  rotate(
    owner: { readonly tenantId: TenantId; readonly accountId: ConnectorAccountId },
    credentialRef: string,
    tokens: OAuthTokenSet,
  ): Promise<void>;
  revoke(
    owner: { readonly tenantId: TenantId; readonly accountId: ConnectorAccountId },
    credentialRef: string,
  ): Promise<void>;
}

export interface GmailProfile {
  readonly emailAddress: string;
  readonly historyId: string;
  readonly messagesTotal: number;
}

export interface GmailIdentity {
  readonly subject: string;
  readonly emailAddress: string;
  readonly emailVerified: boolean;
}

export interface GmailMessagePartHeader {
  readonly name?: string;
  readonly value?: string;
}

export interface GmailMessagePartBody {
  readonly attachmentId?: string;
  readonly data?: string;
  readonly size?: number;
}

export interface GmailMessagePart {
  readonly partId?: string;
  readonly mimeType?: string;
  readonly filename?: string;
  readonly headers?: readonly GmailMessagePartHeader[];
  readonly body?: GmailMessagePartBody;
  readonly parts?: readonly GmailMessagePart[];
}

export interface GmailMessage {
  readonly id: string;
  readonly threadId?: string;
  readonly historyId?: string;
  readonly internalDate?: string;
  readonly labelIds?: readonly string[];
  readonly snippet?: string;
  readonly sizeEstimate?: number;
  readonly payload?: GmailMessagePart;
  readonly raw?: string;
}

export interface GmailMessageListPage {
  readonly messages: readonly { readonly id: string }[];
  readonly nextPageToken: string | null;
}

export interface GmailHistoryRecord {
  readonly id: string;
  readonly messages?: readonly { readonly id: string }[];
  readonly messagesAdded?: readonly { readonly message?: { readonly id?: string } }[];
  readonly messagesDeleted?: readonly { readonly message?: { readonly id?: string } }[];
  readonly labelsAdded?: readonly { readonly message?: { readonly id?: string } }[];
  readonly labelsRemoved?: readonly { readonly message?: { readonly id?: string } }[];
}

export interface GmailHistoryPage {
  readonly history: readonly GmailHistoryRecord[];
  readonly historyId: string | null;
  readonly nextPageToken: string | null;
}

export interface GmailRequestPolicy {
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly signal?: AbortSignal;
}

export interface GmailApiPort {
  getIdentity(
    authorization: GmailAuthorizationSession,
    policy: GmailRequestPolicy,
  ): Promise<GmailIdentity>;
  getProfile(
    authorization: GmailAuthorizationSession,
    policy: GmailRequestPolicy,
  ): Promise<GmailProfile>;
  listMessages(
    authorization: GmailAuthorizationSession,
    request: {
      readonly pageToken: string | null;
      readonly maxResults: number;
      readonly includeSpamTrash: true;
    },
    policy: GmailRequestPolicy,
  ): Promise<GmailMessageListPage>;
  listHistory(
    authorization: GmailAuthorizationSession,
    request: {
      readonly startHistoryId: string;
      readonly pageToken: string | null;
      readonly maxResults: number;
    },
    policy: GmailRequestPolicy,
  ): Promise<GmailHistoryPage>;
  getMessage(
    authorization: GmailAuthorizationSession,
    messageId: string,
    policy: GmailRequestPolicy,
  ): Promise<GmailMessage | null>;
}

export interface BoundedHttpRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly signal?: AbortSignal;
}

export interface BoundedHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}

/**
 * Adapter must enforce both timeoutMs and maxResponseBytes before returning.
 * Authorization headers and request/response bodies are sensitive and must
 * never be logged, traced, or included in thrown error messages.
 */
export interface BoundedHttpClientPort {
  request(request: BoundedHttpRequest): Promise<BoundedHttpResponse>;
}

export type GmailCursorJson = JsonValue;

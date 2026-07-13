import {
  BeginOAuthConnectionRequestSchema,
  BeginOAuthConnectionResponseSchema,
  ConnectionActionRequestSchema,
  ConnectionIdSchema,
  ConnectionListResponseSchema,
  ConnectionMutationResponseSchema,
  DeviceListResponseSchema,
  DevicePairingCodeResponseSchema,
  LifecycleJobListResponseSchema,
  LifecycleRequestResponseSchema,
  OwnTracksConnectionRequestSchema,
  PersonalAccessTokenMetadataSchema,
  PersonalAccessTokenIssueRequestSchema,
  PersonalAccessTokenIssueResponseSchema,
  PersonalAccessTokenListResponseSchema,
  WorkspaceDeletionRequestSchema,
  parseSearchRequest,
  parseSearchResponse,
  parseWorkspaceId,
  type BeginOAuthConnectionRequest,
  type BeginOAuthConnectionResponse,
  type ConnectionActionRequest,
  type ConnectionListResponse,
  type ConnectionMutationResponse,
  type DeviceListResponse,
  type DevicePairingCodeResponse,
  type LifecycleJobListResponse,
  type LifecycleRequestResponse,
  type OwnTracksConnectionRequest,
  type PersonalAccessTokenIssueRequest,
  type PersonalAccessTokenIssueResponse,
  type PersonalAccessTokenListResponse,
  type SearchRequestInput,
  type SearchResponse,
} from '@botmem-v2/contracts';
import type {
  AccountApplicationService,
  ConnectionsApplicationService,
  DevicesApplicationService,
  SearchApplicationService,
} from './application-service.js';

export interface HttpRequest {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface HttpTransport {
  request(request: HttpRequest): Promise<HttpResponse>;
}

export interface FetchHttpTransportOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly credentials?: RequestCredentials;
}

/** Fetch transport used by the published SDK and CLI binary. */
export class FetchHttpTransport implements HttpTransport {
  private readonly baseUrl: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly credentials: RequestCredentials;

  constructor(options: FetchHttpTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    this.fetch = fetchImplementation?.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.credentials = options.credentials ?? 'same-origin';
    if (!this.fetch) throw new Error('global fetch is unavailable');
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 60_000) {
      throw new RangeError('HTTP timeout must be an integer between 1 and 60000 milliseconds');
    }
  }

  async request(request: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}${request.path}`, {
        method: request.method,
        headers:
          request.body === undefined
            ? request.headers
            : { 'content-type': 'application/json', ...request.headers },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        credentials: this.credentials,
        signal: controller.signal,
      });
      const text = await response.text();
      return {
        status: response.status,
        body: parseJsonBody(text),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseJsonBody(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface SearchApiClientOptions {
  readonly transport: HttpTransport;
  readonly authentication: ApiAuthentication;
}

export type ApiAuthentication =
  | { readonly kind: 'bearer'; readonly accessToken: string }
  | { readonly kind: 'ambient-session' };

/**
 * Generated-style API client: validates request/response contracts at the
 * network boundary and exposes the same application port as the domain.
 */
export class SearchApiClient implements SearchApplicationService {
  constructor(private readonly options: SearchApiClientOptions) {
    if (options.authentication.kind === 'bearer' && !options.authentication.accessToken.trim()) {
      throw new Error('access token is required');
    }
  }

  async search(workspaceId: string, input: SearchRequestInput): Promise<SearchResponse> {
    const validatedWorkspaceId = parseWorkspaceId(workspaceId);
    const request = parseSearchRequest(input);
    const response = await this.options.transport.request({
      method: 'POST',
      path: `/v2/workspaces/${encodeURIComponent(validatedWorkspaceId)}/search`,
      headers:
        this.options.authentication.kind === 'bearer'
          ? { authorization: `Bearer ${this.options.authentication.accessToken}` }
          : {},
      body: request,
    });

    if (response.status < 200 || response.status >= 300) {
      throw BotmemApiError.fromResponse(response.status, response.body);
    }
    return parseSearchResponse(response.body);
  }
}

export interface ConnectionsApiClientOptions {
  readonly transport: HttpTransport;
  readonly authentication: ApiAuthentication;
}

export class ConnectionsApiClient implements ConnectionsApplicationService {
  constructor(private readonly options: ConnectionsApiClientOptions) {
    assertAuthentication(options.authentication);
  }

  async listConnections(workspaceId: string): Promise<ConnectionListResponse> {
    const response = await this.request(
      'GET',
      `/v2/workspaces/${encodeURIComponent(parseWorkspaceId(workspaceId))}/connections`,
    );
    return ConnectionListResponseSchema.parse(response);
  }

  async beginOAuthConnection(
    workspaceId: string,
    input: BeginOAuthConnectionRequest,
  ): Promise<BeginOAuthConnectionResponse> {
    const body = BeginOAuthConnectionRequestSchema.parse(input);
    const response = await this.request(
      'POST',
      `/v2/workspaces/${encodeURIComponent(parseWorkspaceId(workspaceId))}/connections/oauth`,
      body,
    );
    return BeginOAuthConnectionResponseSchema.parse(response);
  }

  async connectOwnTracks(
    workspaceId: string,
    input: OwnTracksConnectionRequest,
  ): Promise<ConnectionMutationResponse> {
    const body = OwnTracksConnectionRequestSchema.parse(input);
    const response = await this.request(
      'POST',
      `/v2/workspaces/${encodeURIComponent(parseWorkspaceId(workspaceId))}/connections/owntracks`,
      body,
    );
    return ConnectionMutationResponseSchema.parse(response);
  }

  async actOnConnection(
    workspaceId: string,
    connectionId: string,
    input: ConnectionActionRequest,
  ): Promise<ConnectionMutationResponse> {
    const validatedConnectionId = ConnectionIdSchema.parse(connectionId);
    const body = ConnectionActionRequestSchema.parse(input);
    const response = await this.request(
      'POST',
      `/v2/workspaces/${encodeURIComponent(parseWorkspaceId(workspaceId))}/connections/${encodeURIComponent(validatedConnectionId)}/actions`,
      body,
    );
    return ConnectionMutationResponseSchema.parse(response);
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const response = await this.options.transport.request({
      method,
      path,
      headers: authorizationHeaders(this.options.authentication),
      ...(body === undefined ? {} : { body }),
    });
    if (response.status < 200 || response.status >= 300) {
      throw BotmemApiError.fromResponse(response.status, response.body);
    }
    return response.body;
  }
}

export class DevicesApiClient implements DevicesApplicationService {
  constructor(private readonly options: ConnectionsApiClientOptions) {
    assertAuthentication(options.authentication);
  }

  async listDevices(workspaceId: string): Promise<DeviceListResponse> {
    const response = await this.options.transport.request({
      method: 'GET',
      path: `/v2/workspaces/${encodeURIComponent(parseWorkspaceId(workspaceId))}/devices`,
      headers: authorizationHeaders(this.options.authentication),
    });
    if (response.status < 200 || response.status >= 300) {
      throw BotmemApiError.fromResponse(response.status, response.body);
    }
    return DeviceListResponseSchema.parse(response.body);
  }

  async issuePairingCode(workspaceId: string): Promise<DevicePairingCodeResponse> {
    const response = await this.options.transport.request({
      method: 'POST',
      path: `/v2/workspaces/${encodeURIComponent(parseWorkspaceId(workspaceId))}/devices/pairing-codes`,
      headers: authorizationHeaders(this.options.authentication),
    });
    if (response.status < 200 || response.status >= 300) {
      throw BotmemApiError.fromResponse(response.status, response.body);
    }
    return DevicePairingCodeResponseSchema.parse(response.body);
  }
}

export class AccountApiClient implements AccountApplicationService {
  constructor(private readonly transport: HttpTransport) {}

  async listPersonalAccessTokens(workspaceId: string): Promise<PersonalAccessTokenListResponse> {
    return PersonalAccessTokenListResponseSchema.parse(
      await this.request(
        'GET',
        `/v2/workspaces/${encodeURIComponent(parseWorkspaceId(workspaceId))}/pats`,
      ),
    );
  }

  async issuePersonalAccessToken(
    workspaceId: string,
    input: PersonalAccessTokenIssueRequest,
  ): Promise<PersonalAccessTokenIssueResponse> {
    return PersonalAccessTokenIssueResponseSchema.parse(
      await this.request(
        'POST',
        `/v2/workspaces/${encodeURIComponent(parseWorkspaceId(workspaceId))}/pats`,
        PersonalAccessTokenIssueRequestSchema.parse(input),
      ),
    );
  }

  async revokePersonalAccessToken(workspaceId: string, credentialId: string): Promise<void> {
    await this.request(
      'DELETE',
      `/v2/workspaces/${encodeURIComponent(parseWorkspaceId(workspaceId))}/pats/${encodeURIComponent(PersonalAccessTokenMetadataSchema.shape.credentialId.parse(credentialId))}`,
    );
  }

  async listLifecycleJobs(workspaceId: string): Promise<LifecycleJobListResponse> {
    return LifecycleJobListResponseSchema.parse(
      await this.request(
        'GET',
        `/v2/workspaces/${encodeURIComponent(parseWorkspaceId(workspaceId))}/lifecycle/jobs`,
      ),
    );
  }

  async requestWorkspaceExport(workspaceId: string): Promise<LifecycleRequestResponse> {
    return LifecycleRequestResponseSchema.parse(
      await this.request(
        'POST',
        `/v2/workspaces/${encodeURIComponent(parseWorkspaceId(workspaceId))}/lifecycle/exports`,
      ),
    );
  }

  async requestWorkspaceDeletion(
    workspaceId: string,
    confirmation: string,
  ): Promise<LifecycleRequestResponse> {
    return LifecycleRequestResponseSchema.parse(
      await this.request(
        'POST',
        `/v2/workspaces/${encodeURIComponent(parseWorkspaceId(workspaceId))}/lifecycle/deletion`,
        WorkspaceDeletionRequestSchema.parse({ version: 2, confirmation }),
      ),
    );
  }

  async signOut(): Promise<void> {
    await this.request('DELETE', '/v2/session');
  }

  private async request(
    method: HttpRequest['method'],
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await this.transport.request({
      method,
      path,
      headers: {},
      ...(body === undefined ? {} : { body }),
    });
    if (response.status < 200 || response.status >= 300) {
      throw BotmemApiError.fromResponse(response.status, response.body);
    }
    return response.body;
  }
}

export class BotmemApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BotmemApiError';
  }

  static fromResponse(status: number, body: unknown): BotmemApiError {
    if (isErrorEnvelope(body)) {
      return new BotmemApiError(status, body.error.code, body.error.message);
    }
    return new BotmemApiError(status, 'unexpected_response', `Botmem API returned HTTP ${status}`);
  }
}

function isErrorEnvelope(body: unknown): body is {
  error: { code: string; message: string };
} {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false;
  const error = body.error;
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    'message' in error &&
    typeof error.message === 'string'
  );
}

function assertAuthentication(authentication: ApiAuthentication): void {
  if (authentication.kind === 'bearer' && !authentication.accessToken.trim()) {
    throw new Error('access token is required');
  }
}

function authorizationHeaders(authentication: ApiAuthentication): Readonly<Record<string, string>> {
  return authentication.kind === 'bearer'
    ? { authorization: `Bearer ${authentication.accessToken}` }
    : {};
}

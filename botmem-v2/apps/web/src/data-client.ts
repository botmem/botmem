import {
  parseBrowserSession,
  DeviceSetupPayloadSchema,
  SourceStatusSchema,
  type BeginOAuthConnectionRequest,
  type BeginOAuthConnectionResponse,
  type BrowserSession,
  type ConnectionActionRequest,
  type ConnectionListResponse,
  type ConnectionMutationResponse,
  type DeviceListResponse,
  type DevicePairingCodeResponse,
  EmailLoginAcceptedResponseSchema,
  EmailLoginCompleteRequestSchema,
  EmailLoginStartRequestSchema,
  BillingCheckoutRequestSchema,
  BillingCheckoutResponseSchema,
  BillingCheckoutStatusResponseSchema,
  BillingPriceResponseSchema,
  StripeCheckoutSessionIdSchema,
  BillingPortalResponseSchema,
  BillingStatusResponseSchema,
  type BillingCheckoutRequest,
  type BillingCheckoutResponse,
  type BillingCheckoutStatusResponse,
  type BillingPortalResponse,
  type BillingPriceResponse,
  type BillingStatusResponse,
  type EmailLoginAcceptedResponse,
  type EmailLoginStartRequest,
  LifecycleJobSchema,
  PublicReleaseConfigurationSchema,
  type OwnTracksConnectionRequest,
  type PublicReleaseConfiguration,
  WorkspaceIdSchema,
  type SearchRequestInput,
  type SearchResponse,
  type SourceStatus,
} from '@botmem-v2/contracts';
import {
  AccountApiClient,
  FetchHttpTransport,
  ConnectionsApiClient,
  DevicesApiClient,
  SearchApiClient,
  type ConnectionsApplicationService,
  type AccountApplicationService,
  type DevicesApplicationService,
  type SearchApplicationService,
} from '@botmem-v2/sdk';

export interface BotmemWebClient
  extends
    SearchApplicationService,
    ConnectionsApplicationService,
    DevicesApplicationService,
    AccountApplicationService {
  startEmailLogin(input: EmailLoginStartRequest): Promise<EmailLoginAcceptedResponse>;
  getPublicReleases(signal?: AbortSignal): Promise<PublicReleaseConfiguration>;
  getBillingPrice(signal?: AbortSignal): Promise<BillingPriceResponse>;
  createBillingCheckout(input: BillingCheckoutRequest): Promise<BillingCheckoutResponse>;
  getBillingCheckoutStatus(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<BillingCheckoutStatusResponse>;
  getBillingStatus(workspaceId: string): Promise<BillingStatusResponse>;
  createBillingPortal(workspaceId: string): Promise<BillingPortalResponse>;
  completeEmailLogin(token: string): Promise<void>;
  issuePairingCode(workspaceId: string): Promise<DevicePairingCodeResponse>;
  issueDeviceSetup(workspaceId: string): Promise<{
    readonly payload: string;
    readonly expiresAt: string;
  }>;
  listSourceStatuses(workspaceId: string, signal?: AbortSignal): Promise<readonly SourceStatus[]>;
  downloadWorkspaceExport(workspaceId: string, jobId: string): Promise<Blob>;
}

export interface BrowserBotmemClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
}

/** Browser adapter over the versioned API. It never supplies fallback data. */
export class BrowserBotmemClient implements BotmemWebClient {
  private readonly baseUrl: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly searchApi: SearchApiClient;
  private readonly connectionsApi: ConnectionsApiClient;
  private readonly devicesApi: DevicesApiClient;
  private readonly accountApi: AccountApiClient;

  constructor(options: BrowserBotmemClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    if (!fetchImplementation) throw new Error('global fetch is unavailable');
    // Native browser fetch validates its receiver. Bind it once so assigning it
    // to this adapter cannot turn a valid Window fetch into an illegal call.
    this.fetch = fetchImplementation.bind(globalThis);
    const transport = new FetchHttpTransport({
      baseUrl: this.baseUrl,
      fetch: this.fetch,
      credentials: 'include',
    });
    const authentication = { kind: 'ambient-session' as const };
    this.searchApi = new SearchApiClient({ transport, authentication });
    this.connectionsApi = new ConnectionsApiClient({ transport, authentication });
    this.devicesApi = new DevicesApiClient({ transport, authentication });
    this.accountApi = new AccountApiClient(transport);
  }

  async getSession(signal?: AbortSignal): Promise<BrowserSession> {
    const response = await this.fetch(`${this.baseUrl}/v2/session`, {
      method: 'GET',
      credentials: 'include',
      headers: { accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });
    const body = await responseBody(response);
    if (!response.ok) throw new WebApiError(response.status, errorMessage(body));
    return parseBrowserSession(body);
  }

  async startEmailLogin(input: EmailLoginStartRequest): Promise<EmailLoginAcceptedResponse> {
    const payload = EmailLoginStartRequestSchema.parse(input);
    const response = await this.fetch(`${this.baseUrl}/v2/auth/email/start`, {
      method: 'POST',
      credentials: 'include',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await responseBody(response);
    if (!response.ok) throw new WebApiError(response.status, errorMessage(body));
    return EmailLoginAcceptedResponseSchema.parse(body);
  }

  async getPublicReleases(signal?: AbortSignal): Promise<PublicReleaseConfiguration> {
    const response = await this.fetch(`${this.baseUrl}/v2/public/releases`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });
    const body = await responseBody(response);
    if (!response.ok) throw new WebApiError(response.status, errorMessage(body));
    return PublicReleaseConfigurationSchema.parse(body);
  }

  async completeEmailLogin(token: string): Promise<void> {
    const payload = EmailLoginCompleteRequestSchema.parse({ token });
    const response = await this.fetch(`${this.baseUrl}/v2/auth/email/complete`, {
      method: 'POST',
      credentials: 'include',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await responseBody(response);
    if (!response.ok) throw new WebApiError(response.status, errorMessage(body));
    if (response.status !== 204) throw new WebApiError(502, 'Sign-in response is malformed');
  }

  async createBillingCheckout(input: BillingCheckoutRequest): Promise<BillingCheckoutResponse> {
    const payload = BillingCheckoutRequestSchema.parse(input);
    const response = await this.fetch(`${this.baseUrl}/v2/billing/checkout`, {
      method: 'POST',
      credentials: 'include',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await responseBody(response);
    if (!response.ok) throw new WebApiError(response.status, errorMessage(body));
    return BillingCheckoutResponseSchema.parse(body);
  }

  async getBillingPrice(signal?: AbortSignal): Promise<BillingPriceResponse> {
    const response = await this.fetch(`${this.baseUrl}/v2/billing/price`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });
    const body = await responseBody(response);
    if (!response.ok) throw new WebApiError(response.status, errorMessage(body));
    return BillingPriceResponseSchema.parse(body);
  }

  async getBillingCheckoutStatus(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<BillingCheckoutStatusResponse> {
    const response = await this.fetch(`${this.baseUrl}/v2/billing/checkout/status`, {
      method: 'POST',
      credentials: 'include',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: StripeCheckoutSessionIdSchema.parse(sessionId) }),
      ...(signal ? { signal } : {}),
    });
    const body = await responseBody(response);
    if (!response.ok) throw new WebApiError(response.status, errorMessage(body));
    return BillingCheckoutStatusResponseSchema.parse(body);
  }

  async getBillingStatus(workspaceId: string): Promise<BillingStatusResponse> {
    const response = await this.fetch(
      `${this.baseUrl}/v2/workspaces/${encodeURIComponent(workspaceId)}/billing`,
      { method: 'GET', credentials: 'include', headers: { accept: 'application/json' } },
    );
    const body = await responseBody(response);
    if (!response.ok) throw new WebApiError(response.status, errorMessage(body));
    return BillingStatusResponseSchema.parse(body);
  }

  async createBillingPortal(workspaceId: string): Promise<BillingPortalResponse> {
    const response = await this.fetch(
      `${this.baseUrl}/v2/workspaces/${encodeURIComponent(workspaceId)}/billing/portal`,
      { method: 'POST', credentials: 'include', headers: { accept: 'application/json' } },
    );
    const body = await responseBody(response);
    if (!response.ok) throw new WebApiError(response.status, errorMessage(body));
    return BillingPortalResponseSchema.parse(body);
  }

  search(workspaceId: string, input: SearchRequestInput): Promise<SearchResponse> {
    return this.searchApi.search(workspaceId, input);
  }

  listConnections(workspaceId: string): Promise<ConnectionListResponse> {
    return this.connectionsApi.listConnections(workspaceId);
  }

  beginOAuthConnection(
    workspaceId: string,
    input: BeginOAuthConnectionRequest,
  ): Promise<BeginOAuthConnectionResponse> {
    return this.connectionsApi.beginOAuthConnection(workspaceId, input);
  }

  connectOwnTracks(
    workspaceId: string,
    input: OwnTracksConnectionRequest,
  ): Promise<ConnectionMutationResponse> {
    return this.connectionsApi.connectOwnTracks(workspaceId, input);
  }

  actOnConnection(
    workspaceId: string,
    connectionId: string,
    input: ConnectionActionRequest,
  ): Promise<ConnectionMutationResponse> {
    return this.connectionsApi.actOnConnection(workspaceId, connectionId, input);
  }

  listDevices(workspaceId: string): Promise<DeviceListResponse> {
    return this.devicesApi.listDevices(workspaceId);
  }

  issuePairingCode(workspaceId: string) {
    return this.devicesApi.issuePairingCode(workspaceId);
  }

  async issueDeviceSetup(workspaceId: string): Promise<{
    readonly payload: string;
    readonly expiresAt: string;
  }> {
    const issued = await this.issuePairingCode(workspaceId);
    const setup = DeviceSetupPayloadSchema.parse({
      protocolVersion: 'botmem.device.setup.v1',
      apiBaseUrl: new URL(this.baseUrl).origin + '/',
      workspaceId,
      code: issued.code,
    });
    return Object.freeze({ payload: JSON.stringify(setup), expiresAt: issued.expiresAt });
  }

  async listSourceStatuses(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<readonly SourceStatus[]> {
    if (!workspaceId.trim()) throw new Error('workspace id is required');
    const response = await this.fetch(
      `${this.baseUrl}/v2/workspaces/${encodeURIComponent(workspaceId)}/sources`,
      {
        method: 'GET',
        credentials: 'include',
        headers: {
          accept: 'application/json',
        },
        ...(signal ? { signal } : {}),
      },
    );
    const body = await responseBody(response);
    if (!response.ok) {
      throw new WebApiError(response.status, errorMessage(body));
    }
    if (!Array.isArray(body)) throw new WebApiError(502, 'Source status response is malformed');
    return body.map((source) => SourceStatusSchema.parse(source));
  }

  listPersonalAccessTokens(workspaceId: string) {
    return this.accountApi.listPersonalAccessTokens(workspaceId);
  }

  issuePersonalAccessToken(
    workspaceId: string,
    input: Parameters<AccountApiClient['issuePersonalAccessToken']>[1],
  ) {
    return this.accountApi.issuePersonalAccessToken(workspaceId, input);
  }

  revokePersonalAccessToken(workspaceId: string, credentialId: string): Promise<void> {
    return this.accountApi.revokePersonalAccessToken(workspaceId, credentialId);
  }

  listLifecycleJobs(workspaceId: string) {
    return this.accountApi.listLifecycleJobs(workspaceId);
  }

  requestWorkspaceExport(workspaceId: string) {
    return this.accountApi.requestWorkspaceExport(workspaceId);
  }

  requestWorkspaceDeletion(workspaceId: string, confirmation: string) {
    return this.accountApi.requestWorkspaceDeletion(workspaceId, confirmation);
  }

  signOut(): Promise<void> {
    return this.accountApi.signOut();
  }

  async downloadWorkspaceExport(workspaceId: string, jobId: string): Promise<Blob> {
    const validatedWorkspace = WorkspaceIdSchema.parse(workspaceId);
    const validatedJob = LifecycleJobSchema.shape.jobId.parse(jobId);
    const response = await this.fetch(
      `${this.baseUrl}/v2/workspaces/${encodeURIComponent(validatedWorkspace)}/lifecycle/exports/${encodeURIComponent(validatedJob)}/download`,
      { method: 'GET', credentials: 'include', headers: { accept: 'application/x-ndjson' } },
    );
    if (!response.ok) {
      const body = await responseBody(response);
      throw new WebApiError(response.status, errorMessage(body));
    }
    return response.blob();
  }
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  return text ? (JSON.parse(text) as unknown) : null;
}

export class WebApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'WebApiError';
  }
}

function errorMessage(body: unknown): string {
  if (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof body.error === 'object' &&
    body.error !== null &&
    'message' in body.error &&
    typeof body.error.message === 'string'
  ) {
    return body.error.message;
  }
  return 'Botmem API request failed';
}

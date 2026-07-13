import {
  BeginOAuthConnectionResponseSchema,
  ConnectionListResponseSchema,
  ConnectionMutationResponseSchema,
  HostedConnectionSchema,
  OwnTracksConnectionRequestSchema,
  type BeginOAuthConnectionRequest,
  type BeginOAuthConnectionResponse,
  type ConnectionActionRequest,
  type ConnectionListResponse,
  type ConnectionMutationResponse,
  type HostedConnection,
  type SourceStatus,
} from '@botmem-v2/contracts';
import { connectorAccountId, tenantId } from '@botmem-v2/connector-domain';
import type { ConnectionsApplicationService } from '@botmem-v2/sdk';
import type { GmailOAuthService } from '../connectors/gmail/index.js';
import type { OutlookOAuthService } from '../connectors/outlook/index.js';
import type { OwnTracksEndpointPolicy } from '../connectors/owntracks/index.js';
import type { NodeConnectorCrypto } from './key-ring.js';
import {
  HostedConnectionNotFoundError,
  HostedConnectionUnavailableError,
  type ConnectionAccountRecord,
  type ConnectionAccountRepository,
  type ConnectionSourceStatusPort,
  type ConnectorCredentialVault,
  type HostedSyncSchedulerPort,
} from './ports.js';

export interface OAuthCallbackPort {
  completeGmail(input: {
    readonly state: string;
    readonly code?: string;
    readonly error?: string;
    readonly signal?: AbortSignal;
  }): Promise<ConnectionMutationResponse>;
  completeOutlook(input: {
    readonly state: string;
    readonly code?: string;
    readonly error?: string;
    readonly signal?: AbortSignal;
  }): Promise<ConnectionMutationResponse>;
}

export interface HostedConnectionsServiceDependencies {
  readonly accounts: ConnectionAccountRepository;
  readonly vault: ConnectorCredentialVault;
  readonly gmail: GmailOAuthService;
  readonly outlook: OutlookOAuthService;
  readonly ownTracksEndpointPolicy: OwnTracksEndpointPolicy;
  readonly sourceStatuses: ConnectionSourceStatusPort;
  readonly scheduler: HostedSyncSchedulerPort;
  readonly crypto: Pick<NodeConnectorCrypto, 'sha256Hex'>;
  readonly now?: () => string;
}

export class HostedConnectionsService implements ConnectionsApplicationService, OAuthCallbackPort {
  private readonly now: () => string;

  constructor(private readonly dependencies: HostedConnectionsServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  async listConnections(workspaceId: string): Promise<ConnectionListResponse> {
    const workspace = tenantId(workspaceId);
    const records = await this.dependencies.accounts.list(workspace);
    const statuses = await this.readSourceStatuses(workspaceId);
    return ConnectionListResponseSchema.parse({
      version: 2,
      items: records.map((record) => this.present(record, statuses.get(record.connector))),
    });
  }

  async beginOAuthConnection(
    workspaceId: string,
    input: BeginOAuthConnectionRequest,
  ): Promise<BeginOAuthConnectionResponse> {
    const workspace = tenantId(workspaceId);
    const accountId = await this.dependencies.accounts.reserveAccountId(workspace, input.connector);
    const authorization = await (input.connector === 'gmail'
      ? this.dependencies.gmail.beginAuthorization({ tenantId: workspace, accountId })
      : this.dependencies.outlook.beginAuthorization({ tenantId: workspace, accountId }));
    return BeginOAuthConnectionResponseSchema.parse({
      version: 2,
      connector: input.connector,
      accountId,
      authorizationUrl: authorization.authorizationUrl,
      expiresAt: authorization.expiresAt,
    });
  }

  async completeGmail(input: Parameters<OAuthCallbackPort['completeGmail']>[0]) {
    const completed = await this.dependencies.gmail.completeAuthorization(input);
    return this.finishOAuth({
      ...completed,
      connector: 'gmail',
      authKind: 'oauth2',
      displayLabel: completed.emailAddress,
      initialCursor: completed.initialCursor,
    });
  }

  async completeOutlook(input: Parameters<OAuthCallbackPort['completeOutlook']>[0]) {
    const completed = await this.dependencies.outlook.completeAuthorization(input);
    return this.finishOAuth({
      ...completed,
      connector: 'outlook',
      authKind: 'oauth2',
      displayLabel: completed.displayAddress ?? 'Microsoft Outlook',
      initialCursor: completed.initialCursor,
    });
  }

  async connectOwnTracks(
    workspaceId: string,
    input: Parameters<ConnectionsApplicationService['connectOwnTracks']>[1],
  ): Promise<ConnectionMutationResponse> {
    const validated = OwnTracksConnectionRequestSchema.parse(input);
    const workspace = tenantId(workspaceId);
    const accountId = await this.dependencies.accounts.reserveAccountId(workspace, 'owntracks');
    const owner = { tenantId: workspace, accountId, connector: 'owntracks' as const };
    if (validated.username.includes(':')) throw new HostedConnectionUnavailableError();
    const endpoint = await this.dependencies.ownTracksEndpointPolicy.configure({
      endpoint: validated.endpoint,
    });
    const credentialRef = await this.dependencies.vault.store(owner, {
      kind: 'owntracks_basic',
      value: { username: validated.username, password: validated.password },
    });
    let record: ConnectionAccountRecord;
    try {
      const providerSubjectHash = await this.dependencies.crypto.sha256Hex(
        `owntracks:${endpoint.endpoint}:${validated.username}`,
      );
      record = await this.dependencies.accounts.completeConnection({
        ...owner,
        authKind: 'basic',
        providerSubjectHash,
        credentialRef,
        displayLabel: `OwnTracks · ${new URL(endpoint.endpoint).hostname}`,
        connectionConfig: {
          endpoint: endpoint.endpoint,
          allowedPorts: [...endpoint.allowedPorts],
        },
        initialCursor: {},
        connectedAt: this.now(),
      });
    } catch (error) {
      await this.dependencies.vault.revoke(owner, credentialRef).catch(() => undefined);
      throw error;
    }
    await this.dependencies.scheduler.enqueue(owner);
    return ConnectionMutationResponseSchema.parse({
      version: 2,
      connection: this.present(record, undefined, 'syncing'),
    });
  }

  async actOnConnection(
    workspaceId: string,
    connectionId: string,
    input: ConnectionActionRequest,
  ): Promise<ConnectionMutationResponse> {
    const workspace = tenantId(workspaceId);
    const accountId = connectorAccountId(connectionId);
    const current = await this.dependencies.accounts.get(workspace, accountId);
    if (!current) throw new HostedConnectionNotFoundError();
    if (input.action === 'sync') {
      if (current.status !== 'ready' && current.status !== 'degraded') {
        throw new HostedConnectionUnavailableError();
      }
      await this.dependencies.scheduler.enqueue({
        tenantId: workspace,
        accountId,
        connector: current.connector,
      });
      return ConnectionMutationResponseSchema.parse({
        version: 2,
        connection: this.present(current, undefined, 'syncing'),
      });
    }

    if (current.status === 'disconnected') {
      await this.dependencies.vault.revoke(
        { tenantId: workspace, accountId, connector: current.connector },
        current.credentialRef,
      );
      return ConnectionMutationResponseSchema.parse({
        version: 2,
        connection: this.present(current, undefined),
      });
    }
    const disconnected = await this.dependencies.accounts.disconnect(
      workspace,
      accountId,
      this.now(),
    );
    await this.dependencies.vault.revoke(
      { tenantId: workspace, accountId, connector: current.connector },
      current.credentialRef,
    );
    return ConnectionMutationResponseSchema.parse({
      version: 2,
      connection: this.present(disconnected, undefined),
    });
  }

  private async finishOAuth(input: {
    readonly tenantId: ConnectionAccountRecord['tenantId'];
    readonly accountId: ConnectionAccountRecord['accountId'];
    readonly connector: 'gmail' | 'outlook';
    readonly authKind: 'oauth2';
    readonly credentialRef: string;
    readonly providerSubjectHash: string;
    readonly displayLabel: string;
    readonly initialCursor: Parameters<
      ConnectionAccountRepository['completeConnection']
    >[0]['initialCursor'];
  }): Promise<ConnectionMutationResponse> {
    const owner = {
      tenantId: input.tenantId,
      accountId: input.accountId,
      connector: input.connector,
    } as const;
    let record: ConnectionAccountRecord;
    try {
      record = await this.dependencies.accounts.completeConnection({
        ...owner,
        authKind: input.authKind,
        providerSubjectHash: input.providerSubjectHash,
        credentialRef: input.credentialRef,
        displayLabel: input.displayLabel,
        connectionConfig: {},
        initialCursor: input.initialCursor,
        connectedAt: this.now(),
      });
    } catch (error) {
      await this.dependencies.vault.revoke(owner, input.credentialRef).catch(() => undefined);
      throw error;
    }
    await this.dependencies.scheduler.enqueue(owner);
    return ConnectionMutationResponseSchema.parse({
      version: 2,
      connection: this.present(record, undefined, 'syncing'),
    });
  }

  private async readSourceStatuses(workspaceId: string): Promise<Map<string, SourceStatus>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1_000);
    try {
      const statuses = await this.dependencies.sourceStatuses.list(workspaceId, controller.signal);
      return new Map(statuses.map((status) => [status.connector, status]));
    } catch {
      return new Map();
    } finally {
      clearTimeout(timeout);
    }
  }

  private present(
    record: ConnectionAccountRecord,
    source: SourceStatus | undefined,
    stateOverride?: HostedConnection['state'],
  ): HostedConnection {
    const resolvedSource = source ?? fallbackSource(record);
    const state =
      stateOverride ??
      (record.activeSync ? 'syncing' : record.status === 'degraded' ? 'degraded' : record.status);
    return HostedConnectionSchema.parse({
      id: record.accountId,
      connector: record.connector,
      authType: record.authKind,
      label: record.displayLabel,
      state,
      source: resolvedSource,
      ...(record.lastSyncAt ? { lastSyncAt: record.lastSyncAt } : {}),
      ...(record.failureCode ? { failureCode: record.failureCode } : {}),
    });
  }
}

function fallbackSource(record: ConnectionAccountRecord): SourceStatus {
  if (record.status === 'disconnected' || record.status === 'revoked') {
    return {
      connector: record.connector,
      readiness: 'disconnected',
      searchable: false,
    };
  }
  if (record.activeSync) {
    return {
      connector: record.connector,
      readiness: 'indexing',
      searchable: false,
      reasonCode: 'sync_in_progress',
    };
  }
  return {
    connector: record.connector,
    readiness: record.status === 'degraded' ? 'degraded' : 'connected',
    searchable: false,
    reasonCode:
      record.status === 'degraded'
        ? (record.failureCode ?? 'connector_degraded')
        : 'first_checkpoint_pending',
  };
}

import type { HostedConnection, HostedConnector, SourceStatus } from '@botmem-v2/contracts';
import type { ConnectorAccountId, JsonValue, TenantId } from '@botmem-v2/connector-domain';

export interface ConnectionOwner {
  readonly tenantId: TenantId;
  readonly accountId: ConnectorAccountId;
}

export interface OwnedConnector extends ConnectionOwner {
  readonly connector: HostedConnector;
}

export type ConnectorSecretKind = 'gmail_oauth' | 'outlook_oauth' | 'owntracks_basic';

export interface ConnectorCredentialSecret {
  readonly kind: ConnectorSecretKind;
  readonly value: unknown;
}

export interface ConnectorCredentialVault {
  store(owner: OwnedConnector, secret: ConnectorCredentialSecret): Promise<string>;
  read(
    owner: OwnedConnector,
    credentialRef: string,
    expectedKind: ConnectorSecretKind,
  ): Promise<unknown>;
  rotate(
    owner: OwnedConnector,
    credentialRef: string,
    secret: ConnectorCredentialSecret,
  ): Promise<void>;
  rewrapToCurrentKey(owner: OwnedConnector, credentialRef: string): Promise<boolean>;
  revoke(owner: OwnedConnector, credentialRef: string): Promise<void>;
}

export interface ConnectionAccountRecord extends OwnedConnector {
  readonly authKind: 'oauth2' | 'basic';
  readonly providerSubjectHash: string;
  readonly credentialRef: string;
  readonly status: 'disconnected' | 'ready' | 'degraded' | 'revoked';
  readonly displayLabel: string;
  readonly connectionConfig: JsonValue;
  readonly activeSync: boolean;
  readonly lastSyncAt: string | null;
  readonly failureCode: string | null;
}

export interface CompleteConnectionCommand extends OwnedConnector {
  readonly authKind: 'oauth2' | 'basic';
  readonly providerSubjectHash: string;
  readonly credentialRef: string;
  readonly displayLabel: string;
  readonly connectionConfig: JsonValue;
  readonly initialCursor: JsonValue;
  readonly connectedAt: string;
}

export interface ConnectionAccountRepository {
  reserveAccountId(tenantId: TenantId, connector: HostedConnector): Promise<ConnectorAccountId>;
  completeConnection(command: CompleteConnectionCommand): Promise<ConnectionAccountRecord>;
  list(tenantId: TenantId): Promise<readonly ConnectionAccountRecord[]>;
  get(tenantId: TenantId, accountId: ConnectorAccountId): Promise<ConnectionAccountRecord | null>;
  disconnect(
    tenantId: TenantId,
    accountId: ConnectorAccountId,
    disconnectedAt: string,
  ): Promise<ConnectionAccountRecord>;
}

export interface HostedSyncSchedulerPort {
  enqueue(input: {
    readonly tenantId: TenantId;
    readonly accountId: ConnectorAccountId;
    readonly connector: HostedConnector;
  }): Promise<void>;
}

export interface ConnectionSourceStatusPort {
  list(workspaceId: string, signal: AbortSignal): Promise<readonly SourceStatus[]>;
}

export interface HostedConnectionPresenter {
  present(
    record: ConnectionAccountRecord,
    source: SourceStatus | undefined,
    stateOverride?: HostedConnection['state'],
  ): HostedConnection;
}

export class HostedConnectionPersistenceError extends Error {
  override readonly name = 'HostedConnectionPersistenceError';
}

export class HostedConnectionNotFoundError extends Error {
  override readonly name = 'HostedConnectionNotFoundError';
}

export class HostedConnectionUnavailableError extends Error {
  override readonly name = 'HostedConnectionUnavailableError';
}

export class ConnectorCredentialError extends Error {
  override readonly name = 'ConnectorCredentialError';
}

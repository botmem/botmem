import type {
  BeginOAuthConnectionRequest,
  BeginOAuthConnectionResponse,
  ConnectionActionRequest,
  ConnectionListResponse,
  ConnectionMutationResponse,
  DeviceListResponse,
  LifecycleJobListResponse,
  LifecycleRequestResponse,
  OwnTracksConnectionRequest,
  PersonalAccessTokenIssueRequest,
  PersonalAccessTokenIssueResponse,
  PersonalAccessTokenListResponse,
  SearchRequestInput,
  SearchResponse,
} from '@botmem-v2/contracts';

/**
 * The single driving port used by every v2 search surface.
 *
 * The in-process domain service and the HTTP SDK both implement this shape, so
 * CLI and MCP adapters cannot acquire private search semantics.
 */
export interface SearchApplicationService {
  search(workspaceId: string, input: SearchRequestInput): Promise<SearchResponse>;
}

export interface ConnectionsApplicationService {
  listConnections(workspaceId: string): Promise<ConnectionListResponse>;
  beginOAuthConnection(
    workspaceId: string,
    input: BeginOAuthConnectionRequest,
  ): Promise<BeginOAuthConnectionResponse>;
  connectOwnTracks(
    workspaceId: string,
    input: OwnTracksConnectionRequest,
  ): Promise<ConnectionMutationResponse>;
  actOnConnection(
    workspaceId: string,
    connectionId: string,
    input: ConnectionActionRequest,
  ): Promise<ConnectionMutationResponse>;
}

export interface DevicesApplicationService {
  listDevices(workspaceId: string): Promise<DeviceListResponse>;
}

/** Browser-owner operations; bearer tokens are deliberately not accepted. */
export interface AccountApplicationService {
  listPersonalAccessTokens(workspaceId: string): Promise<PersonalAccessTokenListResponse>;
  issuePersonalAccessToken(
    workspaceId: string,
    input: PersonalAccessTokenIssueRequest,
  ): Promise<PersonalAccessTokenIssueResponse>;
  revokePersonalAccessToken(workspaceId: string, credentialId: string): Promise<void>;
  listLifecycleJobs(workspaceId: string): Promise<LifecycleJobListResponse>;
  requestWorkspaceExport(workspaceId: string): Promise<LifecycleRequestResponse>;
  requestWorkspaceDeletion(
    workspaceId: string,
    confirmation: string,
  ): Promise<LifecycleRequestResponse>;
  signOut(): Promise<void>;
}

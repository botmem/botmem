import type { ConnectorManifest, ConnectorAccount, Job, LogEntry, SyncSchedule } from './index.js';

// Connector endpoints
export interface ListConnectorsResponse {
  connectors: ConnectorManifest[];
}

export interface GetConnectorSchemaResponse {
  schema: Record<string, unknown>;
}

// Account endpoints
export interface CreateAccountRequest {
  connectorType: string;
  config: Record<string, unknown>;
}

export interface CreateAccountResponse {
  account: ConnectorAccount;
  auth: AuthInitResponse;
}

export interface UpdateAccountRequest {
  schedule?: SyncSchedule;
}

export interface ListAccountsResponse {
  accounts: ConnectorAccount[];
}

// Auth endpoints
export type AuthInitResponse =
  | { type: 'redirect'; url: string }
  | { type: 'qr-code'; qrData: string; wsChannel: string }
  | { type: 'complete' };

export interface AuthCompleteRequest {
  accountId: string;
  params: Record<string, unknown>;
}

// Job endpoints
export interface ListJobsResponse {
  jobs: Job[];
}

export interface TriggerSyncResponse {
  job: Job;
}

// Log endpoints
export interface ListLogsRequest {
  accountId?: string;
  jobId?: string;
  level?: string;
  limit?: number;
  offset?: number;
}

export interface ListLogsResponse {
  logs: LogEntry[];
  total: number;
}

// WebSocket event types
export type WsEvent =
  | { channel: string; event: 'auth:status'; data: { status: 'pending' | 'success' | 'failed'; qrData?: string } }
  | { channel: string; event: 'job:progress'; data: { jobId: string; progress: number; total?: number } }
  | { channel: string; event: 'job:complete'; data: { jobId: string; status: string } }
  | { channel: string; event: 'log'; data: LogEntry };

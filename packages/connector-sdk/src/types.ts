export type AuthType = 'oauth2' | 'qr-code' | 'api-key' | 'local-tool';

export interface ConnectorManifest {
  id: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  authType: AuthType;
  configSchema: Record<string, unknown>;
}

export interface AuthContext {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  identifier?: string;
  raw?: Record<string, unknown>;
}

export type AuthInitResult =
  | { type: 'redirect'; url: string }
  | { type: 'qr-code'; qrData: string; wsChannel: string }
  | { type: 'complete'; auth: AuthContext };

export interface ConnectorLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export interface SyncContext {
  accountId: string;
  auth: AuthContext;
  cursor: string | null;
  jobId: string;
  logger: ConnectorLogger;
  signal: AbortSignal;
}

export interface ConnectorDataEvent {
  sourceType: 'email' | 'message' | 'photo' | 'location';
  sourceId: string;
  timestamp: string;
  content: {
    text?: string;
    participants?: string[];
    attachments?: Array<{ uri: string; mimeType: string }>;
    metadata: Record<string, unknown>;
  };
}

export interface SyncResult {
  cursor: string | null;
  hasMore: boolean;
  processed: number;
}

export interface ProgressEvent {
  processed: number;
  total?: number;
}

export interface LogEvent {
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
}

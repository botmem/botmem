export type AuthType = 'oauth2' | 'qr-code' | 'phone-code' | 'api-key' | 'local-tool';

export interface ConnectorManifest {
  id: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  authType: AuthType;
  configSchema: Record<string, unknown>;

  /** Entity types this connector produces */
  entities: string[];

  /** Pipeline stages this connector uses. Omitted stages default to true. */
  pipeline: {
    clean?: boolean;
    embed?: boolean;
    enrich?: boolean;
  };

  /** Base trust score for memories from this connector (0-1) */
  trustScore: number;

  /** Weight coefficients for scoring formula. Defaults: semantic=0.40, recency=0.25, importance=0.20, trust=0.15 */
  weights?: {
    semantic?: number;
    recency?: number;
    importance?: number;
    trust?: number;
  };
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
  | { type: 'phone-code'; phoneCodeHash: string; wsChannel: string }
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
  sourceType: 'email' | 'message' | 'photo' | 'location' | 'file';
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
  filteredCount?: number;
}

export interface LogEvent {
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
}

/** Result from a connector's clean step */
export interface CleanResult {
  text: string;
  metadata?: Record<string, unknown>;
}

/** Result from a connector's embed step */
export interface EmbedResult {
  text: string;
  entities: Array<{ type: string; id: string; role: string }>;
  metadata?: Record<string, unknown>;
}

/** Result from a connector's enrich step */
export interface EnrichResult {
  entities?: Array<{ type: string; value: string }>;
  claims?: string[];
  factuality?: { label: string; confidence: number; rationale: string };
  metadata?: Record<string, unknown>;
}

/** Context passed to pipeline methods */
export interface PipelineContext {
  accountId: string;
  auth: AuthContext;
  logger: ConnectorLogger;
}

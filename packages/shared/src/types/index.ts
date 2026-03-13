export type BuiltinConnectorType =
  | 'gmail'
  | 'whatsapp'
  | 'telegram'
  | 'slack'
  | 'imessage'
  | 'photos'
  | 'locations';
export type ConnectorType = BuiltinConnectorType | (string & {});

export type AuthType = 'oauth2' | 'qr-code' | 'phone-code' | 'api-key' | 'local-tool';

export type SyncSchedule = 'hourly' | 'every-6h' | 'daily' | 'manual';

export type ConnectorStatus = 'connected' | 'syncing' | 'error' | 'disconnected';

export interface ConnectorManifest {
  id: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  authType: AuthType;
  configSchema: Record<string, unknown>;
  entities: string[];
  pipeline: {
    clean?: boolean;
    embed?: boolean;
    enrich?: boolean;
  };
  trustScore: number;
  weights?: {
    semantic?: number;
    recency?: number;
    importance?: number;
    trust?: number;
  };
}

export interface ConnectorAccount {
  id: string;
  type: ConnectorType;
  identifier: string;
  status: ConnectorStatus;
  schedule: SyncSchedule;
  lastSync: string | null;
  memoriesIngested: number;
  contactsCount: number;
  groupsCount: number;
  lastError: string | null;
}

export interface ConnectorConfig {
  type: ConnectorType;
  label: string;
  color: string;
  description: string;
}

export type JobStatus = 'running' | 'queued' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  connector: ConnectorType;
  accountId: string;
  accountIdentifier: string | null;
  status: JobStatus;
  priority: number;
  progress: number;
  total: number;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export type PipelineStage = 'sync' | 'embed' | 'enrich' | 'backfill' | 'file';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  connector: ConnectorType;
  stage?: PipelineStage;
  message: string;
}

export type SourceType = 'email' | 'message' | 'photo' | 'location' | 'file';

export type FactualityLabel = 'FACT' | 'UNVERIFIED' | 'FICTION';

export interface Memory {
  id: string;
  source: SourceType;
  sourceConnector: ConnectorType;
  accountIdentifier?: string | null;
  text: string;
  time: string;
  ingestTime: string;
  factuality: {
    label: FactualityLabel;
    confidence: number;
    rationale: string;
  };
  weights: {
    semantic: number;
    rerank: number;
    recency: number;
    importance: number;
    trust: number;
    final: number;
  };
  entities: Array<{ type: string; value: string; confidence: number }>;
  claims: Array<{ id: string; text: string; type: string }>;
  metadata: Record<string, unknown>;
  pinned?: boolean;
  people?: Array<{ role: string; personId: string; displayName: string }>;
}

export interface GraphNode {
  id: string;
  label: string;
  source: SourceType;
  sourceConnector: ConnectorType;
  importance: number;
  factuality: FactualityLabel;
  cluster: number;
  nodeType?: 'memory' | 'contact' | 'group' | 'file' | 'connector' | 'device';
  entities?: string[];
  connectors?: string[];
  text?: string;
  weights?: Record<string, number>;
  eventTime?: string;
  metadata?: Record<string, unknown>;
  avatarUrl?: string;
  thumbnailDataUrl?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  linkType: 'related' | 'supports' | 'contradicts' | 'attachment' | string;
  strength: number;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphEdge[];
}

export type SubscriptionPlan = 'free' | 'pro';
export type SubscriptionStatus = 'free' | 'active' | 'past_due' | 'canceled' | 'trialing';

export interface BillingInfo {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface User {
  id: string;
  email: string;
  name: string;
  onboarded: boolean;
  plan?: SubscriptionPlan;
  subscriptionStatus?: SubscriptionStatus;
  createdAt?: string;
}

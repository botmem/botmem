import type { ConnectorManifest, ConnectorAccount, Job } from '@botmem/shared';
import { useAuthStore } from '../store/authStore';

const API_BASE = '/api';

// --- API response shape types ---

export interface ApiConnector {
  id: string;
  name: string;
  authType: string;
  configSchema?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ApiAccount {
  id: string;
  connectorType: string;
  identifier: string;
  schedule?: string;
  status?: string;
  [key: string]: unknown;
}

export interface ApiJob {
  id: string;
  accountId: string;
  status: string;
  progress?: number;
  total?: number;
  error?: string;
  [key: string]: unknown;
}

export interface ApiLogEntry {
  id: string;
  timestamp: string;
  level: string;
  connectorType?: string;
  connector?: string;
  stage?: string;
  message: string;
  [key: string]: unknown;
}

export interface ApiMemoryItem {
  id: string;
  sourceType?: string;
  connectorType?: string;
  accountIdentifier?: string;
  text?: string;
  eventTime?: string;
  createdAt?: string;
  ingestTime?: string;
  factuality?: string | Record<string, unknown>;
  weights?: string | Record<string, number>;
  entities?: string | Array<{ type: string; value: string }>;
  claims?: string | Array<{ id: string; type: string; text: string }>;
  metadata?: string | Record<string, unknown>;
  pinned?: boolean | number;
  score?: number;
  people?: Array<{ role: string; personId: string; displayName: string }>;
  [key: string]: unknown;
}

export interface ApiContact {
  id: string;
  displayName: string;
  entityType?: string;
  avatars?: string | Array<{ url: string; source: string }>;
  identifiers?: Array<{
    id: string;
    identifierType?: string;
    type?: string;
    identifierValue?: string;
    value?: string;
    isPrimary?: boolean;
    connectorType?: string;
  }>;
  memoryCount?: number;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface ApiContactMemory {
  id: string;
  eventTime?: string;
  createdAt?: string;
  connectorType?: string;
  text?: string;
  [key: string]: unknown;
}

export interface ApiGraphNode {
  id: string;
  label?: string;
  type?: string;
  connectorType?: string;
  importance?: number;
  factuality?: string;
  cluster?: number;
  nodeType?: string;
  entities?: string[];
  connectors?: string[];
  text?: string;
  weights?: Record<string, number>;
  eventTime?: string;
  metadata?: Record<string, unknown>;
  avatarUrl?: string;
  thumbnailDataUrl?: string;
  [key: string]: unknown;
}

export interface ApiGraphEdge {
  source: string;
  target: string;
  type?: string;
  strength?: number;
  [key: string]: unknown;
}

export interface ApiGraphData {
  nodes: ApiGraphNode[];
  links?: ApiGraphEdge[];
  edges?: ApiGraphEdge[];
}

export interface FacetValue {
  value: string;
  count: number;
}

export interface ApiFacetCounts {
  connectorType: FacetValue[];
  sourceType: FacetValue[];
  factualityLabel: FacetValue[];
  people: FacetValue[];
}

export interface ApiSearchFilters {
  connectorTypes?: string[];
  sourceTypes?: string[];
  factualityLabels?: string[];
  personNames?: string[];
  timeRange?: { from?: string; to?: string };
  pinned?: boolean;
}

export interface ApiAskResponse {
  answer: string;
  conversationId: string;
  citations: ApiMemoryItem[];
}

export interface ApiSearchResponse {
  items: ApiMemoryItem[];
  fallback: boolean;
  resolvedEntities?: {
    contacts: { id: string; displayName: string }[];
    topicWords: string[];
    topicMatchCount: number;
  };
  parsed?: {
    temporal: { from: string; to: string } | null;
    temporalFallback?: boolean;
    entities: { id: string; displayName: string }[];
    intent: 'recall' | 'browse' | 'find';
    cleanQuery: string;
  };
  facetCounts?: ApiFacetCounts;
  found?: number;
}

export interface ApiMemoryStats {
  total: number;
  bySource: Record<string, number>;
  byConnector: Record<string, number>;
  needsRecoveryKey?: boolean;
}

// --- Request helper ---

const REQUEST_TIMEOUT_MS = 30_000;

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const state = useAuthStore.getState();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string>),
  };

  if (state.accessToken) {
    headers['Authorization'] = `Bearer ${state.accessToken}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  // Merge caller's signal if provided
  if (options?.signal) {
    options.signal.addEventListener('abort', () => controller.abort());
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      credentials: 'include',
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (controller.signal.aborted) {
      throw new Error(
        `Request timeout: ${path} did not respond within ${REQUEST_TIMEOUT_MS / 1000}s`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (res.status === 401) {
    // refreshSession() has a built-in mutex — safe to call from multiple places
    const refreshed = await useAuthStore.getState().refreshSession();
    if (refreshed) {
      // Retry original request with new token
      const newState = useAuthStore.getState();
      const retryHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(options?.headers as Record<string, string>),
      };
      if (newState.accessToken) {
        retryHeaders['Authorization'] = `Bearer ${newState.accessToken}`;
      }

      const retryRes = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: retryHeaders,
        credentials: 'include',
      });

      if (!retryRes.ok) {
        const body = await retryRes.text();
        throw new Error(`API ${retryRes.status}: ${body}`);
      }
      return retryRes.json();
    }

    // Refresh failed -- redirect to login
    window.location.href = '/login';
    throw new Error('Session expired');
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json();
}

export const api = {
  // Connectors
  listConnectors: () => request<{ connectors: ConnectorManifest[] }>('/connectors'),
  getConnectorSchema: (type: string) =>
    request<{
      schema: {
        type?: string;
        properties?: Record<
          string,
          {
            title?: string;
            description?: string;
            type?: string;
            readOnly?: boolean;
            default?: string | number;
          }
        >;
        required?: string[];
        authMethods?: Array<{ id: string; label: string; fields: string[] }>;
        [key: string]: unknown;
      };
    }>(`/connectors/${type}/schema`),
  getConnectorStatus: (type: string) =>
    request<{ ready: boolean; status: string; message?: string }>(`/connectors/${type}/status`),

  // Accounts
  listAccounts: () => request<{ accounts: ConnectorAccount[] }>('/accounts'),
  createAccount: (data: { connectorType: string; identifier: string }) =>
    request<ConnectorAccount>('/accounts', { method: 'POST', body: JSON.stringify(data) }),
  updateAccount: (id: string, data: { schedule?: string }) =>
    request<ConnectorAccount>(`/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteAccount: (id: string) => request<{ ok: boolean }>(`/accounts/${id}`, { method: 'DELETE' }),

  // Auth
  hasCredentials: (type: string) =>
    request<{ hasSavedCredentials: boolean }>(`/auth/${type}/has-credentials`),
  initiateAuth: (type: string, config: Record<string, unknown>) =>
    request<{
      redirectUrl?: string;
      url?: string;
      qrData?: string;
      type?: string;
      wsChannel?: string;
      identifier?: string;
      account?: { identifier?: string; [key: string]: unknown };
      [key: string]: unknown;
    }>(`/auth/${type}/initiate`, { method: 'POST', body: JSON.stringify({ config }) }),
  completeAuth: <
    T = { ok: boolean; accountId?: string; identifier?: string; [key: string]: unknown },
  >(
    type: string,
    params: Record<string, unknown>,
  ) => request<T>(`/auth/${type}/complete`, { method: 'POST', body: JSON.stringify({ params }) }),
  reauthAccount: (type: string, accountId: string, config: Record<string, unknown>) =>
    request<{ ok: boolean; [key: string]: unknown }>(`/auth/${type}/reauth/${accountId}`, {
      method: 'POST',
      body: JSON.stringify({ config }),
    }),

  // Jobs
  listJobs: (accountId?: string) =>
    request<{ jobs: Job[] }>(`/jobs${accountId ? `?accountId=${accountId}` : ''}`),
  triggerSync: (accountId: string, memoryBankId?: string) =>
    request<{ job: Job }>(`/jobs/sync/${accountId}`, {
      method: 'POST',
      body: JSON.stringify({ memoryBankId: memoryBankId || undefined }),
    }),
  cancelJob: (id: string) => request<{ ok: boolean }>(`/jobs/${id}`, { method: 'DELETE' }),
  retryFailedJobs: () =>
    request<{ ok: boolean; retried: number }>('/jobs/retry-failed', { method: 'POST' }),
  getQueueStats: () =>
    request<
      Record<
        string,
        { waiting: number; active: number; completed: number; failed: number; delayed: number }
      >
    >('/jobs/queues'),

  // Logs
  listLogs: (params?: { jobId?: string; accountId?: string; limit?: number; offset?: number }) => {
    const query = new URLSearchParams();
    if (params?.jobId) query.set('jobId', params.jobId);
    if (params?.accountId) query.set('accountId', params.accountId);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    return request<{ logs: ApiLogEntry[]; total: number }>(`/logs?${query}`);
  },

  // Memories
  searchMemories: (
    query: string,
    filters?: ApiSearchFilters,
    limit?: number,
    memoryBankId?: string,
  ) =>
    request<ApiSearchResponse>('/memories/search', {
      method: 'POST',
      body: JSON.stringify({
        query,
        ...(filters?.connectorTypes?.length ? { connectorTypes: filters.connectorTypes } : {}),
        ...(filters?.sourceTypes?.length ? { sourceTypes: filters.sourceTypes } : {}),
        ...(filters?.factualityLabels?.length
          ? { factualityLabels: filters.factualityLabels }
          : {}),
        ...(filters?.personNames?.length ? { personNames: filters.personNames } : {}),
        ...(filters?.timeRange ? { timeRange: filters.timeRange } : {}),
        ...(filters?.pinned !== undefined ? { pinned: filters.pinned } : {}),
        limit,
        memoryBankId: memoryBankId || undefined,
      }),
    }),
  askMemories: (query: string, conversationId?: string, memoryBankId?: string) =>
    request<ApiAskResponse>('/memories/ask', {
      method: 'POST',
      body: JSON.stringify({
        query,
        conversationId: conversationId || undefined,
        memoryBankId: memoryBankId || undefined,
      }),
    }),
  listMemories: (params?: {
    limit?: number;
    offset?: number;
    connectorType?: string;
    sourceType?: string;
    sortBy?: string;
    memoryBankId?: string;
  }) => {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    if (params?.connectorType) query.set('connectorType', params.connectorType);
    if (params?.sourceType) query.set('sourceType', params.sourceType);
    if (params?.sortBy) query.set('sortBy', params.sortBy);
    if (params?.memoryBankId) query.set('memoryBankId', params.memoryBankId);
    return request<{ items: ApiMemoryItem[]; total: number }>(`/memories?${query}`);
  },
  getMemory: (id: string) => request<ApiMemoryItem>(`/memories/${id}`),
  pinMemory: (id: string) => request<{ ok: boolean }>(`/memories/${id}/pin`, { method: 'POST' }),
  unpinMemory: (id: string) =>
    request<{ ok: boolean }>(`/memories/${id}/pin`, { method: 'DELETE' }),
  recordRecall: (id: string) =>
    request<{ ok: boolean }>(`/memories/${id}/recall`, { method: 'POST' }),
  deleteMemory: (id: string) => request<{ ok: boolean }>(`/memories/${id}`, { method: 'DELETE' }),
  getMemoryStats: (params?: { memoryBankId?: string }) => {
    const query = new URLSearchParams();
    if (params?.memoryBankId) query.set('memoryBankId', params.memoryBankId);
    const qs = query.toString();
    return request<ApiMemoryStats>(`/memories/stats${qs ? `?${qs}` : ''}`);
  },
  getGraphData: (params?: {
    memoryLimit?: number;
    linkLimit?: number;
    memoryBankId?: string;
    memoryIds?: string[];
  }) => {
    const query = new URLSearchParams();
    if (params?.memoryLimit) query.set('memoryLimit', String(params.memoryLimit));
    if (params?.linkLimit) query.set('linkLimit', String(params.linkLimit));
    if (params?.memoryBankId) query.set('memoryBankId', params.memoryBankId);
    if (params?.memoryIds?.length) query.set('memoryIds', params.memoryIds.join(','));
    const qs = query.toString();
    return request<ApiGraphData>(`/memories/graph${qs ? `?${qs}` : ''}`);
  },
  getGraphSeeds: () => request<ApiGraphData>('/memories/graph/seeds'),
  getGraphNeighbors: (nodeId: string) =>
    request<ApiGraphData>(`/memories/graph/neighbors/${nodeId}`),

  // Contacts
  // Contact endpoints use generics so consuming code can specify its own type
  // (e.g. ContactOption in MePage, Contact in contactStore)
  listContacts: <T = ApiContact>(params?: {
    limit?: number;
    offset?: number;
    entityType?: string;
  }) => {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    if (params?.entityType) query.set('entityType', params.entityType);
    return request<{ items: T[]; total: number }>(`/people?${query}`);
  },
  getContact: <T = ApiContact>(id: string) => request<T>(`/people/${id}`),
  getContactMemories: (id: string) => request<ApiContactMemory[]>(`/people/${id}/memories`),
  searchContacts: <T = ApiContact>(query: string) =>
    request<T[]>('/people/search', { method: 'POST', body: JSON.stringify({ query }) }),
  updateContact: (
    id: string,
    data: {
      displayName?: string;
      avatars?: Array<{ url: string; source: string }>;
      metadata?: Record<string, unknown>;
    },
  ) => request<ApiContact>(`/people/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  mergeContacts: (targetId: string, sourceId: string) =>
    request<{ ok: boolean }>(`/people/${targetId}/merge`, {
      method: 'POST',
      body: JSON.stringify({ sourceId }),
    }),
  deleteContact: (id: string) => request<{ ok: boolean }>(`/people/${id}`, { method: 'DELETE' }),
  getMergeSuggestions: <T = ApiContact>() =>
    request<Array<{ contact1: T; contact2: T; reason: string }>>('/people/suggestions'),
  dismissSuggestion: (contactId1: string, contactId2: string) =>
    request<{ ok: boolean }>('/people/suggestions/dismiss', {
      method: 'POST',
      body: JSON.stringify({ contactId1, contactId2 }),
    }),
  undismissSuggestion: (contactId1: string, contactId2: string) =>
    request<{ ok: boolean }>('/people/suggestions/undismiss', {
      method: 'POST',
      body: JSON.stringify({ contactId1, contactId2 }),
    }),
  removeIdentifier: <T = ApiContact>(contactId: string, identifierId: string) =>
    request<T>(`/people/${contactId}/identifiers/${identifierId}`, { method: 'DELETE' }),
  splitContact: (contactId: string, identifierIds: string[]) =>
    request<{ ok: boolean }>(`/people/${contactId}/split`, {
      method: 'POST',
      body: JSON.stringify({ identifierIds }),
    }),

  // Me
  // Returns MeData shape — typed at call site via MePage
  getMe: <T = Record<string, unknown>>() => request<T>('/me'),
  getMeStatus: () => request<{ isSet: boolean; contactId: string | null }>('/me/status'),
  getMeMergeCandidates: () =>
    request<
      Array<{
        id: string;
        displayName: string;
        avatars: string;
        reason: string;
        identifiers: Array<{ identifierType: string; identifierValue: string }>;
      }>
    >('/me/merge-candidates'),
  setMe: <T = { ok: boolean }>(contactId: string) =>
    request<T>('/me/set', { method: 'POST', body: JSON.stringify({ contactId }) }),
  setPreferredAvatar: (avatarIndex: number) =>
    request<{ ok: boolean }>('/me/avatar', {
      method: 'PATCH',
      body: JSON.stringify({ avatarIndex }),
    }),

  // Settings
  getSettings: () => request<Record<string, string>>('/settings'),
  updateSettings: (settings: Record<string, string>) =>
    request<Record<string, string>>('/settings', {
      method: 'PATCH',
      body: JSON.stringify(settings),
    }),

  // API Keys
  listApiKeys: () =>
    request<
      Array<{
        id: string;
        name: string;
        lastFour: string;
        createdAt: string;
        expiresAt: string | null;
        revokedAt: string | null;
      }>
    >('/api-keys'),
  createApiKey: (name: string, expiresAt?: string, memoryBankIds?: string[]) =>
    request<{ key: string; id: string; name: string; lastFour: string }>('/api-keys', {
      method: 'POST',
      body: JSON.stringify({
        name,
        expiresAt: expiresAt || undefined,
        memoryBankIds: memoryBankIds?.length ? memoryBankIds : undefined,
      }),
    }),
  revokeApiKey: (id: string) =>
    request<{ success: boolean }>(`/api-keys/${id}`, { method: 'DELETE' }),

  // Memory Banks
  listMemoryBanks: () =>
    request<{
      memoryBanks: Array<{
        id: string;
        name: string;
        isDefault: boolean;
        memoryCount: number;
        createdAt: string;
        updatedAt: string;
      }>;
    }>('/memory-banks'),
  createMemoryBank: (name: string) =>
    request<{ id: string; name: string; isDefault: boolean }>('/memory-banks', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  renameMemoryBank: (id: string, name: string) =>
    request<{ ok: boolean }>(`/memory-banks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  deleteMemoryBank: (id: string) =>
    request<{ deleted: boolean; memoriesDeleted: number }>(`/memory-banks/${id}`, {
      method: 'DELETE',
    }),

  // Retry failed/pending memories through full pipeline
  retryFailedMemories: (limit?: number) =>
    request<{ enqueued: number; errors: number; total: number }>(
      `/memories/retry-failed${limit ? `?limit=${limit}` : ''}`,
      { method: 'POST' },
    ),

  // Backfill
  backfillEnrich: (connectorType?: string) =>
    request<{ jobId: string | null; enqueued: number; total: number; message?: string }>(
      '/memories/backfill-enrich',
      {
        method: 'POST',
        body: JSON.stringify(connectorType ? { connectorType } : {}),
      },
    ),

  // Billing
  getBillingInfo: () =>
    request<{
      enabled: boolean;
      plan?: string;
      status?: string;
      currentPeriodEnd?: string | null;
      cancelAtPeriodEnd?: boolean;
    }>('/billing/info'),
  createCheckoutSession: () => request<{ url: string }>('/billing/checkout', { method: 'POST' }),
  createPortalSession: () => request<{ url: string }>('/billing/portal', { method: 'POST' }),

  // Admin / Danger Zone
  purgeMemories: () => request<{ ok: boolean }>('/memories/purge', { method: 'POST' }),
  resetVectorIndex: () =>
    request<{ ok: boolean }>('/memories/vector-index/reset', { method: 'POST' }),

  // Demo Data
  seedDemoData: () =>
    request<{
      ok: boolean;
      memories?: number;
      contacts?: number;
      links?: number;
      error?: string;
    }>('/demo/seed', { method: 'POST' }),
  clearDemoData: () =>
    request<{ ok: boolean; deleted: number }>('/demo/seed', { method: 'DELETE' }),
  getDemoStatus: () => request<{ hasDemoData: boolean }>('/demo/status', { method: 'POST' }),
};

// WebSocket connection — authenticates via first message instead of query string.
// Uses addEventListener so callers can safely set ws.onopen without overwriting auth.
export function createWsConnection(): WebSocket {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/events`;
  const ws = new WebSocket(url);
  const token = useAuthStore.getState().accessToken;

  // Send auth as the first message when connection opens
  ws.addEventListener('open', () => {
    if (token) {
      ws.send(JSON.stringify({ event: 'auth', data: { token } }));
    }
  });

  return ws;
}

/**
 * Wait for auth confirmation before subscribing.
 * Resolves when the server responds with `{ event: 'auth', data: { ok: true } }`.
 */
export function waitForAuth(ws: WebSocket, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler);
      reject(new Error('WebSocket auth timed out'));
    }, timeoutMs);
    const handler = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.event === 'auth') {
          clearTimeout(timer);
          ws.removeEventListener('message', handler);
          if (msg.data?.ok) {
            resolve();
          } else {
            reject(new Error(msg.data?.reason || 'WebSocket auth failed'));
          }
        }
      } catch {
        /* ignore non-JSON messages */
      }
    };
    ws.addEventListener('message', handler);
  });
}

export function subscribeToChannel(ws: WebSocket, channel: string) {
  ws.send(JSON.stringify({ event: 'subscribe', data: { channel } }));
}

export function unsubscribeFromChannel(ws: WebSocket, channel: string) {
  ws.send(JSON.stringify({ event: 'unsubscribe', data: { channel } }));
}

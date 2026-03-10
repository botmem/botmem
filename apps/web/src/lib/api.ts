import { useAuthStore } from '../store/authStore';

const API_BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const state = useAuthStore.getState();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string>),
  };

  if (state.accessToken) {
    headers['Authorization'] = `Bearer ${state.accessToken}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: 'include',
  });

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
  listConnectors: () => request<{ connectors: Record<string, unknown>[] }>('/connectors'),
  getConnectorSchema: (type: string) =>
    request<{ schema: Record<string, unknown> }>(`/connectors/${type}/schema`),
  getConnectorStatus: (type: string) =>
    request<{ ready: boolean; status: string; message?: string }>(`/connectors/${type}/status`),

  // Accounts
  listAccounts: () => request<{ accounts: Record<string, unknown>[] }>('/accounts'),
  createAccount: (data: { connectorType: string; identifier: string }) =>
    request<Record<string, unknown>>('/accounts', { method: 'POST', body: JSON.stringify(data) }),
  updateAccount: (id: string, data: { schedule?: string }) =>
    request<Record<string, unknown>>(`/accounts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteAccount: (id: string) =>
    request<Record<string, unknown>>(`/accounts/${id}`, { method: 'DELETE' }),

  // Auth
  hasCredentials: (type: string) =>
    request<{ hasSavedCredentials: boolean }>(`/auth/${type}/has-credentials`),
  initiateAuth: (type: string, config: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/auth/${type}/initiate`, {
      method: 'POST',
      body: JSON.stringify({ config }),
    }),
  completeAuth: (type: string, params: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/auth/${type}/complete`, {
      method: 'POST',
      body: JSON.stringify({ params }),
    }),
  reauthAccount: (type: string, accountId: string, config: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/auth/${type}/reauth/${accountId}`, {
      method: 'POST',
      body: JSON.stringify({ config }),
    }),

  // Jobs
  listJobs: (accountId?: string) =>
    request<{ jobs: Record<string, unknown>[] }>(
      `/jobs${accountId ? `?accountId=${accountId}` : ''}`,
    ),
  triggerSync: (accountId: string, memoryBankId?: string) =>
    request<{ job: Record<string, unknown> }>(`/jobs/sync/${accountId}`, {
      method: 'POST',
      body: JSON.stringify({ memoryBankId: memoryBankId || undefined }),
    }),
  cancelJob: (id: string) => request<Record<string, unknown>>(`/jobs/${id}`, { method: 'DELETE' }),
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
    return request<{ logs: Record<string, unknown>[]; total: number }>(`/logs?${query}`);
  },

  // Memories
  searchMemories: (
    query: string,
    filters?: Record<string, string>,
    limit?: number,
    memoryBankId?: string,
  ) =>
    request<{
      items: Record<string, unknown>[];
      fallback: boolean;
      resolvedEntities?: {
        contacts: { id: string; displayName: string }[];
        topicWords: string[];
        topicMatchCount: number;
      };
    }>('/memories/search', {
      method: 'POST',
      body: JSON.stringify({ query, filters, limit, memoryBankId: memoryBankId || undefined }),
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
    return request<{ items: Record<string, unknown>[]; total: number }>(`/memories?${query}`);
  },
  getMemory: (id: string) => request<Record<string, unknown>>(`/memories/${id}`),
  pinMemory: (id: string) => request<{ ok: boolean }>(`/memories/${id}/pin`, { method: 'POST' }),
  unpinMemory: (id: string) =>
    request<{ ok: boolean }>(`/memories/${id}/pin`, { method: 'DELETE' }),
  recordRecall: (id: string) =>
    request<{ ok: boolean }>(`/memories/${id}/recall`, { method: 'POST' }),
  deleteMemory: (id: string) =>
    request<Record<string, unknown>>(`/memories/${id}`, { method: 'DELETE' }),
  getMemoryStats: (params?: { memoryBankId?: string }) => {
    const query = new URLSearchParams();
    if (params?.memoryBankId) query.set('memoryBankId', params.memoryBankId);
    const qs = query.toString();
    return request<Record<string, unknown>>(`/memories/stats${qs ? `?${qs}` : ''}`);
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
    return request<Record<string, unknown>>(`/memories/graph${qs ? `?${qs}` : ''}`);
  },
  getGraphSeeds: () => request<Record<string, unknown>>('/memories/graph/seeds'),
  getGraphNeighbors: (nodeId: string) =>
    request<Record<string, unknown>>(`/memories/graph/neighbors/${nodeId}`),

  // Contacts
  listContacts: (params?: { limit?: number; offset?: number; entityType?: string }) => {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    if (params?.entityType) query.set('entityType', params.entityType);
    return request<{ items: Record<string, unknown>[]; total: number }>(`/people?${query}`);
  },
  getContact: (id: string) => request<Record<string, unknown>>(`/people/${id}`),
  getContactMemories: (id: string) => request<Record<string, unknown>[]>(`/people/${id}/memories`),
  searchContacts: (query: string) =>
    request<Record<string, unknown>[]>('/people/search', {
      method: 'POST',
      body: JSON.stringify({ query }),
    }),
  updateContact: (
    id: string,
    data: {
      displayName?: string;
      avatars?: Array<{ url: string; source: string }>;
      metadata?: Record<string, unknown>;
    },
  ) =>
    request<Record<string, unknown>>(`/people/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  mergeContacts: (targetId: string, sourceId: string) =>
    request<Record<string, unknown>>(`/people/${targetId}/merge`, {
      method: 'POST',
      body: JSON.stringify({ sourceId }),
    }),
  deleteContact: (id: string) =>
    request<Record<string, unknown>>(`/people/${id}`, { method: 'DELETE' }),
  getMergeSuggestions: () =>
    request<
      Array<{
        contact1: Record<string, unknown>;
        contact2: Record<string, unknown>;
        reason: string;
      }>
    >('/people/suggestions'),
  dismissSuggestion: (contactId1: string, contactId2: string) =>
    request<Record<string, unknown>>('/people/suggestions/dismiss', {
      method: 'POST',
      body: JSON.stringify({ contactId1, contactId2 }),
    }),
  undismissSuggestion: (contactId1: string, contactId2: string) =>
    request<Record<string, unknown>>('/people/suggestions/undismiss', {
      method: 'POST',
      body: JSON.stringify({ contactId1, contactId2 }),
    }),
  removeIdentifier: (contactId: string, identifierId: string) =>
    request<Record<string, unknown>>(`/people/${contactId}/identifiers/${identifierId}`, {
      method: 'DELETE',
    }),
  splitContact: (contactId: string, identifierIds: string[]) =>
    request<Record<string, unknown>>(`/people/${contactId}/split`, {
      method: 'POST',
      body: JSON.stringify({ identifierIds }),
    }),

  // Me
  getMe: () => request<Record<string, unknown>>('/me'),
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
  setMe: (contactId: string) =>
    request<Record<string, unknown>>('/me/set', {
      method: 'POST',
      body: JSON.stringify({ contactId }),
    }),
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
    request<Record<string, unknown>>(`/memory-banks/${id}`, {
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
  purgeMemories: () => request<Record<string, unknown>>('/memories/purge', { method: 'POST' }),
  resetVectorIndex: () =>
    request<Record<string, unknown>>('/memories/vector-index/reset', { method: 'POST' }),
};

// WebSocket connection
export function createWsConnection(): WebSocket {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = useAuthStore.getState().accessToken;
  const url = token
    ? `${protocol}//${window.location.host}/events?token=${encodeURIComponent(token)}`
    : `${protocol}//${window.location.host}/events`;
  return new WebSocket(url);
}

export function subscribeToChannel(ws: WebSocket, channel: string) {
  ws.send(JSON.stringify({ event: 'subscribe', data: { channel } }));
}

export function unsubscribeFromChannel(ws: WebSocket, channel: string) {
  ws.send(JSON.stringify({ event: 'unsubscribe', data: { channel } }));
}

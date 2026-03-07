const API_BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json();
}

export const api = {
  // Connectors
  listConnectors: () => request<{ connectors: any[] }>('/connectors'),
  getConnectorSchema: (type: string) => request<{ schema: any }>(`/connectors/${type}/schema`),
  getConnectorStatus: (type: string) => request<{ ready: boolean; status: string; message?: string }>(`/connectors/${type}/status`),

  // Accounts
  listAccounts: () => request<{ accounts: any[] }>('/accounts'),
  createAccount: (data: { connectorType: string; identifier: string }) =>
    request<any>('/accounts', { method: 'POST', body: JSON.stringify(data) }),
  updateAccount: (id: string, data: { schedule?: string }) =>
    request<any>(`/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteAccount: (id: string) =>
    request<any>(`/accounts/${id}`, { method: 'DELETE' }),

  // Auth
  hasCredentials: (type: string) =>
    request<{ hasSavedCredentials: boolean }>(`/auth/${type}/has-credentials`),
  initiateAuth: (type: string, config: Record<string, unknown>) =>
    request<any>(`/auth/${type}/initiate`, { method: 'POST', body: JSON.stringify({ config }) }),
  completeAuth: (type: string, params: Record<string, unknown>) =>
    request<any>(`/auth/${type}/complete`, { method: 'POST', body: JSON.stringify({ params }) }),

  // Jobs
  listJobs: (accountId?: string) =>
    request<{ jobs: any[] }>(`/jobs${accountId ? `?accountId=${accountId}` : ''}`),
  triggerSync: (accountId: string) =>
    request<{ job: any }>(`/jobs/sync/${accountId}`, { method: 'POST' }),
  cancelJob: (id: string) =>
    request<any>(`/jobs/${id}`, { method: 'DELETE' }),
  retryFailedJobs: () =>
    request<{ ok: boolean; retried: number }>('/jobs/retry-failed', { method: 'POST' }),
  getQueueStats: () =>
    request<Record<string, { waiting: number; active: number; completed: number; failed: number; delayed: number }>>('/jobs/queues'),

  // Logs
  listLogs: (params?: { jobId?: string; accountId?: string; limit?: number }) => {
    const query = new URLSearchParams();
    if (params?.jobId) query.set('jobId', params.jobId);
    if (params?.accountId) query.set('accountId', params.accountId);
    if (params?.limit) query.set('limit', String(params.limit));
    return request<{ logs: any[]; total: number }>(`/logs?${query}`);
  },

  // Memories
  searchMemories: (query: string, filters?: Record<string, string>, limit?: number) =>
    request<{ items: any[]; fallback: boolean; resolvedEntities?: { contacts: { id: string; displayName: string }[]; topicWords: string[]; topicMatchCount: number } }>('/memories/search', {
      method: 'POST',
      body: JSON.stringify({ query, filters, limit }),
    }),
  listMemories: (params?: { limit?: number; offset?: number; connectorType?: string; sourceType?: string; sortBy?: string }) => {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    if (params?.connectorType) query.set('connectorType', params.connectorType);
    if (params?.sourceType) query.set('sourceType', params.sourceType);
    if (params?.sortBy) query.set('sortBy', params.sortBy);
    return request<{ items: any[]; total: number }>(`/memories?${query}`);
  },
  getMemory: (id: string) => request<any>(`/memories/${id}`),
  pinMemory: (id: string) => request<{ ok: boolean }>(`/memories/${id}/pin`, { method: 'POST' }),
  unpinMemory: (id: string) => request<{ ok: boolean }>(`/memories/${id}/pin`, { method: 'DELETE' }),
  recordRecall: (id: string) => request<{ ok: boolean }>(`/memories/${id}/recall`, { method: 'POST' }),
  deleteMemory: (id: string) =>
    request<any>(`/memories/${id}`, { method: 'DELETE' }),
  getMemoryStats: () => request<any>('/memories/stats'),
  getGraphData: (params?: { memoryLimit?: number; linkLimit?: number }) => {
    const query = new URLSearchParams();
    if (params?.memoryLimit) query.set('memoryLimit', String(params.memoryLimit));
    if (params?.linkLimit) query.set('linkLimit', String(params.linkLimit));
    const qs = query.toString();
    return request<any>(`/memories/graph${qs ? `?${qs}` : ''}`);
  },
  getGraphSeeds: () => request<any>('/memories/graph/seeds'),
  getGraphNeighbors: (nodeId: string) => request<any>(`/memories/graph/neighbors/${nodeId}`),

  // Contacts
  listContacts: (params?: { limit?: number; offset?: number; entityType?: string }) => {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    if (params?.entityType) query.set('entityType', params.entityType);
    return request<{ items: any[]; total: number }>(`/people?${query}`);
  },
  getContact: (id: string) => request<any>(`/people/${id}`),
  getContactMemories: (id: string) => request<any[]>(`/people/${id}/memories`),
  searchContacts: (query: string) =>
    request<any[]>('/people/search', { method: 'POST', body: JSON.stringify({ query }) }),
  updateContact: (id: string, data: { displayName?: string; avatars?: Array<{ url: string; source: string }>; metadata?: Record<string, unknown> }) =>
    request<any>(`/people/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  mergeContacts: (targetId: string, sourceId: string) =>
    request<any>(`/people/${targetId}/merge`, { method: 'POST', body: JSON.stringify({ sourceId }) }),
  deleteContact: (id: string) =>
    request<any>(`/people/${id}`, { method: 'DELETE' }),
  getMergeSuggestions: () =>
    request<Array<{ contact1: any; contact2: any; reason: string }>>('/people/suggestions'),
  dismissSuggestion: (contactId1: string, contactId2: string) =>
    request<any>('/people/suggestions/dismiss', { method: 'POST', body: JSON.stringify({ contactId1, contactId2 }) }),
  undismissSuggestion: (contactId1: string, contactId2: string) =>
    request<any>('/people/suggestions/undismiss', { method: 'POST', body: JSON.stringify({ contactId1, contactId2 }) }),
  removeIdentifier: (contactId: string, identifierId: string) =>
    request<any>(`/people/${contactId}/identifiers/${identifierId}`, { method: 'DELETE' }),
  splitContact: (contactId: string, identifierIds: string[]) =>
    request<any>(`/people/${contactId}/split`, { method: 'POST', body: JSON.stringify({ identifierIds }) }),

  // Me
  getMe: () => request<any>('/me'),
  getMeStatus: () => request<{ isSet: boolean; contactId: string | null }>('/me/status'),
  getMeMergeCandidates: () => request<Array<{ id: string; displayName: string; avatars: string; reason: string; identifiers: Array<{ identifierType: string; identifierValue: string }> }>>('/me/merge-candidates'),
  setMe: (contactId: string) => request<any>(`/me/set?contactId=${contactId}`),

  // Settings
  getSettings: () => request<Record<string, string>>('/settings'),
  updateSettings: (settings: Record<string, string>) =>
    request<Record<string, string>>('/settings', { method: 'PATCH', body: JSON.stringify(settings) }),

  // Admin / Danger Zone
  purgeMemories: () =>
    request<any>('/memories/purge', { method: 'POST' }),
  resetVectorIndex: () =>
    request<any>('/memories/vector-index/reset', { method: 'POST' }),
};

// WebSocket connection
export function createWsConnection(): WebSocket {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(`${protocol}//${window.location.host}/events`);
}

export function subscribeToChannel(ws: WebSocket, channel: string) {
  ws.send(JSON.stringify({ event: 'subscribe', data: { channel } }));
}

export function unsubscribeFromChannel(ws: WebSocket, channel: string) {
  ws.send(JSON.stringify({ event: 'unsubscribe', data: { channel } }));
}

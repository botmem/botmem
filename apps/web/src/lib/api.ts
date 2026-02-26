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
    request<any[]>('/memories/search', {
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
  insertMemory: (data: { text: string; sourceType?: string; connectorType?: string }) =>
    request<any>('/memories', { method: 'POST', body: JSON.stringify(data) }),
  deleteMemory: (id: string) =>
    request<any>(`/memories/${id}`, { method: 'DELETE' }),
  getMemoryStats: () => request<any>('/memories/stats'),
  getGraphData: () => request<any>('/memories/graph'),
  getGraphSeeds: () => request<any>('/memories/graph/seeds'),
  getGraphNeighbors: (nodeId: string) => request<any>(`/memories/graph/neighbors/${nodeId}`),

  // Contacts
  listContacts: (params?: { limit?: number; offset?: number }) => {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    return request<{ items: any[]; total: number }>(`/contacts?${query}`);
  },
  getContact: (id: string) => request<any>(`/contacts/${id}`),
  getContactMemories: (id: string) => request<any[]>(`/contacts/${id}/memories`),
  searchContacts: (query: string) =>
    request<any[]>('/contacts/search', { method: 'POST', body: JSON.stringify({ query }) }),
  updateContact: (id: string, data: { displayName?: string; avatars?: Array<{ url: string; source: string }>; metadata?: Record<string, unknown> }) =>
    request<any>(`/contacts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  mergeContacts: (targetId: string, sourceId: string) =>
    request<any>(`/contacts/${targetId}/merge`, { method: 'POST', body: JSON.stringify({ sourceId }) }),
  deleteContact: (id: string) =>
    request<any>(`/contacts/${id}`, { method: 'DELETE' }),
  getMergeSuggestions: () =>
    request<Array<{ contact1: any; contact2: any; reason: string }>>('/contacts/suggestions'),
  dismissSuggestion: (contactId1: string, contactId2: string) =>
    request<any>('/contacts/suggestions/dismiss', { method: 'POST', body: JSON.stringify({ contactId1, contactId2 }) }),

  // Settings
  getSettings: () => request<Record<string, string>>('/settings'),
  updateSettings: (settings: Record<string, string>) =>
    request<Record<string, string>>('/settings', { method: 'PATCH', body: JSON.stringify(settings) }),
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

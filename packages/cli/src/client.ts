/**
 * Typed HTTP client for the Botmem REST API.
 */

export interface Memory {
  id: string;
  text: string;
  sourceType: string;
  connectorType: string;
  sourceId: string;
  eventTime: string;
  ingestTime: string;
  importance: number | null;
  factuality: string | null;
  entities: string | null;
  claims: string | null;
  weights: string | null;
  metadata: string | null;
  embeddingStatus: string;
  createdAt: string;
  accountIdentifier?: string | null;
  [key: string]: unknown;
}

export interface SearchResult {
  id: string;
  text: string;
  sourceType: string;
  connectorType: string;
  eventTime: string;
  factuality: string;
  entities: string;
  metadata: string;
  accountIdentifier: string | null;
  score: number;
  weights: {
    semantic: number;
    rerank: number;
    recency: number;
    importance: number;
    trust: number;
    final: number;
  };
}

export interface MemoryStats {
  total: number;
  bySource: Record<string, number>;
  byConnector: Record<string, number>;
  byFactuality: Record<string, number>;
}

export interface GraphData {
  nodes: Array<{ id: string; label: string; type: string; [key: string]: unknown }>;
  edges: Array<{ source: string; target: string; type: string; [key: string]: unknown }>;
}

export interface Contact {
  id: string;
  displayName: string;
  avatars: string;
  metadata: string;
  createdAt: string;
  updatedAt: string;
  identifiers: Array<{
    id: string;
    identifierType: string;
    identifierValue: string;
    connectorType: string | null;
    confidence: number;
  }>;
  [key: string]: unknown;
}

export interface ConnectorAccount {
  id: string;
  type: string;
  identifier: string;
  status: string;
  schedule: string | null;
  lastSync: string | null;
  memoriesIngested: number | null;
  lastError: string | null;
}

export interface Job {
  id: string;
  connector: string;
  accountId: string;
  accountIdentifier: string | null;
  status: string;
  priority: number;
  progress: number | null;
  total: number | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export interface QueueStats {
  [queueName: string]: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  };
}

export class BotmemApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'BotmemApiError';
  }
}

export class BotmemClient {
  constructor(private baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> || {}),
    };

    let response: Response;
    try {
      response = await fetch(url, { ...options, headers });
    } catch (err) {
      throw new BotmemApiError(
        `Failed to connect to Botmem API at ${url}: ${err instanceof Error ? err.message : String(err)}`,
        0,
      );
    }

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await response.text().catch(() => null);
      }
      throw new BotmemApiError(
        `Botmem API returned ${response.status} ${response.statusText} for ${options.method || 'GET'} ${path}`,
        response.status,
        body,
      );
    }

    return response.json() as Promise<T>;
  }

  // --- Memory ---

  async searchMemories(
    query: string,
    filters?: Record<string, string>,
    limit?: number,
  ): Promise<{ items: SearchResult[]; fallback: boolean; resolvedEntities?: { contacts: { id: string; displayName: string }[]; topicWords: string[] } }> {
    return this.request<{ items: SearchResult[]; fallback: boolean; resolvedEntities?: { contacts: { id: string; displayName: string }[]; topicWords: string[] } }>('/memories/search', {
      method: 'POST',
      body: JSON.stringify({ query, filters, limit }),
    });
  }

  async listMemories(params?: {
    limit?: number;
    offset?: number;
    connectorType?: string;
    sourceType?: string;
  }): Promise<{ items: Memory[]; total: number }> {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.offset) qs.set('offset', String(params.offset));
    if (params?.connectorType) qs.set('connectorType', params.connectorType);
    if (params?.sourceType) qs.set('sourceType', params.sourceType);
    const query = qs.toString();
    return this.request<{ items: Memory[]; total: number }>(`/memories${query ? '?' + query : ''}`);
  }

  async getMemory(id: string): Promise<Memory> {
    return this.request<Memory>(`/memories/${encodeURIComponent(id)}`);
  }

  async deleteMemory(id: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`/memories/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  async getMemoryStats(): Promise<MemoryStats> {
    return this.request<MemoryStats>('/memories/stats');
  }

  // --- Contacts ---

  async listContacts(params?: {
    limit?: number;
    offset?: number;
  }): Promise<{ items: Contact[]; total: number }> {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.offset) qs.set('offset', String(params.offset));
    const query = qs.toString();
    return this.request<{ items: Contact[]; total: number }>(`/people${query ? '?' + query : ''}`);
  }

  async searchContacts(query: string): Promise<Contact[]> {
    return this.request<Contact[]>('/people/search', {
      method: 'POST',
      body: JSON.stringify({ query }),
    });
  }

  async getContact(id: string): Promise<Contact> {
    return this.request<Contact>(`/people/${encodeURIComponent(id)}`);
  }

  async getContactMemories(id: string): Promise<Memory[]> {
    return this.request<Memory[]>(`/people/${encodeURIComponent(id)}/memories`);
  }

  // --- Accounts ---

  async listAccounts(): Promise<{ accounts: ConnectorAccount[] }> {
    return this.request<{ accounts: ConnectorAccount[] }>('/accounts');
  }

  // --- Jobs ---

  async listJobs(accountId?: string): Promise<{ jobs: Job[] }> {
    const qs = accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
    return this.request<{ jobs: Job[] }>(`/jobs${qs}`);
  }

  async triggerSync(accountId: string): Promise<{ job: Job }> {
    return this.request<{ job: Job }>(`/jobs/sync/${encodeURIComponent(accountId)}`, {
      method: 'POST',
    });
  }

  async cancelJob(id: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`/jobs/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  async retryFailedJobs(): Promise<{ ok: boolean; retried: number }> {
    return this.request<{ ok: boolean; retried: number }>('/jobs/retry-failed', {
      method: 'POST',
    });
  }

  async retryFailedMemories(): Promise<{ enqueued: number; total: number }> {
    return this.request<{ enqueued: number; total: number }>('/memories/retry-failed', {
      method: 'POST',
    });
  }

  async getQueueStats(): Promise<QueueStats> {
    return this.request<QueueStats>('/jobs/queues');
  }

  async getVersion(): Promise<{ version: string }> {
    return this.request<{ version: string }>('/version');
  }

  // --- Timeline & Related ---

  async getTimeline(params: {
    from?: string;
    to?: string;
    connectorType?: string;
    sourceType?: string;
    query?: string;
    limit?: number;
  }): Promise<{ items: Memory[]; total: number }> {
    const qs = new URLSearchParams();
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    if (params.connectorType) qs.set('connectorType', params.connectorType);
    if (params.sourceType) qs.set('sourceType', params.sourceType);
    if (params.query) qs.set('query', params.query);
    if (params.limit) qs.set('limit', String(params.limit));
    const query = qs.toString();
    return this.request<{ items: Memory[]; total: number }>(`/memories/timeline${query ? '?' + query : ''}`);
  }

  async getRelated(memoryId: string, limit?: number): Promise<{ items: Array<{ id: string; text: string; sourceType: string; connectorType: string; eventTime: string; score: number; relationship: string }>; source: Memory | null }> {
    const qs = limit ? `?limit=${limit}` : '';
    return this.request(`/memories/${encodeURIComponent(memoryId)}/related${qs}`);
  }

  // --- Entities ---

  async searchEntities(query: string, limit?: number, type?: string): Promise<{ entities: Array<{ value: string; type: string; memoryCount: number; connectors: string[] }>; total: number }> {
    const qs = new URLSearchParams({ q: query });
    if (limit) qs.set('limit', String(limit));
    if (type) qs.set('type', type);
    return this.request(`/memories/entities/search?${qs}`);
  }

  async getEntityGraph(value: string, limit?: number): Promise<{ entity: string; memories: any[]; relatedEntities: any[]; contacts: any[]; memoryCount: number }> {
    const qs = limit ? `?limit=${limit}` : '';
    return this.request(`/memories/entities/${encodeURIComponent(value)}/graph${qs}`);
  }
}

/**
 * Typed HTTP client for the Botmem REST API.
 * All methods return parsed JSON responses with error handling.
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

export interface ConnectorManifest {
  id: string;
  name: string;
  description: string;
  authType: string;
  configSchema: unknown;
  [key: string]: unknown;
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
    // Strip trailing slash
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
  ): Promise<SearchResult[]> {
    return this.request<SearchResult[]>('/memories/search', {
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

  async insertMemory(text: string, sourceType?: string, connectorType?: string): Promise<Memory> {
    return this.request<Memory>('/memories', {
      method: 'POST',
      body: JSON.stringify({ text, sourceType, connectorType }),
    });
  }

  async deleteMemory(id: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`/memories/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  async getMemoryStats(): Promise<MemoryStats> {
    return this.request<MemoryStats>('/memories/stats');
  }

  async getMemoryGraph(): Promise<GraphData> {
    return this.request<GraphData>('/memories/graph');
  }

  // --- Contacts ---

  async searchContacts(query: string): Promise<Contact[]> {
    return this.request<Contact[]>('/contacts/search', {
      method: 'POST',
      body: JSON.stringify({ query }),
    });
  }

  async getContact(id: string): Promise<Contact> {
    return this.request<Contact>(`/contacts/${encodeURIComponent(id)}`);
  }

  async getContactMemories(id: string): Promise<Memory[]> {
    return this.request<Memory[]>(`/contacts/${encodeURIComponent(id)}/memories`);
  }

  // --- Connectors ---

  async listConnectors(): Promise<ConnectorManifest[]> {
    const result = await this.request<{ connectors: ConnectorManifest[] }>('/connectors');
    return result.connectors;
  }

  // --- Jobs ---

  async triggerSync(accountId: string): Promise<Job> {
    const result = await this.request<{ job: Job }>(`/jobs/sync/${encodeURIComponent(accountId)}`, {
      method: 'POST',
    });
    return result.job;
  }

  async getQueueStats(): Promise<QueueStats> {
    return this.request<QueueStats>('/jobs/queues');
  }
}

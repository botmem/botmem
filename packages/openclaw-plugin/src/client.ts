/**
 * Botmem HTTP client for OpenClaw plugin.
 * Adapted from packages/cli/src/client.ts — only methods needed by tools.
 */

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
  private baseUrl: string;

  constructor(
    baseUrl: string,
    private apiKey: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      ...((options.headers as Record<string, string>) || {}),
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

  async searchMemories(
    query: string,
    filters?: Record<string, string>,
    limit?: number,
    memoryBankId?: string,
  ): Promise<Record<string, unknown>> {
    return this.request('/memories/search', {
      method: 'POST',
      body: JSON.stringify({ query, filters, limit, memoryBankId }),
    });
  }

  async agentAsk(
    query: string,
    filters?: Record<string, string>,
    limit?: number,
  ): Promise<Record<string, unknown>> {
    return this.request('/agent/ask', {
      method: 'POST',
      body: JSON.stringify({ query, filters, limit }),
    });
  }

  async agentRemember(
    text: string,
    metadata?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request('/agent/remember', {
      method: 'POST',
      body: JSON.stringify({ text, metadata }),
    });
  }

  async agentForget(memoryId: string): Promise<Record<string, unknown>> {
    return this.request(`/agent/forget/${encodeURIComponent(memoryId)}`, {
      method: 'DELETE',
    });
  }

  async getTimeline(params: {
    contactId?: string;
    connectorType?: string;
    sourceType?: string;
    days?: number;
    limit?: number;
  }): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams();
    if (params.contactId) qs.set('contactId', params.contactId);
    if (params.connectorType) qs.set('connectorType', params.connectorType);
    if (params.sourceType) qs.set('sourceType', params.sourceType);
    if (params.days) qs.set('days', String(params.days));
    if (params.limit) qs.set('limit', String(params.limit));
    const query = qs.toString();
    return this.request(`/agent/timeline${query ? '?' + query : ''}`);
  }

  async agentContext(contactId: string): Promise<Record<string, unknown>> {
    return this.request(`/agent/context/${encodeURIComponent(contactId)}`);
  }

  async searchContacts(query: string, limit?: number): Promise<Record<string, unknown>> {
    return this.request('/people/search', {
      method: 'POST',
      body: JSON.stringify({ query, limit }),
    });
  }

  async getStatus(): Promise<Record<string, unknown>> {
    return this.request('/agent/status');
  }
}

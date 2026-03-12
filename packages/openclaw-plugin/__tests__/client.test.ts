import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BotmemClient, BotmemApiError } from '../src/client';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

describe('BotmemClient', () => {
  let client: BotmemClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new BotmemClient('http://localhost:12412', 'test-api-key');
  });

  it('sets Authorization header from apiKey', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ items: [] }));
    await client.searchMemories('test');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:12412/memories/search',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-api-key',
        }),
      }),
    );
  });

  it('strips trailing slashes from baseUrl', async () => {
    const c = new BotmemClient('http://localhost:12412///', 'key');
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await c.getStatus();
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:12412/agent/status',
      expect.anything(),
    );
  });

  describe('searchMemories', () => {
    it('sends POST to /memories/search with query and filters', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ items: [], fallback: false }));
      await client.searchMemories('hello', { sourceType: 'email' }, 5, 'bank-1');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toEqual({
        query: 'hello',
        filters: { sourceType: 'email' },
        limit: 5,
        memoryBankId: 'bank-1',
      });
    });
  });

  describe('agentAsk', () => {
    it('sends POST to /agent/ask', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ answer: 'yes' }));
      const result = await client.agentAsk('question', undefined, 10);
      expect(result).toEqual({ answer: 'yes' });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toEqual({ query: 'question', limit: 10 });
    });
  });

  describe('agentRemember', () => {
    it('sends POST to /agent/remember', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: '123' }));
      await client.agentRemember('important fact', { tag: 'test' });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toEqual({ text: 'important fact', metadata: { tag: 'test' } });
    });
  });

  describe('agentForget', () => {
    it('sends DELETE to /agent/forget/:id', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ deleted: true }));
      await client.agentForget('mem-id');
      expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:12412/agent/forget/mem-id');
      expect(mockFetch.mock.calls[0][1].method).toBe('DELETE');
    });
  });

  describe('getTimeline', () => {
    it('sends GET to /agent/timeline with query params', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ results: {} }));
      await client.getTimeline({ days: 7, limit: 20, connectorType: 'gmail' });
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('/agent/timeline?');
      expect(url).toContain('days=7');
      expect(url).toContain('limit=20');
      expect(url).toContain('connectorType=gmail');
    });
  });

  describe('agentContext', () => {
    it('sends GET to /agent/context/:contactId', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ contact: {} }));
      await client.agentContext('contact-1');
      expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:12412/agent/context/contact-1');
    });
  });

  describe('searchContacts', () => {
    it('sends POST to /people/search', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]));
      await client.searchContacts('Alice', 5);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toEqual({ query: 'Alice', limit: 5 });
    });
  });

  describe('getStatus', () => {
    it('sends GET to /agent/status', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: {} }));
      await client.getStatus();
      expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:12412/agent/status');
    });
  });

  describe('error handling', () => {
    it('throws BotmemApiError on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'not found' }, 404));
      await expect(client.getStatus()).rejects.toThrow(BotmemApiError);
    });

    it('throws BotmemApiError on network failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(client.getStatus()).rejects.toThrow(BotmemApiError);
    });

    it('includes status code in BotmemApiError', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'forbidden' }, 403));
      try {
        await client.getStatus();
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(BotmemApiError);
        expect((err as BotmemApiError).status).toBe(403);
      }
    });
  });
});

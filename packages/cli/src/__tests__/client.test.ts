import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BotmemClient, BotmemApiError } from '../client.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(data: unknown, status = 200, statusText = 'OK') {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as Response);
}

function errorResponse(status: number, statusText: string, body?: unknown) {
  return Promise.resolve({
    ok: false,
    status,
    statusText,
    json: () => (body !== undefined ? Promise.resolve(body) : Promise.reject(new Error('no json'))),
    text: () => Promise.resolve(body !== undefined ? JSON.stringify(body) : ''),
  } as Response);
}

describe('BotmemClient', () => {
  let client: BotmemClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new BotmemClient('http://localhost:12412/api');
  });

  describe('constructor', () => {
    it('should strip trailing slashes from baseUrl', () => {
      const c = new BotmemClient('http://localhost:12412/api///');
      mockFetch.mockReturnValue(jsonResponse({ items: [], total: 0 }));
      c.listMemories();
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:12412/api/memories',
        expect.anything(),
      );
    });

    it('should keep baseUrl without trailing slashes unchanged', () => {
      mockFetch.mockReturnValue(jsonResponse({ items: [], total: 0 }));
      client.listMemories();
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:12412/api/memories',
        expect.anything(),
      );
    });
  });

  describe('auth headers', () => {
    it('should send Bearer token when token is set', async () => {
      client.setToken('my-jwt-token');
      mockFetch.mockReturnValue(jsonResponse({ items: [], total: 0 }));
      await client.listMemories();
      const callHeaders = mockFetch.mock.calls[0][1].headers;
      expect(callHeaders['Authorization']).toBe('Bearer my-jwt-token');
    });

    it('should not send Authorization header when no token is set', async () => {
      mockFetch.mockReturnValue(jsonResponse({ items: [], total: 0 }));
      await client.listMemories();
      const callHeaders = mockFetch.mock.calls[0][1].headers;
      expect(callHeaders['Authorization']).toBeUndefined();
    });

    it('should always send Content-Type: application/json', async () => {
      mockFetch.mockReturnValue(jsonResponse({ items: [], total: 0 }));
      await client.listMemories();
      const callHeaders = mockFetch.mock.calls[0][1].headers;
      expect(callHeaders['Content-Type']).toBe('application/json');
    });
  });

  describe('error handling', () => {
    it('should throw BotmemApiError with status and body on non-OK response', async () => {
      mockFetch.mockReturnValue(errorResponse(404, 'Not Found', { message: 'not found' }));
      await expect(client.getMemory('abc')).rejects.toThrow(BotmemApiError);
      try {
        await client.getMemory('abc');
      } catch (err) {
        const apiErr = err as BotmemApiError;
        expect(apiErr.status).toBe(404);
        expect(apiErr.body).toEqual({ message: 'not found' });
        expect(apiErr.message).toContain('404');
      }
    });

    it('should throw BotmemApiError with status 0 on network failure', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(client.getMemory('abc')).rejects.toThrow(BotmemApiError);
      try {
        await client.getMemory('abc');
      } catch (err) {
        const apiErr = err as BotmemApiError;
        expect(apiErr.status).toBe(0);
        expect(apiErr.message).toContain('ECONNREFUSED');
      }
    });

    it('should handle non-JSON error bodies gracefully', async () => {
      mockFetch.mockReturnValue(
        Promise.resolve({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          json: () => Promise.reject(new Error('not json')),
          text: () => Promise.resolve('plain text error'),
        } as Response),
      );
      await expect(client.listMemories()).rejects.toThrow(BotmemApiError);
    });
  });

  describe('login', () => {
    it('should POST credentials and set token from response', async () => {
      const loginResult = {
        accessToken: 'jwt-123',
        user: { id: 'u1', email: 'test@test.com', name: 'Test' },
      };
      mockFetch.mockReturnValue(jsonResponse(loginResult));

      const result = await client.login('test@test.com', 'pass123');

      expect(result.accessToken).toBe('jwt-123');
      expect(result.user.email).toBe('test@test.com');

      // Token should be set internally
      mockFetch.mockReturnValue(jsonResponse({ items: [], total: 0 }));
      await client.listMemories();
      const callHeaders = mockFetch.mock.calls[1][1].headers;
      expect(callHeaders['Authorization']).toBe('Bearer jwt-123');
    });

    it('should send email and password in body', async () => {
      mockFetch.mockReturnValue(
        jsonResponse({ accessToken: 'x', user: { id: '1', email: 'a', name: 'b' } }),
      );
      await client.login('user@email.com', 'secret');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toEqual({ email: 'user@email.com', password: 'secret' });
    });
  });

  describe('searchMemories', () => {
    it('should POST to /memories/search with query', async () => {
      const response = { items: [], fallback: false };
      mockFetch.mockReturnValue(jsonResponse(response));

      const result = await client.searchMemories('hello world');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:12412/api/memories/search',
        expect.objectContaining({ method: 'POST' }),
      );
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.query).toBe('hello world');
      expect(result).toEqual(response);
    });

    it('should include filters, limit, and memoryBankId', async () => {
      mockFetch.mockReturnValue(jsonResponse({ items: [], fallback: false }));

      await client.searchMemories('test', { sourceType: 'email' }, 10, 'bank-1');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.filters).toEqual({ sourceType: 'email' });
      expect(body.limit).toBe(10);
      expect(body.memoryBankId).toBe('bank-1');
    });
  });

  describe('listMemories', () => {
    it('should GET /memories without params', async () => {
      mockFetch.mockReturnValue(jsonResponse({ items: [], total: 0 }));
      await client.listMemories();
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:12412/api/memories',
        expect.anything(),
      );
    });

    it('should append query string with params', async () => {
      mockFetch.mockReturnValue(jsonResponse({ items: [], total: 0 }));
      await client.listMemories({
        limit: 10,
        offset: 5,
        connectorType: 'gmail',
        sourceType: 'email',
      });
      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('limit=10');
      expect(url).toContain('offset=5');
      expect(url).toContain('connectorType=gmail');
      expect(url).toContain('sourceType=email');
    });
  });

  describe('getMemory', () => {
    it('should GET /memories/:id', async () => {
      const memory = { id: 'abc', text: 'hello' };
      mockFetch.mockReturnValue(jsonResponse(memory));
      const result = await client.getMemory('abc');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:12412/api/memories/abc',
        expect.anything(),
      );
      expect(result).toEqual(memory);
    });

    it('should encode special characters in id', async () => {
      mockFetch.mockReturnValue(jsonResponse({ id: 'a/b' }));
      await client.getMemory('a/b');
      expect(mockFetch.mock.calls[0][0]).toContain('a%2Fb');
    });
  });

  describe('deleteMemory', () => {
    it('should DELETE /memories/:id', async () => {
      mockFetch.mockReturnValue(jsonResponse({ ok: true }));
      const result = await client.deleteMemory('abc');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:12412/api/memories/abc',
        expect.objectContaining({ method: 'DELETE' }),
      );
      expect(result).toEqual({ ok: true });
    });
  });

  describe('getMemoryStats', () => {
    it('should GET /memories/stats', async () => {
      const stats = { total: 100, bySource: {}, byConnector: {}, byFactuality: {} };
      mockFetch.mockReturnValue(jsonResponse(stats));
      const result = await client.getMemoryStats();
      expect(result).toEqual(stats);
    });
  });

  describe('listContacts', () => {
    it('should GET /people with optional params', async () => {
      mockFetch.mockReturnValue(jsonResponse({ items: [], total: 0 }));
      await client.listContacts({ limit: 20, offset: 10 });
      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('/people');
      expect(url).toContain('limit=20');
      expect(url).toContain('offset=10');
    });
  });

  describe('searchContacts', () => {
    it('should POST to /people/search', async () => {
      mockFetch.mockReturnValue(jsonResponse([]));
      await client.searchContacts('Amr');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.query).toBe('Amr');
    });
  });

  describe('getContact', () => {
    it('should GET /people/:id', async () => {
      mockFetch.mockReturnValue(jsonResponse({ id: 'c1', displayName: 'Test' }));
      await client.getContact('c1');
      expect(mockFetch.mock.calls[0][0]).toContain('/people/c1');
    });
  });

  describe('getContactMemories', () => {
    it('should GET /people/:id/memories', async () => {
      mockFetch.mockReturnValue(jsonResponse([]));
      await client.getContactMemories('c1');
      expect(mockFetch.mock.calls[0][0]).toContain('/people/c1/memories');
    });
  });

  describe('listAccounts', () => {
    it('should GET /accounts', async () => {
      mockFetch.mockReturnValue(jsonResponse({ accounts: [] }));
      await client.listAccounts();
      expect(mockFetch.mock.calls[0][0]).toContain('/accounts');
    });
  });

  describe('listJobs', () => {
    it('should GET /jobs without accountId', async () => {
      mockFetch.mockReturnValue(jsonResponse({ jobs: [] }));
      await client.listJobs();
      expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:12412/api/jobs');
    });

    it('should GET /jobs with accountId', async () => {
      mockFetch.mockReturnValue(jsonResponse({ jobs: [] }));
      await client.listJobs('acc-1');
      expect(mockFetch.mock.calls[0][0]).toContain('accountId=acc-1');
    });
  });

  describe('triggerSync', () => {
    it('should POST to /jobs/sync/:accountId', async () => {
      mockFetch.mockReturnValue(jsonResponse({ job: { id: 'j1' } }));
      await client.triggerSync('acc-1');
      expect(mockFetch.mock.calls[0][0]).toContain('/jobs/sync/acc-1');
      expect(mockFetch.mock.calls[0][1].method).toBe('POST');
    });
  });

  describe('cancelJob', () => {
    it('should DELETE /jobs/:id', async () => {
      mockFetch.mockReturnValue(jsonResponse({ ok: true }));
      await client.cancelJob('j1');
      expect(mockFetch.mock.calls[0][0]).toContain('/jobs/j1');
      expect(mockFetch.mock.calls[0][1].method).toBe('DELETE');
    });
  });

  describe('retryFailedJobs', () => {
    it('should POST to /jobs/retry-failed', async () => {
      mockFetch.mockReturnValue(jsonResponse({ ok: true, retried: 3 }));
      const result = await client.retryFailedJobs();
      expect(result.retried).toBe(3);
    });
  });

  describe('retryFailedMemories', () => {
    it('should POST to /memories/retry-failed', async () => {
      mockFetch.mockReturnValue(jsonResponse({ enqueued: 5, total: 10 }));
      const result = await client.retryFailedMemories();
      expect(result.enqueued).toBe(5);
    });
  });

  describe('getQueueStats', () => {
    it('should GET /jobs/queues', async () => {
      mockFetch.mockReturnValue(jsonResponse({}));
      await client.getQueueStats();
      expect(mockFetch.mock.calls[0][0]).toContain('/jobs/queues');
    });
  });

  describe('getVersion', () => {
    it('should GET /version', async () => {
      const data = { buildTime: '2025-01-01', gitHash: 'abc', uptime: 3600 };
      mockFetch.mockReturnValue(jsonResponse(data));
      const result = await client.getVersion();
      expect(result).toEqual(data);
    });
  });

  describe('submitRecoveryKey', () => {
    it('should POST recovery key to /user-auth/recovery-key', async () => {
      mockFetch.mockReturnValue(jsonResponse({ ok: true }));
      await client.submitRecoveryKey('my-recovery-key');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.recoveryKey).toBe('my-recovery-key');
    });
  });

  describe('agentAsk', () => {
    it('should POST to /agent/ask', async () => {
      mockFetch.mockReturnValue(jsonResponse({ answer: 'yes' }));
      const result = await client.agentAsk('what happened?', { sourceType: 'email' }, 5);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.query).toBe('what happened?');
      expect(body.filters).toEqual({ sourceType: 'email' });
      expect(body.limit).toBe(5);
      expect(result).toEqual({ answer: 'yes' });
    });
  });

  describe('agentSummarize', () => {
    it('should POST to /agent/summarize', async () => {
      mockFetch.mockReturnValue(jsonResponse({ summary: 'things happened' }));
      await client.agentSummarize('my week', 10);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.query).toBe('my week');
      expect(body.maxResults).toBe(10);
    });
  });

  describe('agentContext', () => {
    it('should GET /agent/context/:contactId', async () => {
      mockFetch.mockReturnValue(jsonResponse({ contact: {} }));
      await client.agentContext('c1');
      expect(mockFetch.mock.calls[0][0]).toContain('/agent/context/c1');
    });
  });

  describe('memory banks', () => {
    it('listMemoryBanks should GET /memory-banks', async () => {
      mockFetch.mockReturnValue(jsonResponse([]));
      await client.listMemoryBanks();
      expect(mockFetch.mock.calls[0][0]).toContain('/memory-banks');
    });

    it('createMemoryBank should POST with name', async () => {
      mockFetch.mockReturnValue(jsonResponse({ id: 'b1', name: 'Work' }));
      await client.createMemoryBank('Work');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.name).toBe('Work');
    });

    it('renameMemoryBank should PATCH with name', async () => {
      mockFetch.mockReturnValue(jsonResponse({ id: 'b1', name: 'Personal' }));
      await client.renameMemoryBank('b1', 'Personal');
      expect(mockFetch.mock.calls[0][0]).toContain('/memory-banks/b1');
      expect(mockFetch.mock.calls[0][1].method).toBe('PATCH');
    });

    it('deleteMemoryBank should DELETE /memory-banks/:id', async () => {
      // deleteMemoryBank calls request which returns response.json() — but void return
      mockFetch.mockReturnValue(jsonResponse(null));
      await client.deleteMemoryBank('b1');
      expect(mockFetch.mock.calls[0][0]).toContain('/memory-banks/b1');
      expect(mockFetch.mock.calls[0][1].method).toBe('DELETE');
    });
  });

  describe('getTimeline', () => {
    it('should GET /memories/timeline with params', async () => {
      mockFetch.mockReturnValue(jsonResponse({ items: [], total: 0 }));
      await client.getTimeline({ from: '2025-01-01', to: '2025-01-31', limit: 10 });
      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('/memories/timeline');
      expect(url).toContain('from=2025-01-01');
      expect(url).toContain('to=2025-01-31');
      expect(url).toContain('limit=10');
    });

    it('should omit empty params', async () => {
      mockFetch.mockReturnValue(jsonResponse({ items: [], total: 0 }));
      await client.getTimeline({});
      expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:12412/api/memories/timeline');
    });
  });

  describe('getRelated', () => {
    it('should GET /memories/:id/related', async () => {
      mockFetch.mockReturnValue(jsonResponse({ items: [], source: null }));
      await client.getRelated('mem-1', 5);
      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('/memories/mem-1/related');
      expect(url).toContain('limit=5');
    });
  });

  describe('searchEntities', () => {
    it('should GET /memories/entities/search with params', async () => {
      mockFetch.mockReturnValue(jsonResponse({ entities: [], total: 0 }));
      await client.searchEntities('Google', 10, 'organization');
      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('/memories/entities/search');
      expect(url).toContain('q=Google');
      expect(url).toContain('limit=10');
      expect(url).toContain('type=organization');
    });
  });

  describe('getEntityGraph', () => {
    it('should GET /memories/entities/:value/graph', async () => {
      mockFetch.mockReturnValue(
        jsonResponse({
          entity: 'Google',
          memories: [],
          relatedEntities: [],
          contacts: [],
          memoryCount: 0,
        }),
      );
      await client.getEntityGraph('Google', 5);
      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('/memories/entities/Google/graph');
      expect(url).toContain('limit=5');
    });
  });

  describe('createCliSession', () => {
    it('should POST to /user-auth/cli/session', async () => {
      mockFetch.mockReturnValue(jsonResponse({ sessionId: 's1', loginUrl: 'http://...' }));
      await client.createCliSession({
        codeChallenge: 'ch',
        codeChallengeMethod: 'S256',
        redirectUri: 'http://localhost:1234/callback',
        state: 'st',
      });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.code_challenge).toBe('ch');
      expect(body.code_challenge_method).toBe('S256');
      expect(body.redirect_uri).toBe('http://localhost:1234/callback');
      expect(body.state).toBe('st');
    });
  });

  describe('exchangeCliCode', () => {
    it('should POST to /user-auth/cli/token', async () => {
      mockFetch.mockReturnValue(
        jsonResponse({
          accessToken: 'at',
          refreshToken: 'rt',
          user: { id: '1', email: 'a', name: 'b' },
        }),
      );
      await client.exchangeCliCode({
        code: 'code',
        codeVerifier: 'verifier',
        redirectUri: 'http://localhost:1234/callback',
      });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.code).toBe('code');
      expect(body.code_verifier).toBe('verifier');
      expect(body.redirect_uri).toBe('http://localhost:1234/callback');
    });
  });
});

describe('BotmemApiError', () => {
  it('should have name, status, and body properties', () => {
    const err = new BotmemApiError('test error', 500, { detail: 'bad' });
    expect(err.name).toBe('BotmemApiError');
    expect(err.status).toBe(500);
    expect(err.body).toEqual({ detail: 'bad' });
    expect(err.message).toBe('test error');
    expect(err instanceof Error).toBe(true);
  });
});

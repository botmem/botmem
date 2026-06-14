import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { __resetApiCacheForTests, api, subscribeToChannel, unsubscribeFromChannel } from '../api';
import { useAuthStore } from '../../store/authStore';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
  __resetApiCacheForTests();
  useAuthStore.setState({ user: null, accessToken: null, error: null, isLoading: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockOk(data: unknown) {
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(data),
  });
}

function mockError(status: number, body: string) {
  mockFetch.mockResolvedValue({
    ok: false,
    status,
    text: () => Promise.resolve(body),
  });
}

describe('api', () => {
  describe('listConnectors', () => {
    it('fetches connectors', async () => {
      mockOk({ connectors: [{ id: 'gmail' }] });
      const result = await api.listConnectors();
      expect(result.connectors).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledWith('/api/connectors', expect.any(Object));
    });
  });

  describe('getConnectorSchema', () => {
    it('fetches schema by type', async () => {
      mockOk({ schema: { type: 'object' } });
      const result = await api.getConnectorSchema('gmail');
      expect(result.schema.type).toBe('object');
    });
  });

  describe('listAccounts', () => {
    it('fetches accounts', async () => {
      mockOk({ accounts: [] });
      const result = await api.listAccounts();
      expect(result.accounts).toEqual([]);
    });
  });

  describe('createAccount', () => {
    it('creates account via POST', async () => {
      mockOk({ id: 'a1', type: 'gmail' });
      await api.createAccount({ connectorType: 'gmail', identifier: 'test' });
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/accounts',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('updateAccount', () => {
    it('updates account via PATCH', async () => {
      mockOk({ id: 'a1', schedule: 'hourly' });
      await api.updateAccount('a1', { schedule: 'hourly' });
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/accounts/a1',
        expect.objectContaining({ method: 'PATCH' }),
      );
    });
  });

  describe('deleteAccount', () => {
    it('deletes account via DELETE', async () => {
      mockOk({ ok: true });
      await api.deleteAccount('a1');
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/accounts/a1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('getBridgeStatus', () => {
    it('fetches bridge connection status', async () => {
      mockOk({ connected: true });
      const result = await api.getBridgeStatus('a1');
      expect(result.connected).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/accounts/a1/bridge-status',
        expect.objectContaining({ headers: expect.any(Object) }),
      );
    });
  });

  describe('getLiveBridgeStatus', () => {
    it('fetches global live bridge status', async () => {
      mockOk({
        online: true,
        flagEnabled: true,
        sources: [{ source: 'whatsapp', count: 10, lastIndexedAt: null }],
      });
      const result = await api.getLiveBridgeStatus();
      expect(result.online).toBe(true);
      expect(result.flagEnabled).toBe(true);
      expect(result.sources).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/bridge/status',
        expect.objectContaining({ headers: expect.any(Object) }),
      );
    });
  });

  describe('initiateAuth', () => {
    it('sends POST with config', async () => {
      mockOk({ type: 'redirect', url: 'https://example.com' });
      const result = await api.initiateAuth('gmail', { clientId: 'cid' });
      expect(result.type).toBe('redirect');
    });
  });

  describe('completeAuth', () => {
    it('sends POST with params', async () => {
      mockOk({ type: 'complete' });
      await api.completeAuth('gmail', { code: 'abc' });
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/auth/gmail/complete',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('listJobs', () => {
    it('fetches jobs', async () => {
      mockOk({ jobs: [] });
      const result = await api.listJobs();
      expect(result.jobs).toEqual([]);
    });

    it('passes accountId filter', async () => {
      mockOk({ jobs: [] });
      await api.listJobs('a1');
      expect(mockFetch).toHaveBeenCalledWith('/api/jobs?accountId=a1', expect.any(Object));
    });
  });

  describe('listLogs', () => {
    it('passes account and job filters', async () => {
      mockOk({ logs: [], total: 0 });
      await api.listLogs({ accountId: 'a1', jobId: 'j1', limit: 10 });
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/logs?accountId=a1&jobId=j1&limit=10',
        expect.any(Object),
      );
    });
  });

  describe('triggerSync', () => {
    it('triggers sync via POST', async () => {
      mockOk({ job: { id: 'j1' } });
      const result = await api.triggerSync('a1');
      expect(result.job.id).toBe('j1');
    });
  });

  describe('cancelJob', () => {
    it('cancels job via DELETE', async () => {
      mockOk({ ok: true });
      await api.cancelJob('j1');
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/jobs/j1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('error handling', () => {
    it('throws on non-ok response', async () => {
      mockError(400, 'Bad request');
      await expect(api.listConnectors()).rejects.toThrow('API 400');
    });

    it('refreshes once and retries the original request after a 401', async () => {
      useAuthStore.setState({
        user: { id: 'u1', email: 'test@test.com', name: 'Test', onboarded: true },
        accessToken: 'old-token',
      });
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 401 } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ accessToken: 'new-token' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: 'u1', email: 'test@test.com' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ connectors: [{ id: 'gmail' }] }),
        });

      const result = await api.listConnectors();

      expect(result.connectors).toEqual([{ id: 'gmail' }]);
      expect(mockFetch).toHaveBeenCalledTimes(4);
      expect(mockFetch.mock.calls[3][1].headers.Authorization).toBe('Bearer new-token');
    });

    it('logs out and does not retry the original request when refresh fails', async () => {
      useAuthStore.setState({
        user: { id: 'u1', email: 'test@test.com', name: 'Test', onboarded: true },
        accessToken: 'old-token',
      });
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 401 } as Response)
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ message: 'Expired' }),
        });

      await expect(api.listConnectors()).rejects.toThrow('Session expired');

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(useAuthStore.getState().user).toBeNull();
      expect(useAuthStore.getState().accessToken).toBeNull();
    });
  });

  describe('searchMemories', () => {
    it('sends POST to /api/memories/search', async () => {
      mockOk({ items: [], fallback: false });
      const result = await api.searchMemories('hello', undefined, 50);
      expect(result.items).toEqual([]);
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/memories/search',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('includes all provided filters', async () => {
      mockOk({ items: [], fallback: false });
      await api.searchMemories(
        'hello',
        {
          connectorTypes: ['gmail'],
          sourceTypes: ['email'],
          factualityLabels: ['FACT'],
          personNames: ['Amr'],
          contactIds: ['person-1'],
          timeRange: { from: '2026-01-01', to: '2026-02-01' },
          pinned: false,
        },
        25,
        'bank-1',
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toMatchObject({
        query: 'hello',
        connectorTypes: ['gmail'],
        sourceTypes: ['email'],
        factualityLabels: ['FACT'],
        personNames: ['Amr'],
        contactIds: ['person-1'],
        timeRange: { from: '2026-01-01', to: '2026-02-01' },
        pinned: false,
        limit: 25,
        memoryBankId: 'bank-1',
      });
    });
  });

  describe('listMemories', () => {
    it('builds query params', async () => {
      mockOk({ items: [], total: 0 });
      await api.listMemories({
        limit: 50,
        offset: 10,
        connectorType: 'gmail',
        sourceType: 'email',
        sortBy: 'eventTime',
        memoryBankId: 'b1',
      });
      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('limit=50');
      expect(url).toContain('offset=10');
      expect(url).toContain('connectorType=gmail');
      expect(url).toContain('sourceType=email');
      expect(url).toContain('sortBy=eventTime');
      expect(url).toContain('memoryBankId=b1');
    });
  });

  describe('pinMemory / unpinMemory', () => {
    it('pins via POST', async () => {
      mockOk({ ok: true });
      await api.pinMemory('m1');
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/memories/m1/pin',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('unpins via DELETE', async () => {
      mockOk({ ok: true });
      await api.unpinMemory('m1');
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/memories/m1/pin',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('recordRecall', () => {
    it('records via POST', async () => {
      mockOk({ ok: true });
      await api.recordRecall('m1');
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/memories/m1/recall',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('contacts', () => {
    it('listContacts with entityType', async () => {
      mockOk({ items: [], total: 0 });
      await api.listContacts({ limit: 100, offset: 20, entityType: 'person' });
      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('limit=100');
      expect(url).toContain('offset=20');
      expect(url).toContain('entityType=person');
    });

    it('searchContacts via POST', async () => {
      mockOk([]);
      await api.searchContacts('alice');
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/people/search',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('getContactMemories with pagination', async () => {
      mockOk({ items: [], total: 0 });
      await api.getContactMemories('c1', { limit: 10, offset: 20 });
      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('/api/people/c1/memories?');
      expect(url).toContain('limit=10');
      expect(url).toContain('offset=20');
    });

    it('updateContact via PATCH', async () => {
      mockOk({ id: 'c1' });
      await api.updateContact('c1', { displayName: 'New' });
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/people/c1',
        expect.objectContaining({ method: 'PATCH' }),
      );
    });

    it('mergeContacts via POST', async () => {
      mockOk({});
      await api.mergeContacts('c1', 'c2');
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/people/c1/merge',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('deleteContact via DELETE', async () => {
      mockOk({});
      await api.deleteContact('c1');
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/people/c1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('dismissSuggestion via POST', async () => {
      mockOk({});
      await api.dismissSuggestion('c1', 'c2');
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/people/suggestions/dismiss',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('removeIdentifier via DELETE', async () => {
      mockOk({});
      await api.removeIdentifier('c1', 'i1');
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/people/c1/identifiers/i1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('splitContact via POST', async () => {
      mockOk({});
      await api.splitContact('c1', ['i1', 'i2']);
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/people/c1/split',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('graph data', () => {
    it('getGraphData without params uses base endpoint', async () => {
      mockOk({ nodes: [], links: [] });
      await api.getGraphData();
      expect(mockFetch.mock.calls[0][0]).toBe('/api/memories/graph');
    });

    it('getGraphData with params', async () => {
      mockOk({ nodes: [], links: [] });
      await api.getGraphData({ memoryLimit: 100, linkLimit: 500, memoryBankId: 'b1' });
      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('memoryLimit=100');
      expect(url).toContain('linkLimit=500');
      expect(url).toContain('memoryBankId=b1');
    });

    it('getGraphData with memoryIds', async () => {
      mockOk({ nodes: [], links: [] });
      await api.getGraphData({ memoryIds: ['m1', 'm2'] });
      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('memoryIds=m1%2Cm2');
    });
  });

  describe('memory stats', () => {
    it('getMemoryStats without params', async () => {
      mockOk({ total: 100 });
      const result = await api.getMemoryStats();
      expect(result.total).toBe(100);
    });

    it('getMemoryStats with memoryBankId', async () => {
      mockOk({ total: 50 });
      await api.getMemoryStats({ memoryBankId: 'b1' });
      expect(mockFetch.mock.calls[0][0]).toContain('memoryBankId=b1');
    });

    it('dedupes concurrent stats requests', async () => {
      mockOk({ total: 100 });
      const [a, b] = await Promise.all([api.getMemoryStats(), api.getMemoryStats()]);
      expect(a.total).toBe(100);
      expect(b.total).toBe(100);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('serves a cached stats result within TTL without refetching', async () => {
      mockOk({ total: 7 });
      const first = await api.getMemoryStats();
      const second = await api.getMemoryStats();
      expect(first.total).toBe(7);
      expect(second.total).toBe(7);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does not cache when the GET ultimately fails', async () => {
      mockError(500, 'boom');
      await expect(api.getMemoryStats()).rejects.toThrow();
      mockOk({ total: 9 });
      const result = await api.getMemoryStats();
      expect(result.total).toBe(9);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('serves a stale stats value and revalidates after the TTL expires', async () => {
      vi.useFakeTimers();
      try {
        mockOk({ total: 1 });
        const first = await api.getMemoryStats();
        expect(first.total).toBe(1);
        expect(mockFetch).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(11_000); // expire the 10s TTL

        mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ total: 2 }) });
        const stale = await api.getMemoryStats();
        expect(stale.total).toBe(1); // stale-while-revalidate returns prior value
        expect(mockFetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('retries a GET once after a 503', async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockResolvedValueOnce({ ok: false, status: 503, text: () => Promise.resolve('busy') })
          .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ total: 100 }) });

        const promise = api.getMemoryStats();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(250);
        await expect(promise).resolves.toMatchObject({ total: 100 });
        expect(mockFetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('memory banks', () => {
    it('listMemoryBanks', async () => {
      mockOk({ memoryBanks: [] });
      const result = await api.listMemoryBanks();
      expect(result.memoryBanks).toEqual([]);
    });

    it('createMemoryBank', async () => {
      mockOk({ id: 'b1', name: 'Test', isDefault: false });
      await api.createMemoryBank('Test');
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/memory-banks',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('deleteMemoryBank', async () => {
      mockOk({ deleted: true, memoriesDeleted: 5 });
      await api.deleteMemoryBank('b1');
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/memory-banks/b1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('settings', () => {
    it('getSettings', async () => {
      mockOk({ key: 'value' });
      const result = await api.getSettings();
      expect(result).toEqual({ key: 'value' });
    });

    it('updateSettings via PATCH', async () => {
      mockOk({ key: 'new' });
      await api.updateSettings({ key: 'new' });
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/settings',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ settings: { key: 'new' } }),
        }),
      );
    });
  });

  describe('admin/danger zone', () => {
    it('purgeMemories', async () => {
      mockOk({});
      await api.purgeMemories();
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/memories/purge',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('retryFailedMemories', async () => {
      mockOk({ enqueued: 5, errors: 0, total: 5 });
      await api.retryFailedMemories(10);
      expect(mockFetch.mock.calls[0][0]).toContain('limit=10');
    });

    it('backfillEnrich', async () => {
      mockOk({ jobId: 'j1', enqueued: 10, total: 10 });
      await api.backfillEnrich('gmail');
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/memories/backfill-enrich',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('api keys', () => {
    it('listApiKeys', async () => {
      mockOk([]);
      const result = await api.listApiKeys();
      expect(result).toEqual([]);
    });

    it('createApiKey', async () => {
      mockOk({ key: 'sk-xxx', id: 'k1', name: 'test', lastFour: 'xxxx' });
      await api.createApiKey('test');
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/api-keys',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('revokeApiKey', async () => {
      mockOk({ success: true });
      await api.revokeApiKey('k1');
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/api-keys/k1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('me endpoints', () => {
    it('getMe', async () => {
      mockOk({ id: 'u1' });
      await api.getMe();
      expect(mockFetch).toHaveBeenCalledWith('/api/me', expect.any(Object));
    });

    it('setMe', async () => {
      mockOk({});
      await api.setMe('c1');
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/me/set',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });
});

describe('WebSocket helpers', () => {
  it('subscribeToChannel sends subscribe message', () => {
    const ws = { send: vi.fn() } as unknown as WebSocket;
    subscribeToChannel(ws, 'logs');
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ event: 'subscribe', data: { channel: 'logs' } }),
    );
  });

  it('unsubscribeFromChannel sends unsubscribe message', () => {
    const ws = { send: vi.fn() } as unknown as WebSocket;
    unsubscribeFromChannel(ws, 'logs');
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ event: 'unsubscribe', data: { channel: 'logs' } }),
    );
  });
});

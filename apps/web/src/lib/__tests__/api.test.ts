import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, subscribeToChannel, unsubscribeFromChannel } from '../api';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockOk(data: any) {
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
      expect(mockFetch).toHaveBeenCalledWith('/api/accounts', expect.objectContaining({ method: 'POST' }));
    });
  });

  describe('updateAccount', () => {
    it('updates account via PATCH', async () => {
      mockOk({ id: 'a1', schedule: 'hourly' });
      await api.updateAccount('a1', { schedule: 'hourly' });
      expect(mockFetch).toHaveBeenCalledWith('/api/accounts/a1', expect.objectContaining({ method: 'PATCH' }));
    });
  });

  describe('deleteAccount', () => {
    it('deletes account via DELETE', async () => {
      mockOk({ ok: true });
      await api.deleteAccount('a1');
      expect(mockFetch).toHaveBeenCalledWith('/api/accounts/a1', expect.objectContaining({ method: 'DELETE' }));
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
      expect(mockFetch).toHaveBeenCalledWith('/api/auth/gmail/complete', expect.objectContaining({ method: 'POST' }));
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
      expect(mockFetch).toHaveBeenCalledWith('/api/jobs/j1', expect.objectContaining({ method: 'DELETE' }));
    });
  });

  describe('listLogs', () => {
    it('fetches logs with params', async () => {
      mockOk({ logs: [], total: 0 });
      await api.listLogs({ jobId: 'j1', limit: 10 });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('jobId=j1'),
        expect.any(Object),
      );
    });

    it('handles no params', async () => {
      mockOk({ logs: [], total: 0 });
      await api.listLogs();
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('throws on non-ok response', async () => {
      mockError(400, 'Bad request');
      await expect(api.listConnectors()).rejects.toThrow('API 400');
    });
  });
});

describe('WebSocket helpers', () => {
  it('subscribeToChannel sends subscribe message', () => {
    const ws = { send: vi.fn() } as unknown as WebSocket;
    subscribeToChannel(ws, 'logs');
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ event: 'subscribe', data: { channel: 'logs' } }));
  });

  it('unsubscribeFromChannel sends unsubscribe message', () => {
    const ws = { send: vi.fn() } as unknown as WebSocket;
    unsubscribeFromChannel(ws, 'logs');
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ event: 'unsubscribe', data: { channel: 'logs' } }));
  });
});

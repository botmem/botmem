import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useJobStore } from '../jobStore';

vi.mock('../../lib/api', () => ({
  api: {
    listJobs: vi.fn(),
    listLogs: vi.fn(),
    cancelJob: vi.fn(),
    getQueueStats: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../../lib/ws', () => ({
  sharedWs: { subscribe: vi.fn(), unsubscribe: vi.fn(), onMessage: vi.fn(), offMessage: vi.fn(), connect: vi.fn() },
}));

import { api } from '../../lib/api';

describe('jobStore', () => {
  beforeEach(() => {
    useJobStore.setState({ jobs: [], logs: [] });
    vi.clearAllMocks();
  });

  describe('fetchJobs', () => {
    it('fetches and sets jobs', async () => {
      (api.listJobs as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ jobs: [{ id: 'j1', accountIdentifier: null, status: 'running' }] });
      await useJobStore.getState().fetchJobs();
      expect(useJobStore.getState().jobs).toHaveLength(1);
    });

    it('handles API error', async () => {
      (api.listJobs as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));
      await useJobStore.getState().fetchJobs();
      expect(useJobStore.getState().jobs).toEqual([]);
    });
  });

  describe('fetchLogs', () => {
    it('fetches and maps logs', async () => {
      (api.listLogs as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        logs: [{ id: 'l1', timestamp: '2026-01-01', level: 'info', connectorType: 'gmail', message: 'ok' }],
      });
      await useJobStore.getState().fetchLogs();
      const logs = useJobStore.getState().logs;
      expect(logs).toHaveLength(1);
      expect(logs[0].connector).toBe('gmail');
    });
  });

  describe('cancelJob', () => {
    it('marks job as cancelled', async () => {
      useJobStore.setState({
        jobs: [
          { id: 'j1', connector: 'gmail', accountId: 'a1', accountIdentifier: null, status: 'running', priority: 0, progress: 5, total: 10, startedAt: null, completedAt: null, error: null },
        ],
      });
      (api.cancelJob as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
      await useJobStore.getState().cancelJob('j1');
      expect(useJobStore.getState().jobs[0].status).toBe('cancelled');
    });

    it('does not cancel done jobs', async () => {
      useJobStore.setState({
        jobs: [
          { id: 'j1', connector: 'gmail', accountId: 'a1', accountIdentifier: null, status: 'done', priority: 0, progress: 10, total: 10, startedAt: null, completedAt: null, error: null },
        ],
      });
      (api.cancelJob as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
      await useJobStore.getState().cancelJob('j1');
      expect(useJobStore.getState().jobs[0].status).toBe('done');
    });
  });

  describe('reprioritize', () => {
    it('moves job up', () => {
      useJobStore.setState({
        jobs: [
          { id: 'j1', connector: 'gmail', accountId: 'a1', accountIdentifier: null, status: 'queued', priority: 0, progress: 0, total: 0, startedAt: null, completedAt: null, error: null },
          { id: 'j2', connector: 'slack', accountId: 'a2', accountIdentifier: null, status: 'queued', priority: 0, progress: 0, total: 0, startedAt: null, completedAt: null, error: null },
        ],
      });
      useJobStore.getState().reprioritize('j2', 'up');
      expect(useJobStore.getState().jobs[0].id).toBe('j2');
    });

    it('moves job down', () => {
      useJobStore.setState({
        jobs: [
          { id: 'j1', connector: 'gmail', accountId: 'a1', accountIdentifier: null, status: 'queued', priority: 0, progress: 0, total: 0, startedAt: null, completedAt: null, error: null },
          { id: 'j2', connector: 'slack', accountId: 'a2', accountIdentifier: null, status: 'queued', priority: 0, progress: 0, total: 0, startedAt: null, completedAt: null, error: null },
        ],
      });
      useJobStore.getState().reprioritize('j1', 'down');
      expect(useJobStore.getState().jobs[0].id).toBe('j2');
    });

    it('does nothing for invalid move', () => {
      useJobStore.setState({
        jobs: [
          { id: 'j1', connector: 'gmail', accountId: 'a1', accountIdentifier: null, status: 'queued', priority: 0, progress: 0, total: 0, startedAt: null, completedAt: null, error: null },
        ],
      });
      useJobStore.getState().reprioritize('j1', 'up');
      expect(useJobStore.getState().jobs[0].id).toBe('j1');
    });
  });

  describe('addLog', () => {
    it('prepends log and limits to 100', () => {
      const logs = Array.from({ length: 100 }, (_, i) => ({
        id: `l${i}`, timestamp: '2026-01-01', level: 'info' as const, connector: 'gmail', message: `msg${i}`,
      }));
      useJobStore.setState({ logs });

      useJobStore.getState().addLog({
        id: 'new', timestamp: '2026-02-01', level: 'warn', connector: 'slack', message: 'new',
      });

      const state = useJobStore.getState();
      expect(state.logs).toHaveLength(100);
      expect(state.logs[0].id).toBe('new');
    });
  });

  describe('tickJobs', () => {
    it('progresses running jobs', () => {
      useJobStore.setState({
        jobs: [
          { id: 'j1', connector: 'gmail', accountId: 'a1', accountIdentifier: null, status: 'running', priority: 0, progress: 5, total: 100, startedAt: '2026-01-01', completedAt: null, error: null },
        ],
      });
      useJobStore.getState().tickJobs();
      expect(useJobStore.getState().jobs[0].progress).toBeGreaterThan(5);
    });

    it('starts queued job when no running', () => {
      useJobStore.setState({
        jobs: [
          { id: 'j1', connector: 'gmail', accountId: 'a1', accountIdentifier: null, status: 'queued', priority: 0, progress: 0, total: 10, startedAt: null, completedAt: null, error: null },
        ],
      });
      useJobStore.getState().tickJobs();
      expect(useJobStore.getState().jobs[0].status).toBe('running');
    });
  });
});

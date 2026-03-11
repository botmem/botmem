import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useJobStore } from '../jobStore';

vi.mock('../../lib/api', () => ({
  api: {
    listJobs: vi.fn(),
    listLogs: vi.fn(),
    cancelJob: vi.fn(),
    getQueueStats: vi.fn().mockResolvedValue({}),
    retryFailedJobs: vi.fn(),
  },
}));

vi.mock('../../lib/ws', () => ({
  sharedWs: { subscribe: vi.fn(), unsubscribe: vi.fn(), onMessage: vi.fn(), offMessage: vi.fn(), connect: vi.fn() },
}));

import { api } from '../../lib/api';

describe('jobStore extended', () => {
  beforeEach(() => {
    useJobStore.setState({ jobs: [], logs: [], totalLogs: 0, hasMoreLogs: true, loadingMoreLogs: false, queueStats: null, notifications: [], retrying: false });
    vi.clearAllMocks();
  });

  describe('fetchQueueStats', () => {
    it('fetches and sets queue stats', async () => {
      (api.getQueueStats as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ sync: { waiting: 2, active: 1, completed: 10, failed: 0, delayed: 0 } });
      await useJobStore.getState().fetchQueueStats();
      expect(useJobStore.getState().queueStats).toHaveProperty('sync');
    });

    it('handles error gracefully', async () => {
      (api.getQueueStats as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));
      await useJobStore.getState().fetchQueueStats();
      expect(useJobStore.getState().queueStats).toBeNull();
    });
  });

  describe('fetchMoreLogs', () => {
    it('appends more logs', async () => {
      useJobStore.setState({
        logs: [{ id: 'l1', timestamp: '2026-01-01', level: 'info' as const, connector: 'gmail', message: 'msg1' }],
        totalLogs: 5,
        hasMoreLogs: true,
      });
      (api.listLogs as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        logs: [{ id: 'l2', timestamp: '2026-01-02', level: 'info', connectorType: 'slack', message: 'msg2' }],
        total: 5,
      });
      await useJobStore.getState().fetchMoreLogs();
      expect(useJobStore.getState().logs).toHaveLength(2);
      expect(useJobStore.getState().loadingMoreLogs).toBe(false);
    });

    it('skips if already loading', async () => {
      useJobStore.setState({ loadingMoreLogs: true, hasMoreLogs: true });
      await useJobStore.getState().fetchMoreLogs();
      expect(api.listLogs).not.toHaveBeenCalled();
    });

    it('skips if no more logs', async () => {
      useJobStore.setState({ hasMoreLogs: false, loadingMoreLogs: false });
      await useJobStore.getState().fetchMoreLogs();
      expect(api.listLogs).not.toHaveBeenCalled();
    });

    it('handles error', async () => {
      useJobStore.setState({ hasMoreLogs: true, loadingMoreLogs: false, logs: [] });
      (api.listLogs as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));
      await useJobStore.getState().fetchMoreLogs();
      expect(useJobStore.getState().loadingMoreLogs).toBe(false);
    });
  });

  describe('clearLogs', () => {
    it('clears logs', () => {
      useJobStore.setState({ logs: [{ id: 'l1', timestamp: '', level: 'info' as const, connector: 'g', message: 'm' }] });
      useJobStore.getState().clearLogs();
      expect(useJobStore.getState().logs).toEqual([]);
    });
  });

  describe('notifications', () => {
    it('addNotification adds to front', () => {
      useJobStore.getState().addNotification('hello', 'info');
      const n = useJobStore.getState().notifications;
      expect(n).toHaveLength(1);
      expect(n[0].message).toBe('hello');
      expect(n[0].read).toBe(false);
    });

    it('limits to 50 notifications', () => {
      for (let i = 0; i < 55; i++) {
        useJobStore.getState().addNotification(`msg${i}`, 'info');
      }
      expect(useJobStore.getState().notifications.length).toBeLessThanOrEqual(50);
    });

    it('markNotificationRead marks one', () => {
      useJobStore.getState().addNotification('test', 'info');
      const id = useJobStore.getState().notifications[0].id;
      useJobStore.getState().markNotificationRead(id);
      expect(useJobStore.getState().notifications[0].read).toBe(true);
    });

    it('markAllNotificationsRead marks all', () => {
      useJobStore.getState().addNotification('a', 'info');
      useJobStore.getState().addNotification('b', 'warn');
      useJobStore.getState().markAllNotificationsRead();
      expect(useJobStore.getState().notifications.every(n => n.read)).toBe(true);
    });

    it('dismissNotification removes it', () => {
      useJobStore.getState().addNotification('test', 'info');
      const id = useJobStore.getState().notifications[0].id;
      useJobStore.getState().dismissNotification(id);
      expect(useJobStore.getState().notifications).toHaveLength(0);
    });
  });

  describe('retryAllFailed', () => {
    it('retries and refreshes jobs', async () => {
      (api.retryFailedJobs as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, retried: 2 });
      (api.listJobs as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ jobs: [] });
      (api.getQueueStats as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
      await useJobStore.getState().retryAllFailed();
      expect(api.retryFailedJobs).toHaveBeenCalled();
      expect(useJobStore.getState().retrying).toBe(false);
    });
  });

  describe('tickJobs - completion', () => {
    it('marks job as done when progress reaches total', () => {
      useJobStore.setState({
        jobs: [
          { id: 'j1', connector: 'gmail', accountId: 'a1', accountIdentifier: null, status: 'running' as const, priority: 0, progress: 99, total: 100, startedAt: '2026-01-01', completedAt: null, error: null },
        ],
      });
      // Run enough ticks
      for (let i = 0; i < 20; i++) useJobStore.getState().tickJobs();
      const job = useJobStore.getState().jobs[0];
      expect(job.progress).toBe(100);
      expect(job.status).toBe('done');
      expect(job.completedAt).not.toBeNull();
    });
  });
});

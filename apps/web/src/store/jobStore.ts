import { create } from 'zustand';
import type { ConnectorType, Job, LogEntry } from '@botmem/shared';
import { api } from '../lib/api';
import { sharedWs } from '../lib/ws';
import { useAuthStore } from './authStore';

export interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

export interface Notification {
  id: string;
  message: string;
  level: 'info' | 'warn' | 'error' | 'success';
  time: string;
  read: boolean;
}

interface JobState {
  jobs: Job[];
  logs: LogEntry[];
  totalLogs: number;
  hasMoreLogs: boolean;
  loadingMoreLogs: boolean;
  queueStats: Record<string, QueueStats> | null;
  notifications: Notification[];
  retrying: boolean;
  fetchJobs: () => Promise<void>;
  fetchLogs: () => Promise<void>;
  fetchMoreLogs: () => Promise<void>;
  fetchQueueStats: () => Promise<void>;
  cancelJob: (id: string) => Promise<void>;
  reprioritize: (id: string, direction: 'up' | 'down') => void;
  addLog: (log: LogEntry) => void;
  clearLogs: () => void;
  connectWs: () => void;
  tickJobs: () => void;
  addNotification: (msg: string, level: 'info' | 'warn' | 'error' | 'success') => void;
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
  dismissNotification: (id: string) => void;
  retryAllFailed: () => Promise<void>;
}

let wsConnected = false;

export const useJobStore = create<JobState>((set, get) => ({
  jobs: [],
  logs: [],
  totalLogs: 0,
  hasMoreLogs: true,
  loadingMoreLogs: false,
  queueStats: null,
  notifications: [],
  retrying: false,

  fetchJobs: async () => {
    try {
      const { jobs } = await api.listJobs();
      set({ jobs });
    } catch {
      // API not available
    }
  },

  fetchQueueStats: async () => {
    try {
      const stats = await api.getQueueStats();
      set({ queueStats: stats });
    } catch {
      // API not available
    }
  },

  fetchLogs: async () => {
    try {
      const result = await api.listLogs({ limit: 200 });
      const logs: LogEntry[] = result.logs.map((l) => ({
        id: l.id,
        timestamp: l.timestamp,
        level: l.level as LogEntry['level'],
        connector: (l.connectorType || l.connector || 'unknown') as ConnectorType,
        stage: (l.stage || undefined) as LogEntry['stage'],
        message: l.message,
      }));
      set({
        logs,
        totalLogs: result.total,
        hasMoreLogs: logs.length < result.total,
      });
    } catch {
      // API not available
    }
  },

  fetchMoreLogs: async () => {
    const { loadingMoreLogs, hasMoreLogs, logs } = get();
    if (loadingMoreLogs || !hasMoreLogs) return;
    set({ loadingMoreLogs: true });
    try {
      const result = await api.listLogs({ limit: 200, offset: logs.length });
      const newLogs: LogEntry[] = result.logs.map((l) => ({
        id: l.id,
        timestamp: l.timestamp,
        level: l.level as LogEntry['level'],
        connector: (l.connectorType || l.connector || 'unknown') as ConnectorType,
        stage: (l.stage || undefined) as LogEntry['stage'],
        message: l.message,
      }));
      const merged = [...logs, ...newLogs];
      set({
        logs: merged,
        totalLogs: result.total,
        hasMoreLogs: merged.length < result.total,
        loadingMoreLogs: false,
      });
    } catch {
      set({ loadingMoreLogs: false });
    }
  },

  cancelJob: async (id) => {
    try {
      await api.cancelJob(id);
    } catch {
      // Continue with local update
    }
    set((state) => ({
      jobs: state.jobs.map((j) =>
        j.id === id && (j.status === 'running' || j.status === 'queued')
          ? { ...j, status: 'cancelled' as const }
          : j,
      ),
    }));
  },

  reprioritize: (id, direction) =>
    set((state) => {
      const jobs = [...state.jobs];
      const idx = jobs.findIndex((j) => j.id === id);
      if (idx < 0) return state;
      const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= jobs.length) return state;
      [jobs[idx], jobs[swapIdx]] = [jobs[swapIdx], jobs[idx]];
      return { jobs };
    }),

  addLog: (log) =>
    set((state) => ({
      logs: [log, ...state.logs].slice(0, 100),
      totalLogs: state.totalLogs + 1,
    })),

  clearLogs: () => set({ logs: [] }),

  addNotification: (msg, level) =>
    set((state) => ({
      notifications: [
        {
          id: crypto.randomUUID(),
          message: msg,
          level,
          time: new Date().toISOString(),
          read: false,
        },
        ...state.notifications,
      ].slice(0, 50),
    })),

  markNotificationRead: (id) =>
    set((state) => ({
      notifications: state.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
    })),

  markAllNotificationsRead: () =>
    set((state) => ({
      notifications: state.notifications.map((n) => ({ ...n, read: true })),
    })),

  dismissNotification: (id) =>
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    })),

  retryAllFailed: async () => {
    set({ retrying: true });
    try {
      await api.retryFailedJobs();
      await get().fetchJobs();
      await get().fetchQueueStats();
    } catch {
      // ignore
    } finally {
      set({ retrying: false });
    }
  },

  connectWs: () => {
    if (wsConnected) return;
    wsConnected = true;

    const token = useAuthStore.getState().accessToken ?? undefined;
    sharedWs.subscribe('logs', token);
    sharedWs.subscribe('dashboard', token);

    sharedWs.onMessage((msg) => {
      if (msg.event === 'log') {
        get().addLog({
          id: crypto.randomUUID(),
          timestamp: msg.data.timestamp,
          level: msg.data.level,
          connector: msg.data.connectorType,
          stage: msg.data.stage || undefined,
          message: msg.data.message,
        });
      }
      if (msg.event === 'job:progress') {
        set((state) => ({
          jobs: state.jobs.map((j) =>
            j.id === msg.data.jobId
              ? {
                  ...j,
                  progress: msg.data.processed ?? msg.data.progress ?? j.progress,
                  total: msg.data.total || j.total,
                }
              : j,
          ),
        }));
      }
      if (msg.event === 'job:complete' || msg.event === 'dashboard:jobs') {
        get().fetchJobs();
        get().fetchQueueStats();
      }
      if (msg.event === 'dashboard:queue-stats-changed') {
        get().fetchQueueStats();
      }
      if (msg.event === 'job:complete') {
        get().addNotification('Sync job completed', 'success');
      }
      if (msg.event === 'connector:warning') {
        get().addNotification(msg.data?.message || 'Connector warning', 'warn');
      }
    });
  },

  tickJobs: () =>
    set((state) => {
      const jobs = state.jobs.map((j) => {
        if (j.status === 'running' && j.progress < j.total) {
          const progress = Math.min(j.progress + Math.floor(Math.random() * 5) + 1, j.total);
          return {
            ...j,
            progress,
            status: progress >= j.total ? ('done' as const) : j.status,
            completedAt: progress >= j.total ? new Date().toISOString() : null,
          };
        }
        return j;
      });
      const hasRunning = jobs.some((j) => j.status === 'running');
      if (!hasRunning) {
        const queuedIdx = jobs.findIndex((j) => j.status === 'queued');
        if (queuedIdx >= 0) {
          jobs[queuedIdx] = {
            ...jobs[queuedIdx],
            status: 'running',
            startedAt: new Date().toISOString(),
          };
        }
      }
      return { jobs };
    }),
}));

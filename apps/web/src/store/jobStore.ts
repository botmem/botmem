import { create } from 'zustand';
import type { Job, LogEntry } from '@botmem/shared';
import { api, createWsConnection, subscribeToChannel } from '../lib/api';

export interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

interface JobState {
  jobs: Job[];
  logs: LogEntry[];
  queueStats: Record<string, QueueStats> | null;
  ws: WebSocket | null;
  fetchJobs: () => Promise<void>;
  fetchLogs: () => Promise<void>;
  fetchQueueStats: () => Promise<void>;
  cancelJob: (id: string) => Promise<void>;
  reprioritize: (id: string, direction: 'up' | 'down') => void;
  addLog: (log: LogEntry) => void;
  connectWs: () => void;
  tickJobs: () => void;
}

export const useJobStore = create<JobState>((set, get) => ({
  jobs: [],
  logs: [],
  queueStats: null,
  ws: null,

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
      const { logs } = await api.listLogs({ limit: 100 });
      set({
        logs: logs.map((l: any) => ({
          id: l.id,
          timestamp: l.timestamp,
          level: l.level,
          connector: l.connectorType || l.connector,
          stage: l.stage || undefined,
          message: l.message,
        })),
      });
    } catch {
      // API not available
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
          : j
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
    })),

  connectWs: () => {
    try {
      const ws = createWsConnection();
      ws.onopen = () => {
        subscribeToChannel(ws, 'logs');
      };
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.event === 'log') {
          get().addLog({
            id: crypto.randomUUID(),
            timestamp: data.data.timestamp,
            level: data.data.level,
            connector: data.data.connectorType,
            stage: data.data.stage || undefined,
            message: data.data.message,
          });
        }
        if (data.event === 'job:progress') {
          set((state) => ({
            jobs: state.jobs.map((j) =>
              j.id === data.data.jobId
                ? { ...j, progress: data.data.processed ?? data.data.progress ?? j.progress, total: data.data.total || j.total }
                : j
            ),
          }));
        }
        if (data.event === 'job:complete') {
          get().fetchJobs();
        }
      };
      set({ ws });
    } catch {
      // WebSocket not available
    }
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
          jobs[queuedIdx] = { ...jobs[queuedIdx], status: 'running', startedAt: new Date().toISOString() };
        }
      }
      return { jobs };
    }),
}));

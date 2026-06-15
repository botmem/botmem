import { create } from 'zustand';
import type {
  ConnectorAccount,
  ConnectorManifest,
  ConnectorType,
  SyncSchedule,
} from '@botmem/shared';
import { api } from '../lib/api';
import { trackEvent } from '../lib/posthog';
import { useJobStore } from './jobStore';

interface ConnectorState {
  accounts: ConnectorAccount[];
  manifests: ConnectorManifest[];
  loading: boolean;
  error: string | null;
  fetchManifests: () => Promise<void>;
  fetchAccounts: () => Promise<void>;
  addAccount: (type: ConnectorType, identifier: string, schedule?: SyncSchedule) => Promise<void>;
  removeAccount: (id: string) => Promise<void>;
  updateSchedule: (id: string, schedule: SyncSchedule) => Promise<void>;
  syncNow: (id: string, memoryBankId?: string) => Promise<void>;
  syncAll: (memoryBankId?: string) => Promise<void>;
  syncingAll: boolean;
  clearError: () => void;
}

export const useConnectorStore = create<ConnectorState>((set, _get) => ({
  accounts: [],
  manifests: [],
  loading: false,
  error: null,
  syncingAll: false,
  clearError: () => set({ error: null }),

  fetchManifests: async () => {
    set({ loading: true });
    try {
      const { connectors } = await api.listConnectors();
      set({ manifests: connectors });
    } catch {
      // API not available, keep empty
    } finally {
      set({ loading: false });
    }
  },

  fetchAccounts: async () => {
    try {
      const { accounts } = await api.listAccounts();
      set({ accounts });
    } catch {
      // API not available
    }
  },

  addAccount: async (type, identifier, schedule) => {
    try {
      const account = await api.createAccount({ connectorType: type, identifier, schedule });
      trackEvent('connector_added', { connector_type: type });
      await _get().fetchAccounts();
      set((state) =>
        state.accounts.some((a) => a.id === account.id)
          ? state
          : { accounts: [...state.accounts, account] },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to connect account';
      set({ error: message });
      throw err;
    }
  },

  removeAccount: async (id) => {
    const account = _get().accounts.find((a) => a.id === id);
    try {
      await api.deleteAccount(id);
    } catch {
      // Continue with local removal
    }
    trackEvent('connector_removed', { connector_type: account?.type });
    set((state) => ({ accounts: state.accounts.filter((a) => a.id !== id) }));
  },

  updateSchedule: async (id, schedule) => {
    try {
      await api.updateAccount(id, { schedule });
    } catch {
      // Continue with local update
    }
    set((state) => ({
      accounts: state.accounts.map((a) => (a.id === id ? { ...a, schedule } : a)),
    }));
  },

  syncNow: async (id, memoryBankId?) => {
    const account = _get().accounts.find((a) => a.id === id);
    // Apple/iMessage are live-bridge only — there is no sync to trigger.
    if (account?.type === 'apple' || account?.type === 'imessage') return;
    trackEvent('sync_triggered', { connector_type: account?.type });
    set((state) => ({
      error: null,
      accounts: state.accounts.map((a) => (a.id === id ? { ...a, status: 'syncing' as const } : a)),
    }));
    try {
      const res = await api.triggerSync(id, memoryBankId);
      if (!('job' in res)) return;
      const { job } = res;
      useJobStore.getState().upsertJob(job);
      void useJobStore.getState().fetchJobs(id);
      set((state) => ({
        accounts: state.accounts.map((a) =>
          a.id === id
            ? {
                ...a,
                status: job.status === 'queued' ? ('queued' as const) : ('syncing' as const),
                syncHealth: {
                  ...(a.syncHealth || {
                    activeJobId: null,
                    queuedJobId: null,
                    lastActivityAt: null,
                    progress: null,
                    total: null,
                    recoveryAction: null,
                    recoveryReason: null,
                  }),
                  phase: job.status === 'queued' ? 'Queued for sync' : 'Syncing connector data',
                  activeJobId: job.status === 'running' ? job.id : null,
                  queuedJobId: job.status === 'queued' ? job.id : null,
                  progress: job.progress ?? null,
                  total: job.total ?? null,
                  lastActivityAt: job.startedAt,
                },
              }
            : a,
        ),
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sync failed';
      set({ error: `Sync failed for ${account?.identifier || id}: ${message}` });
      await _get().fetchAccounts();
    }
  },

  syncAll: async (memoryBankId?) => {
    const syncable = _get().accounts.filter(
      (a) =>
        // Apple/iMessage are live-bridge only — exclude from bulk sync.
        a.type !== 'apple' &&
        a.type !== 'imessage' &&
        (a.status === 'connected' ||
          a.status === 'degraded' ||
          a.status === 'failed' ||
          a.status === 'error' ||
          a.status === 'disconnected' ||
          a.status === 'reconnect_required'),
    );
    if (syncable.length === 0) return;

    trackEvent('sync_all_triggered', { account_count: syncable.length });
    set({ syncingAll: true });
    set((state) => ({
      accounts: state.accounts.map((a) =>
        syncable.some((s) => s.id === a.id) ? { ...a, status: 'syncing' as const } : a,
      ),
    }));

    await Promise.allSettled(
      syncable.map((a) =>
        api
          .triggerSync(a.id, memoryBankId)
          .then((res) => {
            if ('job' in res) useJobStore.getState().upsertJob(res.job);
          })
          .catch(() => {}),
      ),
    );
    void useJobStore.getState().fetchJobs();
    await _get().fetchAccounts();
    set({ syncingAll: false });
  },
}));

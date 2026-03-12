import { create } from 'zustand';
import type {
  ConnectorAccount,
  ConnectorManifest,
  ConnectorType,
  SyncSchedule,
} from '@botmem/shared';
import { api } from '../lib/api';
import { trackEvent } from '../lib/posthog';

interface ConnectorState {
  accounts: ConnectorAccount[];
  manifests: ConnectorManifest[];
  loading: boolean;
  fetchManifests: () => Promise<void>;
  fetchAccounts: () => Promise<void>;
  addAccount: (type: ConnectorType, identifier: string) => Promise<void>;
  removeAccount: (id: string) => Promise<void>;
  updateSchedule: (id: string, schedule: SyncSchedule) => Promise<void>;
  syncNow: (id: string, memoryBankId?: string) => Promise<void>;
  syncAll: (memoryBankId?: string) => Promise<void>;
  syncingAll: boolean;
}

export const useConnectorStore = create<ConnectorState>((set, _get) => ({
  accounts: [],
  manifests: [],
  loading: false,
  syncingAll: false,

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

  addAccount: async (type, identifier) => {
    try {
      const account = await api.createAccount({ connectorType: type, identifier });
      trackEvent('connector_added', { connector_type: type });
      set((state) => ({ accounts: [...state.accounts, account] }));
    } catch {
      // Fallback to local-only
      set((state) => ({
        accounts: [
          ...state.accounts,
          {
            id: crypto.randomUUID(),
            type,
            identifier,
            status: 'connected' as const,
            schedule: 'hourly' as const,
            lastSync: null,
            memoriesIngested: 0,
            contactsCount: 0,
            groupsCount: 0,
            lastError: null,
          },
        ],
      }));
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
    trackEvent('sync_triggered', { connector_type: account?.type });
    set((state) => ({
      accounts: state.accounts.map((a) => (a.id === id ? { ...a, status: 'syncing' as const } : a)),
    }));
    try {
      await api.triggerSync(id, memoryBankId);
    } catch {
      set((state) => ({
        accounts: state.accounts.map((a) =>
          a.id === id ? { ...a, status: 'connected' as const } : a,
        ),
      }));
    }
  },

  syncAll: async (memoryBankId?) => {
    const syncable = _get().accounts.filter(
      (a) => a.status === 'connected' || a.status === 'error' || a.status === 'disconnected',
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
      syncable.map((a) => api.triggerSync(a.id, memoryBankId).catch(() => {})),
    );
    set({ syncingAll: false });
  },
}));

import { create } from 'zustand';
import type {
  ConnectorAccount,
  ConnectorManifest,
  ConnectorType,
  SyncSchedule,
} from '@botmem/shared';
import { api } from '../lib/api';

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
}

export const useConnectorStore = create<ConnectorState>((set, _get) => ({
  accounts: [],
  manifests: [],
  loading: false,

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
            lastError: null,
          },
        ],
      }));
    }
  },

  removeAccount: async (id) => {
    try {
      await api.deleteAccount(id);
    } catch {
      // Continue with local removal
    }
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
}));

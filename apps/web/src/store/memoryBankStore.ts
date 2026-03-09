import { create } from 'zustand';
import { api } from '../lib/api';

export interface MemoryBank {
  id: string;
  name: string;
  isDefault: boolean;
  memoryCount: number;
  createdAt: string;
  updatedAt: string;
}

interface MemoryBankState {
  memoryBanks: MemoryBank[];
  activeMemoryBankId: string | null;
  loading: boolean;
  loadMemoryBanks: () => Promise<void>;
  createMemoryBank: (name: string) => Promise<void>;
  renameMemoryBank: (id: string, name: string) => Promise<void>;
  deleteMemoryBank: (id: string) => Promise<void>;
  setActiveMemoryBank: (id: string | null) => void;
}

const STORAGE_KEY = 'botmem:activeMemoryBankId';

function loadPersistedBankId(): string | null {
  try {
    const val = localStorage.getItem(STORAGE_KEY);
    return val || null;
  } catch {
    return null;
  }
}

export const useMemoryBankStore = create<MemoryBankState>((set, get) => ({
  memoryBanks: [],
  activeMemoryBankId: loadPersistedBankId(),
  loading: false,

  loadMemoryBanks: async () => {
    set({ loading: true });
    try {
      const result = await api.listMemoryBanks();
      set({ memoryBanks: result.memoryBanks, loading: false });
      // If persisted bank no longer exists, reset to null
      const activeId = get().activeMemoryBankId;
      if (activeId && !result.memoryBanks.find((b) => b.id === activeId)) {
        set({ activeMemoryBankId: null });
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch (err) {
      console.error('Failed to load memory banks:', err);
      set({ loading: false });
    }
  },

  createMemoryBank: async (name: string) => {
    try {
      await api.createMemoryBank(name);
      await get().loadMemoryBanks();
    } catch (err) {
      console.error('Failed to create memory bank:', err);
      throw err;
    }
  },

  renameMemoryBank: async (id: string, name: string) => {
    try {
      await api.renameMemoryBank(id, name);
      set((state) => ({
        memoryBanks: state.memoryBanks.map((b) => (b.id === id ? { ...b, name } : b)),
      }));
    } catch (err) {
      console.error('Failed to rename memory bank:', err);
      throw err;
    }
  },

  deleteMemoryBank: async (id: string) => {
    try {
      await api.deleteMemoryBank(id);
      const activeId = get().activeMemoryBankId;
      if (activeId === id) {
        set({ activeMemoryBankId: null });
        localStorage.removeItem(STORAGE_KEY);
      }
      await get().loadMemoryBanks();
    } catch (err) {
      console.error('Failed to delete memory bank:', err);
      throw err;
    }
  },

  setActiveMemoryBank: (id: string | null) => {
    set({ activeMemoryBankId: id });
    if (id) {
      localStorage.setItem(STORAGE_KEY, id);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  },
}));

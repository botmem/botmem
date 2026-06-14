import { create } from 'zustand';
import { api, type LiveBridgeStatus } from '../lib/api';

const POLL_INTERVAL_MS = 10_000;

interface BridgeStore {
  status: LiveBridgeStatus | null;
  loading: boolean;
  error: string | null;
  fetchStatus: () => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
}

// Module-scoped timer so polling survives store re-renders and is shared.
let pollTimer: ReturnType<typeof setInterval> | null = null;

export const useBridgeStore = create<BridgeStore>((set, get) => ({
  status: null,
  loading: false,
  error: null,

  fetchStatus: async () => {
    // Only show the spinner on the first load; polling refreshes silently.
    set((s) => ({ loading: s.status === null, error: null }));
    try {
      const status = await api.getLiveBridgeStatus();
      set({ status, loading: false, error: null });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load bridge status',
      });
    }
  },

  startPolling: () => {
    if (pollTimer !== null) return;
    void get().fetchStatus();
    pollTimer = setInterval(() => {
      void get().fetchStatus();
    }, POLL_INTERVAL_MS);
  },

  stopPolling: () => {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  },
}));

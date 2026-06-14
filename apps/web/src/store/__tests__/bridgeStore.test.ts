import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useBridgeStore } from '../bridgeStore';
import { api } from '../../lib/api';

vi.mock('../../lib/api', () => ({
  api: {
    getLiveBridgeStatus: vi.fn(),
  },
}));

const getLiveBridgeStatus = vi.mocked(api.getLiveBridgeStatus);

describe('bridgeStore', () => {
  beforeEach(() => {
    useBridgeStore.setState({ status: null, loading: false, error: null });
    useBridgeStore.getState().stopPolling();
    vi.clearAllMocks();
  });

  afterEach(() => {
    useBridgeStore.getState().stopPolling();
  });

  describe('fetchStatus', () => {
    it('stores an online status with sources', async () => {
      getLiveBridgeStatus.mockResolvedValue({
        online: true,
        flagEnabled: true,
        sources: [
          { source: 'whatsapp', count: 1200, lastIndexedAt: '2026-06-12T00:00:00.000Z' },
          { source: 'imessage', count: 340, lastIndexedAt: null },
        ],
      });

      await useBridgeStore.getState().fetchStatus();

      const state = useBridgeStore.getState();
      expect(state.status?.online).toBe(true);
      expect(state.status?.sources).toHaveLength(2);
      expect(state.loading).toBe(false);
      expect(state.error).toBeNull();
    });

    it('stores an offline status', async () => {
      getLiveBridgeStatus.mockResolvedValue({ online: false, flagEnabled: true });

      await useBridgeStore.getState().fetchStatus();

      const state = useBridgeStore.getState();
      expect(state.status?.online).toBe(false);
      expect(state.error).toBeNull();
    });

    it('captures an error message when the request fails', async () => {
      getLiveBridgeStatus.mockRejectedValue(new Error('network down'));

      await useBridgeStore.getState().fetchStatus();

      const state = useBridgeStore.getState();
      expect(state.error).toBe('network down');
      expect(state.loading).toBe(false);
    });

    it('sets loading only on the first load', async () => {
      getLiveBridgeStatus.mockResolvedValue({ online: true, flagEnabled: true, sources: [] });
      // Seed an existing status so the next fetch is treated as a silent refresh.
      useBridgeStore.setState({
        status: { online: false, flagEnabled: true },
      });

      let loadingDuringFetch = false;
      getLiveBridgeStatus.mockImplementation(async () => {
        loadingDuringFetch = useBridgeStore.getState().loading;
        return { online: true, flagEnabled: true, sources: [] };
      });

      await useBridgeStore.getState().fetchStatus();
      expect(loadingDuringFetch).toBe(false);
    });
  });

  describe('polling', () => {
    it('fetches immediately and on each interval, and stops cleanly', async () => {
      vi.useFakeTimers();
      try {
        getLiveBridgeStatus.mockResolvedValue({ online: true, flagEnabled: true, sources: [] });

        useBridgeStore.getState().startPolling();
        expect(getLiveBridgeStatus).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(10_000);
        expect(getLiveBridgeStatus).toHaveBeenCalledTimes(2);

        useBridgeStore.getState().stopPolling();
        await vi.advanceTimersByTimeAsync(20_000);
        expect(getLiveBridgeStatus).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not start a second concurrent poll timer', () => {
      vi.useFakeTimers();
      try {
        getLiveBridgeStatus.mockResolvedValue({ online: false, flagEnabled: true });
        useBridgeStore.getState().startPolling();
        useBridgeStore.getState().startPolling();
        // Both calls combined should only trigger one immediate fetch.
        expect(getLiveBridgeStatus).toHaveBeenCalledTimes(1);
      } finally {
        useBridgeStore.getState().stopPolling();
        vi.useRealTimers();
      }
    });
  });
});

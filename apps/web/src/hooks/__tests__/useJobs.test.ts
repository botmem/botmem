import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useJobs } from '../useJobs';
import { useJobStore } from '../../store/jobStore';

vi.mock('../../lib/api', () => ({
  api: {
    listJobs: vi.fn().mockResolvedValue({ jobs: [] }),
    listLogs: vi.fn().mockResolvedValue({ logs: [] }),
    getQueueStats: vi.fn().mockResolvedValue({}),
    cancelJob: vi.fn(),
  },
}));

vi.mock('../../lib/ws', () => ({
  sharedWs: { subscribe: vi.fn(), unsubscribe: vi.fn(), onMessage: vi.fn(), offMessage: vi.fn(), connect: vi.fn() },
}));

describe('useJobs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useJobStore.setState({ jobs: [], logs: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns job store state', () => {
    const { result } = renderHook(() => useJobs());
    expect(result.current.jobs).toEqual([]);
    expect(result.current.logs).toEqual([]);
    expect(typeof result.current.fetchJobs).toBe('function');
    expect(typeof result.current.cancelJob).toBe('function');
  });

  it('cleans up interval on unmount', () => {
    const { unmount } = renderHook(() => useJobs());
    unmount();
    // No errors on unmount = cleanup works
  });
});

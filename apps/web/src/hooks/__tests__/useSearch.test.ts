import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

// Stub localStorage for memoryBankStore
const store: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => { store[key] = value; },
  removeItem: (key: string) => { delete store[key]; },
  clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
  get length() { return Object.keys(store).length; },
  key: (i: number) => Object.keys(store)[i] ?? null,
});

// Mock the api module
vi.mock('../../lib/api', () => ({
  api: {
    searchMemories: vi.fn(),
  },
}));

// Mock the memoryBankStore
vi.mock('../../store/memoryBankStore', () => ({
  useMemoryBankStore: {
    getState: () => ({ activeMemoryBankId: null }),
  },
}));

import { api } from '../../lib/api';
import { useSearch } from '../useSearch';

const mockSearchResult = {
  items: [
    { id: 'mem-1', text: 'Result 1' },
    { id: 'mem-2', text: 'Result 2' },
  ],
  resolvedEntities: {
    contacts: [{ id: 'c1', displayName: 'John' }],
    topicWords: ['meeting'],
    topicMatchCount: 1,
  },
  fallback: false,
  parsed: { query: 'test query' },
};

describe('useSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it('initializes with empty state', () => {
    const { result } = renderHook(() => useSearch());

    expect(result.current.term).toBe('');
    expect(result.current.pending).toBe(false);
    expect(result.current.results).toBeNull();
  });

  it('ignores terms shorter than minLength', () => {
    vi.mocked(api.searchMemories).mockResolvedValue(mockSearchResult as any);

    const { result } = renderHook(() => useSearch({ minLength: 3 }));

    act(() => {
      result.current.setTerm('ab');
    });

    act(() => { vi.advanceTimersByTime(600); });

    expect(api.searchMemories).not.toHaveBeenCalled();
  });

  it('searches after debounce', async () => {
    vi.mocked(api.searchMemories).mockResolvedValue(mockSearchResult as any);
    const onResults = vi.fn();

    const { result } = renderHook(() => useSearch({ debounceMs: 300, onResults }));

    act(() => {
      result.current.setTerm('test query');
    });

    // Before debounce
    expect(api.searchMemories).not.toHaveBeenCalled();

    // After debounce
    await act(async () => {
      vi.advanceTimersByTime(300);
      // Let promises resolve
      await vi.runAllTimersAsync();
    });

    expect(api.searchMemories).toHaveBeenCalledWith('test query', undefined, 100, undefined);
  });

  it('clears results and calls onClear', () => {
    const onClear = vi.fn();
    const { result } = renderHook(() => useSearch({ onClear }));

    act(() => {
      result.current.setTerm('test');
    });

    act(() => {
      result.current.clear();
    });

    expect(result.current.term).toBe('');
    expect(result.current.results).toBeNull();
    expect(onClear).toHaveBeenCalled();
  });

  it('clears results when term becomes empty after having results', async () => {
    vi.mocked(api.searchMemories).mockResolvedValue(mockSearchResult as any);
    const onClear = vi.fn();

    const { result } = renderHook(() => useSearch({ debounceMs: 100, onClear }));

    // Set search term and get results
    act(() => { result.current.setTerm('test query'); });
    await act(async () => {
      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();
    });

    // Clear the term
    act(() => { result.current.setTerm(''); });

    expect(result.current.results).toBeNull();
  });

  it('handles search error gracefully', async () => {
    vi.mocked(api.searchMemories).mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useSearch({ debounceMs: 100 }));

    act(() => { result.current.setTerm('test query'); });

    await act(async () => {
      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();
    });

    expect(result.current.results).toBeNull();
    expect(result.current.pending).toBe(false);
  });
});

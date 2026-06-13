import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Stub localStorage for memoryBankStore
const store: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => {
    store[key] = value;
  },
  removeItem: (key: string) => {
    delete store[key];
  },
  clear: () => {
    Object.keys(store).forEach((k) => delete store[k]);
  },
  get length() {
    return Object.keys(store).length;
  },
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
    vi.mocked(api.searchMemories).mockResolvedValue(mockSearchResult as never);

    const { result } = renderHook(() => useSearch({ minLength: 3 }));

    act(() => {
      result.current.setTerm('ab');
    });

    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(api.searchMemories).not.toHaveBeenCalled();
  });

  it('searches after debounce', async () => {
    vi.mocked(api.searchMemories).mockResolvedValue(mockSearchResult as never);
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
    vi.mocked(api.searchMemories).mockResolvedValue(mockSearchResult as never);
    const onClear = vi.fn();

    const { result } = renderHook(() => useSearch({ debounceMs: 100, onClear }));

    // Set search term and get results
    act(() => {
      result.current.setTerm('test query');
    });
    await act(async () => {
      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();
    });

    // Clear the term
    act(() => {
      result.current.setTerm('');
    });

    expect(result.current.results).toBeNull();
  });

  it('handles search error gracefully', async () => {
    vi.mocked(api.searchMemories).mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useSearch({ debounceMs: 100 }));

    act(() => {
      result.current.setTerm('test query');
    });

    await act(async () => {
      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();
    });

    expect(result.current.results).toBeNull();
    expect(result.current.error).toBe('Network error');
    expect(result.current.pending).toBe(false);
  });

  it('does not let a stale slower response overwrite a newer one', async () => {
    let resolveSlow: (value: typeof mockSearchResult) => void = () => {};
    vi.mocked(api.searchMemories)
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveSlow = resolve;
      }) as never)
      .mockResolvedValueOnce({
        ...mockSearchResult,
        items: [{ id: 'mem-new', text: 'New result' }],
      } as never);

    const { result } = renderHook(() => useSearch({ debounceMs: 100 }));

    act(() => {
      result.current.setTerm('old query');
    });
    await act(async () => {
      vi.advanceTimersByTime(100);
      await Promise.resolve();
    });

    act(() => {
      result.current.setTerm('new query');
    });
    await act(async () => {
      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();
    });

    await act(async () => {
      resolveSlow({
        ...mockSearchResult,
        items: [{ id: 'mem-old', text: 'Old result' }],
      });
      await Promise.resolve();
    });

    expect(result.current.results?.items[0].id).toBe('mem-new');
  });

  it('clears stale results as soon as a valid new query starts waiting', async () => {
    vi.mocked(api.searchMemories).mockResolvedValue(mockSearchResult as never);

    const { result } = renderHook(() => useSearch({ debounceMs: 100 }));

    act(() => {
      result.current.setTerm('old query');
    });
    await act(async () => {
      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();
    });

    expect(result.current.results?.items).toHaveLength(2);

    act(() => {
      result.current.setTerm('new query');
    });

    expect(result.current.pending).toBe(true);
    expect(result.current.results).toBeNull();
  });
});

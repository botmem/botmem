import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useMemories } from '../useMemories';
import { useMemoryStore } from '../../store/memoryStore';

describe('useMemories', () => {
  beforeEach(() => {
    useMemoryStore.setState({
      query: '',
      filters: { source: null, factuality: null, minImportance: 0 },
    });
  });

  it('returns store state with filtered memories', () => {
    const { result } = renderHook(() => useMemories());
    expect(result.current.filtered).toBeDefined();
    expect(Array.isArray(result.current.filtered)).toBe(true);
    expect(typeof result.current.setQuery).toBe('function');
  });

  it('filtered returns all memories with no filters', () => {
    const { result } = renderHook(() => useMemories());
    expect(result.current.filtered.length).toBeGreaterThan(0);
  });
});

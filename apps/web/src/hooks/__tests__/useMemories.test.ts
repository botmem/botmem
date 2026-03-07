import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useMemories } from '../useMemories';
import { useMemoryStore } from '../../store/memoryStore';

const sampleMemories = [
  {
    id: 'mem-1',
    source: 'email' as const,
    sourceConnector: 'gmail',
    accountIdentifier: null,
    text: 'Meeting with Dr. Khalil',
    time: '2025-01-15T10:00:00Z',
    ingestTime: '2025-01-15T10:00:00Z',
    factuality: { label: 'UNVERIFIED' as const, confidence: 0.5, rationale: '' },
    weights: { semantic: 0.5, rerank: 0, recency: 0.5, importance: 0.5, trust: 0.5, final: 0.5 },
    entities: [],
    claims: [],
    metadata: {},
    pinned: false,
  },
];

describe('useMemories', () => {
  beforeEach(() => {
    useMemoryStore.setState({
      memories: sampleMemories as any,
      query: '',
      filters: { source: null, minImportance: 0 },
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

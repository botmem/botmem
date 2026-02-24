import { describe, it, expect, beforeEach } from 'vitest';
import { useMemoryStore } from '../memoryStore';

describe('memoryStore', () => {
  beforeEach(() => {
    useMemoryStore.setState({
      query: '',
      filters: { source: null, factuality: null, minImportance: 0 },
    });
  });

  describe('setQuery', () => {
    it('sets search query', () => {
      useMemoryStore.getState().setQuery('meeting');
      expect(useMemoryStore.getState().query).toBe('meeting');
    });
  });

  describe('setFilters', () => {
    it('sets source filter', () => {
      useMemoryStore.getState().setFilters({ source: 'email' });
      expect(useMemoryStore.getState().filters.source).toBe('email');
    });

    it('sets factuality filter', () => {
      useMemoryStore.getState().setFilters({ factuality: 'FACT' });
      expect(useMemoryStore.getState().filters.factuality).toBe('FACT');
    });

    it('sets importance filter', () => {
      useMemoryStore.getState().setFilters({ minImportance: 0.5 });
      expect(useMemoryStore.getState().filters.minImportance).toBe(0.5);
    });

    it('merges partial filters', () => {
      useMemoryStore.getState().setFilters({ source: 'email' });
      useMemoryStore.getState().setFilters({ factuality: 'FACT' });
      const filters = useMemoryStore.getState().filters;
      expect(filters.source).toBe('email');
      expect(filters.factuality).toBe('FACT');
    });
  });

  describe('insertMemory', () => {
    it('prepends memory to list', () => {
      const initialCount = useMemoryStore.getState().memories.length;
      useMemoryStore.getState().insertMemory({
        id: 'new-mem',
        source: 'email',
        sourceConnector: 'gmail',
        text: 'New memory',
        time: '2026-02-23T12:00:00Z',
        ingestTime: '2026-02-23T12:00:00Z',
        factuality: { label: 'FACT', confidence: 0.9, rationale: 'test' },
        weights: { semantic: 0.5, rerank: 0.5, recency: 0.5, importance: 0.5, trust: 0.5, final: 0.5 },
        entities: [],
        claims: [],
        metadata: {},
      });
      expect(useMemoryStore.getState().memories.length).toBe(initialCount + 1);
      expect(useMemoryStore.getState().memories[0].id).toBe('new-mem');
    });
  });

  describe('getFiltered', () => {
    it('returns all memories with no filters', () => {
      const filtered = useMemoryStore.getState().getFiltered();
      expect(filtered.length).toBeGreaterThan(0);
    });

    it('filters by query text', () => {
      useMemoryStore.getState().setQuery('Dr. Khalil');
      const filtered = useMemoryStore.getState().getFiltered();
      expect(filtered.every((m) => m.text.toLowerCase().includes('dr. khalil'))).toBe(true);
    });

    it('filters by source', () => {
      useMemoryStore.getState().setFilters({ source: 'photo' });
      const filtered = useMemoryStore.getState().getFiltered();
      expect(filtered.every((m) => m.source === 'photo')).toBe(true);
    });

    it('filters by factuality', () => {
      useMemoryStore.getState().setFilters({ factuality: 'FACT' });
      const filtered = useMemoryStore.getState().getFiltered();
      expect(filtered.every((m) => m.factuality.label === 'FACT')).toBe(true);
    });

    it('filters by importance', () => {
      useMemoryStore.getState().setFilters({ minImportance: 0.9 });
      const filtered = useMemoryStore.getState().getFiltered();
      expect(filtered.every((m) => m.weights.importance >= 0.9)).toBe(true);
    });

    it('combines multiple filters', () => {
      useMemoryStore.getState().setQuery('');
      useMemoryStore.getState().setFilters({ source: 'email', factuality: 'FACT' });
      const filtered = useMemoryStore.getState().getFiltered();
      expect(filtered.every((m) => m.source === 'email' && m.factuality.label === 'FACT')).toBe(true);
    });
  });
});

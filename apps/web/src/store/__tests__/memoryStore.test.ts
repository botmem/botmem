import { describe, it, expect, beforeEach } from 'vitest';
import { useMemoryStore } from '../memoryStore';

describe('memoryStore', () => {
  beforeEach(() => {
    useMemoryStore.setState({
      query: '',
      filters: { source: null, minImportance: 0 },
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

    it('sets importance filter', () => {
      useMemoryStore.getState().setFilters({ minImportance: 0.5 });
      expect(useMemoryStore.getState().filters.minImportance).toBe(0.5);
    });

    it('merges partial filters', () => {
      useMemoryStore.getState().setFilters({ source: 'email' });
      useMemoryStore.getState().setFilters({ minImportance: 0.5 });
      const filters = useMemoryStore.getState().filters;
      expect(filters.source).toBe('email');
      expect(filters.minImportance).toBe(0.5);
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

    it('filters by importance', () => {
      useMemoryStore.getState().setFilters({ minImportance: 0.9 });
      const filtered = useMemoryStore.getState().getFiltered();
      expect(filtered.every((m) => m.weights.importance >= 0.9)).toBe(true);
    });

    it('combines multiple filters', () => {
      useMemoryStore.getState().setQuery('');
      useMemoryStore.getState().setFilters({ source: 'email' });
      const filtered = useMemoryStore.getState().getFiltered();
      expect(filtered.every((m) => m.source === 'email')).toBe(true);
    });
  });
});

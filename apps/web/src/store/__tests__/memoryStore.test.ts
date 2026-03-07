import { describe, it, expect, beforeEach } from 'vitest';
import { useMemoryStore } from '../memoryStore';

const sampleMemories = [
  {
    id: 'mem-1',
    source: 'email' as const,
    sourceConnector: 'gmail',
    accountIdentifier: null,
    text: 'Meeting with Dr. Khalil about the project',
    time: '2025-01-15T10:00:00Z',
    ingestTime: '2025-01-15T10:00:00Z',
    factuality: { label: 'FACT' as const, confidence: 0.9, rationale: 'confirmed' },
    weights: { semantic: 0.8, rerank: 0, recency: 0.5, importance: 0.7, trust: 0.8, final: 0.7 },
    entities: [{ type: 'person', value: 'Dr. Khalil', confidence: 0.95 }],
    claims: [],
    metadata: {},
    pinned: false,
  },
  {
    id: 'mem-2',
    source: 'message' as const,
    sourceConnector: 'slack',
    accountIdentifier: null,
    text: 'Slack conversation about lunch plans',
    time: '2025-01-14T12:00:00Z',
    ingestTime: '2025-01-14T12:00:00Z',
    factuality: { label: 'UNVERIFIED' as const, confidence: 0.5, rationale: 'casual' },
    weights: { semantic: 0.5, rerank: 0, recency: 0.3, importance: 0.3, trust: 0.7, final: 0.4 },
    entities: [],
    claims: [],
    metadata: {},
    pinned: false,
  },
  {
    id: 'mem-3',
    source: 'photo' as const,
    sourceConnector: 'photos',
    accountIdentifier: null,
    text: 'Family photo at the beach',
    time: '2025-01-10T08:00:00Z',
    ingestTime: '2025-01-10T08:00:00Z',
    factuality: { label: 'UNVERIFIED' as const, confidence: 0.5, rationale: '' },
    weights: { semantic: 0.3, rerank: 0, recency: 0.2, importance: 0.95, trust: 0.9, final: 0.5 },
    entities: [],
    claims: [],
    metadata: {},
    pinned: false,
  },
];

describe('memoryStore', () => {
  beforeEach(() => {
    useMemoryStore.setState({
      memories: sampleMemories as any,
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

    it('query is set but getFiltered does not filter by text (search is server-side)', () => {
      useMemoryStore.getState().setQuery('Dr. Khalil');
      expect(useMemoryStore.getState().query).toBe('Dr. Khalil');
      // getFiltered only applies source/importance filters — text search is server-side via searchMemories
      const filtered = useMemoryStore.getState().getFiltered();
      expect(filtered.length).toBe(3); // all memories returned
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

import { create } from 'zustand';
import type { Memory, SourceType, GraphData } from '@botmem/shared';
import { api } from '../lib/api';
import { trackEvent } from '../lib/posthog';

interface Filters {
  source: SourceType | null;
  minImportance: number;
}

interface ResolvedEntities {
  contacts: { id: string; displayName: string }[];
  topicWords: string[];
  topicMatchCount: number;
}

interface MemoryState {
  memories: Memory[];
  query: string;
  filters: Filters;
  graphData: GraphData;
  loading: boolean;
  searchFallback: boolean;
  resolvedEntities: ResolvedEntities | null;
  setQuery: (q: string) => void;
  setFilters: (f: Partial<Filters>) => void;
  getFiltered: () => Memory[];
  loadMemories: () => Promise<void>;
  loadGraph: (params?: { memoryLimit?: number; linkLimit?: number }) => Promise<void>;
  searchMemories: (query: string) => Promise<void>;
  pinMemory: (id: string) => Promise<void>;
  unpinMemory: (id: string) => Promise<void>;
  recordRecall: (id: string) => void;
}

function apiMemoryToShared(raw: any): Memory {
  return {
    id: raw.id,
    source: raw.sourceType || 'message',
    sourceConnector: raw.connectorType || 'gmail',
    accountIdentifier: raw.accountIdentifier || null,
    text: raw.text || '',
    time: raw.eventTime || raw.createdAt || '',
    ingestTime: raw.ingestTime || raw.createdAt || '',
    factuality: typeof raw.factuality === 'string' ? JSON.parse(raw.factuality) : (raw.factuality || { label: 'UNVERIFIED', confidence: 0.5, rationale: '' }),
    weights: typeof raw.weights === 'string' ? JSON.parse(raw.weights) : (raw.weights || { semantic: 0, rerank: 0, recency: 0, importance: 0.5, trust: 0.5, final: raw.score || 0 }),
    entities: typeof raw.entities === 'string' ? JSON.parse(raw.entities) : (raw.entities || []),
    claims: typeof raw.claims === 'string' ? JSON.parse(raw.claims) : (raw.claims || []),
    metadata: typeof raw.metadata === 'string' ? JSON.parse(raw.metadata) : (raw.metadata || {}),
    pinned: raw.pinned === 1 || raw.pinned === true,
  };
}

let searchTimer: ReturnType<typeof setTimeout> | null = null;

export const useMemoryStore = create<MemoryState>((set, get) => ({
  memories: [],
  query: '',
  filters: { source: null, minImportance: 0 },
  graphData: { nodes: [], links: [] },
  loading: false,
  searchFallback: false,
  resolvedEntities: null,

  setQuery: (query) => {
    set({ query });
    // Debounced search
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (query.trim()) {
        get().searchMemories(query);
      } else {
        get().loadMemories();
      }
    }, 300);
  },

  setFilters: (f) =>
    set((state) => ({ filters: { ...state.filters, ...f } })),

  getFiltered: () => {
    const { memories, filters } = get();
    return memories.filter((m) => {
      if (filters.source && m.source !== filters.source) return false;
      if (m.weights.importance < filters.minImportance) return false;
      return true;
    });
  },

  loadMemories: async () => {
    set({ loading: true });
    try {
      const result = await api.listMemories({ limit: 100 });
      const mems = result.items.map(apiMemoryToShared);
      set({ memories: mems, loading: false, searchFallback: false, resolvedEntities: null });
    } catch (err) {
      console.error('Failed to load memories:', err);
      set({ loading: false, searchFallback: false, resolvedEntities: null });
    }
  },

  searchMemories: async (query: string) => {
    set({ loading: true, searchFallback: false, resolvedEntities: null });
    try {
      const result = await api.searchMemories(query);
      const mems = result.items.map(apiMemoryToShared);
      trackEvent('search', { query_length: query.length, result_count: mems.length, fallback: result.fallback });
      set({ memories: mems, loading: false, searchFallback: result.fallback, resolvedEntities: result.resolvedEntities || null });
    } catch (err) {
      console.error('Failed to search memories:', err);
      set({ loading: false });
    }
  },

  pinMemory: async (id: string) => {
    try {
      await api.pinMemory(id);
      trackEvent('memory_pin', { action: 'pin' });
      set((state) => ({
        memories: state.memories.map((m) =>
          m.id === id ? { ...m, pinned: true } : m,
        ),
      }));
    } catch (err) {
      console.error('Failed to pin memory:', err);
    }
  },

  unpinMemory: async (id: string) => {
    try {
      await api.unpinMemory(id);
      trackEvent('memory_pin', { action: 'unpin' });
      set((state) => ({
        memories: state.memories.map((m) =>
          m.id === id ? { ...m, pinned: false } : m,
        ),
      }));
    } catch (err) {
      console.error('Failed to unpin memory:', err);
    }
  },

  recordRecall: (id: string) => {
    api.recordRecall(id).catch(() => {});
  },

  loadGraph: async (params) => {
    try {
      const data = await api.getGraphData(params);
      const graphData: GraphData = {
        nodes: (data.nodes || []).map((n: any) => ({
          id: n.id,
          label: n.label || '',
          source: n.type || 'message',
          sourceConnector: n.connectorType || 'gmail',
          importance: n.importance || 0.5,
          factuality: n.factuality || 'UNVERIFIED',
          cluster: n.cluster || 0,
          nodeType: n.nodeType || 'memory',
          entities: n.entities || [],
          connectors: n.connectors || [],
          text: n.text || '',
          weights: n.weights || {},
          eventTime: n.eventTime || '',
          metadata: n.metadata || {},
        })),
        links: (data.links || data.edges || []).map((e: any) => ({
          source: e.source,
          target: e.target,
          linkType: e.type || 'related',
          strength: e.strength || 0.5,
        })),
      };
      set({ graphData });
    } catch (err) {
      console.error('Failed to load graph data:', err);
    }
  },
}));

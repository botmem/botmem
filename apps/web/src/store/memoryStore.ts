import { create } from 'zustand';
import type { Memory, SourceType, GraphData } from '@botmem/shared';
import { api } from '../lib/api';

interface Filters {
  source: SourceType | null;
  minImportance: number;
}

interface MemoryState {
  memories: Memory[];
  query: string;
  filters: Filters;
  graphData: GraphData;
  loading: boolean;
  setQuery: (q: string) => void;
  setFilters: (f: Partial<Filters>) => void;
  getFiltered: () => Memory[];
  loadMemories: () => Promise<void>;
  loadGraph: (params?: { memoryLimit?: number; linkLimit?: number }) => Promise<void>;
  searchMemories: (query: string) => Promise<void>;
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
  };
}

let searchTimer: ReturnType<typeof setTimeout> | null = null;

export const useMemoryStore = create<MemoryState>((set, get) => ({
  memories: [],
  query: '',
  filters: { source: null, minImportance: 0 },
  graphData: { nodes: [], links: [] },
  loading: false,

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
      set({ memories: mems, loading: false });
    } catch (err) {
      console.error('Failed to load memories:', err);
      set({ loading: false });
    }
  },

  searchMemories: async (query: string) => {
    set({ loading: true });
    try {
      const results = await api.searchMemories(query);
      const mems = results.map(apiMemoryToShared);
      set({ memories: mems, loading: false });
    } catch (err) {
      console.error('Failed to search memories:', err);
      set({ loading: false });
    }
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
        links: (data.edges || []).map((e: any) => ({
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

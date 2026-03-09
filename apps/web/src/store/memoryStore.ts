import { create } from 'zustand';
import type { Memory, SourceType, GraphData } from '@botmem/shared';
import { api } from '../lib/api';
import { sharedWs } from '../lib/ws';
import { useAuthStore } from './authStore';
import { useMemoryBankStore } from './memoryBankStore';
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

interface ParsedQuery {
  temporal: { from: string; to: string } | null;
  temporalFallback?: boolean;
  entities: { id: string; displayName: string }[];
  intent: 'recall' | 'browse' | 'find';
  cleanQuery: string;
}

interface MemoryStats {
  total: number;
  bySource: Record<string, number>;
  byConnector: Record<string, number>;
  needsRelogin?: boolean;
}

interface MemoryState {
  memories: Memory[];
  query: string;
  filters: Filters;
  graphData: GraphData;
  loading: boolean;
  searchFallback: boolean;
  resolvedEntities: ResolvedEntities | null;
  parsed: ParsedQuery | null;
  memoryStats: MemoryStats | null;
  setQuery: (q: string) => void;
  setFilters: (f: Partial<Filters>) => void;
  getFiltered: () => Memory[];
  loadMemories: () => Promise<void>;
  loadGraph: (params?: { memoryLimit?: number; linkLimit?: number }) => Promise<void>;
  searchMemories: (query: string) => Promise<void>;
  pinMemory: (id: string) => Promise<void>;
  unpinMemory: (id: string) => Promise<void>;
  recordRecall: (id: string) => void;
  connectWs: () => void;
  mergeGraphDelta: (delta: any) => void;
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
    factuality:
      typeof raw.factuality === 'string'
        ? JSON.parse(raw.factuality)
        : raw.factuality || { label: 'UNVERIFIED', confidence: 0.5, rationale: '' },
    weights:
      typeof raw.weights === 'string'
        ? JSON.parse(raw.weights)
        : raw.weights || {
            semantic: 0,
            rerank: 0,
            recency: 0,
            importance: 0.5,
            trust: 0.5,
            final: raw.score || 0,
          },
    entities: typeof raw.entities === 'string' ? JSON.parse(raw.entities) : raw.entities || [],
    claims: typeof raw.claims === 'string' ? JSON.parse(raw.claims) : raw.claims || [],
    metadata: typeof raw.metadata === 'string' ? JSON.parse(raw.metadata) : raw.metadata || {},
    pinned: raw.pinned === 1 || raw.pinned === true,
  };
}

let searchTimer: ReturnType<typeof setTimeout> | null = null;
let memoryWsConnected = false;

export const useMemoryStore = create<MemoryState>((set, get) => ({
  memories: [],
  query: '',
  filters: { source: null, minImportance: 0 },
  graphData: { nodes: [], links: [] },
  loading: false,
  searchFallback: false,
  resolvedEntities: null,
  parsed: null,
  memoryStats: null,

  setQuery: (query) => {
    set({ query });
    // Debounced search
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (query.trim().length >= 3) {
        get().searchMemories(query);
      } else if (!query.trim()) {
        get().loadMemories();
      }
    }, 500);
  },

  setFilters: (f) => set((state) => ({ filters: { ...state.filters, ...f } })),

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
      const bankId = useMemoryBankStore.getState().activeMemoryBankId;
      const result = await api.listMemories({ limit: 100, memoryBankId: bankId || undefined });
      const mems = result.items.map(apiMemoryToShared);
      set({
        memories: mems,
        loading: false,
        searchFallback: false,
        resolvedEntities: null,
        parsed: null,
      });
    } catch (err) {
      console.error('Failed to load memories:', err);
      set({ loading: false, searchFallback: false, resolvedEntities: null, parsed: null });
    }
  },

  searchMemories: async (query: string) => {
    set({ loading: true, searchFallback: false, resolvedEntities: null, parsed: null });
    try {
      const bankId = useMemoryBankStore.getState().activeMemoryBankId;
      const result = (await api.searchMemories(
        query,
        undefined,
        undefined,
        bankId || undefined,
      )) as any;
      const mems = result.items.map(apiMemoryToShared);
      trackEvent('search', {
        query_length: query.length,
        result_count: mems.length,
        fallback: result.fallback,
      });
      set({
        memories: mems,
        loading: false,
        searchFallback: result.fallback,
        resolvedEntities: result.resolvedEntities || null,
        parsed: result.parsed || null,
      });
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
        memories: state.memories.map((m) => (m.id === id ? { ...m, pinned: true } : m)),
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
        memories: state.memories.map((m) => (m.id === id ? { ...m, pinned: false } : m)),
      }));
    } catch (err) {
      console.error('Failed to unpin memory:', err);
    }
  },

  recordRecall: (id: string) => {
    api.recordRecall(id).catch(() => {});
  },

  loadGraph: async (params) => {
    // Adaptive limits based on search state
    const query = get().query;
    const defaults = query.trim()
      ? { memoryLimit: 200, linkLimit: 1000 }
      : { memoryLimit: 300, linkLimit: 1500 };
    const bankId = useMemoryBankStore.getState().activeMemoryBankId;
    const merged = { ...defaults, ...params, memoryBankId: bankId || undefined };
    try {
      const data = await api.getGraphData(merged);
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

  mergeGraphDelta: (delta) => {
    set((state) => {
      const existingNodeIds = new Set(state.graphData.nodes.map((n) => n.id));
      const existingLinkKeys = new Set(
        state.graphData.links.map((l) => {
          const src = typeof l.source === 'object' ? (l.source as any).id : l.source;
          const tgt = typeof l.target === 'object' ? (l.target as any).id : l.target;
          return `${src}→${tgt}→${l.linkType}`;
        }),
      );

      const newNodes = [...state.graphData.nodes];
      const newLinks = [...state.graphData.links];

      // Add memory nodes
      for (const node of delta.nodes || []) {
        if (!existingNodeIds.has(node.id)) {
          newNodes.push({
            id: node.id,
            label: node.label || '',
            source: node.type || 'message',
            sourceConnector: node.connectorType || 'gmail',
            importance: node.importance || 0.5,
            factuality: node.factuality || 'UNVERIFIED',
            cluster: node.cluster || 0,
            nodeType: node.nodeType || 'memory',
            entities: node.entities || [],
            connectors: node.connectors || [],
            text: node.text || '',
            weights: node.weights || {},
            eventTime: node.eventTime || '',
            metadata: node.metadata || {},
          });
          existingNodeIds.add(node.id);
        }
      }

      // Add contact nodes
      for (const contact of delta.contacts || []) {
        if (!existingNodeIds.has(contact.id)) {
          newNodes.push({
            id: contact.id,
            label: contact.label || '',
            source: contact.type || 'contact',
            sourceConnector: contact.connectorType || 'manual',
            importance: contact.importance || 0.8,
            factuality: contact.factuality || 'FACT',
            cluster: contact.cluster || 0,
            nodeType: contact.nodeType || 'contact',
            entities: [],
            connectors: contact.connectors || [],
            text: '',
            weights: {},
            eventTime: '',
            metadata: {},
          });
          existingNodeIds.add(contact.id);
        }
      }

      // Add memory links
      for (const link of delta.links || []) {
        const key = `${link.source}→${link.target}→${link.type || 'related'}`;
        if (
          !existingLinkKeys.has(key) &&
          existingNodeIds.has(link.source) &&
          existingNodeIds.has(link.target)
        ) {
          newLinks.push({
            source: link.source,
            target: link.target,
            linkType: link.type || 'related',
            strength: link.strength || 0.5,
          });
          existingLinkKeys.add(key);
        }
      }

      // Add contact edges
      for (const edge of delta.contactEdges || []) {
        const key = `${edge.source}→${edge.target}→${edge.type || 'involves'}`;
        if (
          !existingLinkKeys.has(key) &&
          existingNodeIds.has(edge.source) &&
          existingNodeIds.has(edge.target)
        ) {
          newLinks.push({
            source: edge.source,
            target: edge.target,
            linkType: edge.type || 'involves',
            strength: edge.strength || 0.7,
          });
          existingLinkKeys.add(key);
        }
      }

      return { graphData: { nodes: newNodes, links: newLinks } };
    });
  },

  connectWs: () => {
    if (memoryWsConnected) return;
    memoryWsConnected = true;

    const token = useAuthStore.getState().accessToken ?? undefined;
    sharedWs.subscribe('memories', token);
    sharedWs.subscribe('dashboard', token);

    sharedWs.onMessage((msg) => {
      if (msg.event === 'graph:delta') {
        get().mergeGraphDelta(msg.data);
      }
      // dashboard:stats via WS removed — stats are user-scoped, fetched via REST only
    });

    // Fetch initial stats
    const bankId = useMemoryBankStore.getState().activeMemoryBankId;
    api
      .getMemoryStats({ memoryBankId: bankId || undefined })
      .then((stats) => set({ memoryStats: stats }))
      .catch(() => {});
  },
}));

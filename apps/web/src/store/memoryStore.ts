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
  needsRecoveryKey?: boolean;
}

interface MemoryState {
  memories: Memory[];
  query: string;
  filters: Filters;
  graphData: GraphData;
  graphPreview: boolean;
  graphLoading: boolean;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  totalMemories: number;
  searchFallback: boolean;
  resolvedEntities: ResolvedEntities | null;
  parsed: ParsedQuery | null;
  memoryStats: MemoryStats | null;
  setQuery: (q: string) => void;
  setFilters: (f: Partial<Filters>) => void;
  getFiltered: () => Memory[];
  setSearchResults: (results: { items: any[]; fallback: boolean; resolvedEntities: ResolvedEntities | null; parsed: ParsedQuery | null }) => void;
  loadMemories: () => Promise<void>;
  loadMoreMemories: () => Promise<void>;
  loadGraph: (params?: { memoryLimit?: number; linkLimit?: number }) => Promise<void>;
  loadFullGraph: () => Promise<void>;
  loadGraphForIds: (memoryIds: string[]) => Promise<void>;
  searchMemories: (query: string) => Promise<void>;
  pinMemory: (id: string) => Promise<void>;
  unpinMemory: (id: string) => Promise<void>;
  recordRecall: (id: string) => void;
  connectWs: () => void;
  mergeGraphDelta: (delta: any) => void;
  mergeGraphDeltaBatch: (deltas: any[]) => void;
  reset: () => void;
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

const PAGE_SIZE = 100;

let memoryWsConnected = false;

// Graph delta buffer — collapses rapid WS deltas into batched updates
let deltaBuffer: any[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export const useMemoryStore = create<MemoryState>((set, get) => ({
  memories: [],
  query: '',
  filters: { source: null, minImportance: 0 },
  graphData: { nodes: [], links: [] },
  graphPreview: true,
  graphLoading: false,
  loading: false,
  loadingMore: false,
  hasMore: true,
  totalMemories: 0,
  searchFallback: false,
  resolvedEntities: null,
  parsed: null,
  memoryStats: null,

  setQuery: (query) => {
    set({ query });
  },

  setFilters: (f) => {
    const prev = get().filters;
    set((state) => ({ filters: { ...state.filters, ...f } }));
    // Reload from server when source filter changes (server-side filtering)
    if (f.source !== undefined && f.source !== prev.source && !get().query.trim()) {
      get().loadMemories();
    }
  },

  getFiltered: () => {
    const { memories, filters } = get();
    return memories.filter((m) => {
      // Source filtering is now server-side, but keep as safety net
      if (filters.source && m.source !== filters.source) return false;
      if (m.weights.importance < filters.minImportance) return false;
      return true;
    });
  },

  setSearchResults: ({ items, fallback, resolvedEntities, parsed }) => {
    const mems = items.map(apiMemoryToShared);
    trackEvent('search', {
      query_length: get().query.length,
      result_count: mems.length,
      fallback,
    });
    set({
      memories: mems,
      loading: false,
      searchFallback: fallback,
      resolvedEntities,
      parsed,
    });
  },

  loadMemories: async () => {
    set({ loading: true });
    try {
      const bankId = useMemoryBankStore.getState().activeMemoryBankId;
      const sourceType = get().filters.source || undefined;
      const result = await api.listMemories({ limit: PAGE_SIZE, offset: 0, sourceType, memoryBankId: bankId || undefined });
      const mems = result.items.map(apiMemoryToShared);
      set({
        memories: mems,
        loading: false,
        hasMore: mems.length < result.total,
        totalMemories: result.total,
        searchFallback: false,
        resolvedEntities: null,
        parsed: null,
      });
    } catch (err) {
      console.error('Failed to load memories:', err);
      set({ loading: false, searchFallback: false, resolvedEntities: null, parsed: null });
    }
  },

  loadMoreMemories: async () => {
    const { loadingMore, hasMore, memories, query } = get();
    if (loadingMore || !hasMore || query.trim()) return;
    set({ loadingMore: true });
    try {
      const bankId = useMemoryBankStore.getState().activeMemoryBankId;
      const sourceType = get().filters.source || undefined;
      const result = await api.listMemories({
        limit: PAGE_SIZE,
        offset: memories.length,
        sourceType,
        memoryBankId: bankId || undefined,
      });
      const newMems = result.items.map(apiMemoryToShared);
      const merged = [...memories, ...newMems];
      set({
        memories: merged,
        loadingMore: false,
        hasMore: merged.length < result.total,
        totalMemories: result.total,
      });
    } catch (err) {
      console.error('Failed to load more memories:', err);
      set({ loadingMore: false });
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
    const stats = get().memoryStats;
    const total = stats?.total || 0;
    // Preview: 20% of total memories (min 50, max 1000)
    const previewLimit = total > 0 ? Math.max(50, Math.min(1000, Math.ceil(total * 0.2))) : 200;
    const defaults = query.trim()
      ? { memoryLimit: 500, linkLimit: 2000 }
      : { memoryLimit: previewLimit, linkLimit: previewLimit * 3 };
    const bankId = useMemoryBankStore.getState().activeMemoryBankId;
    const merged = { ...defaults, ...params, memoryBankId: bankId || undefined };
    const isPreview = !query.trim();
    set({ graphLoading: true, graphPreview: isPreview });
    try {
      const data = await api.getGraphData(merged);
      let allNodes = (data.nodes || []).map((n: any) => ({
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
        avatarUrl: n.avatarUrl,
        thumbnailDataUrl: n.thumbnailDataUrl,
      }));
      let allLinks = (data.links || data.edges || []).map((e: any) => ({
        source: e.source,
        target: e.target,
        linkType: e.type || 'related',
        strength: e.strength || 0.5,
      }));

      // In preview mode, cap total nodes to ~previewLimit*1.5
      // by trimming contacts with fewest connections
      if (isPreview && allNodes.length > previewLimit * 1.5) {
        const memoryNodes = allNodes.filter((n: any) => n.nodeType !== 'contact');
        const contactNodes = allNodes.filter((n: any) => n.nodeType === 'contact');
        // Count edges per contact
        const contactEdgeCount = new Map<string, number>();
        for (const link of allLinks) {
          const s = typeof link.source === 'object' ? (link.source as any).id : link.source;
          const t = typeof link.target === 'object' ? (link.target as any).id : link.target;
          if (contactEdgeCount.has(s)) contactEdgeCount.set(s, contactEdgeCount.get(s)! + 1);
          else contactEdgeCount.set(s, 1);
          if (contactEdgeCount.has(t)) contactEdgeCount.set(t, contactEdgeCount.get(t)! + 1);
          else contactEdgeCount.set(t, 1);
        }
        // Sort contacts by edge count desc, keep top N
        const maxContacts = Math.max(20, previewLimit * 0.5);
        contactNodes.sort((a: any, b: any) => (contactEdgeCount.get(b.id) || 0) - (contactEdgeCount.get(a.id) || 0));
        const keptContacts = contactNodes.slice(0, maxContacts);
        const keptIds = new Set([...memoryNodes.map((n: any) => n.id), ...keptContacts.map((n: any) => n.id)]);
        allNodes = [...memoryNodes, ...keptContacts];
        allLinks = allLinks.filter((l: any) => {
          const s = typeof l.source === 'object' ? (l.source as any).id : l.source;
          const t = typeof l.target === 'object' ? (l.target as any).id : l.target;
          return keptIds.has(s) && keptIds.has(t);
        });
      }

      const graphData: GraphData = { nodes: allNodes, links: allLinks };
      set({ graphData, graphLoading: false });
    } catch (err) {
      console.error('Failed to load graph data:', err);
      set({ graphLoading: false });
    }
  },

  loadFullGraph: async () => {
    set({ graphLoading: true });
    const bankId = useMemoryBankStore.getState().activeMemoryBankId;
    try {
      const data = await api.getGraphData({ memoryLimit: 10000, linkLimit: 50000, memoryBankId: bankId || undefined });
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
          avatarUrl: n.avatarUrl,
        })),
        links: (data.links || data.edges || []).map((e: any) => ({
          source: e.source,
          target: e.target,
          linkType: e.type || 'related',
          strength: e.strength || 0.5,
        })),
      };
      set({ graphData, graphPreview: false, graphLoading: false });
    } catch (err) {
      console.error('Failed to load full graph:', err);
      set({ graphLoading: false });
    }
  },

  loadGraphForIds: async (memoryIds: string[]) => {
    if (!memoryIds.length) return;
    set({ graphLoading: true });
    const bankId = useMemoryBankStore.getState().activeMemoryBankId;
    try {
      const data = await api.getGraphData({ memoryIds, memoryBankId: bankId || undefined });
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
          avatarUrl: n.avatarUrl,
        })),
        links: (data.links || data.edges || []).map((e: any) => ({
          source: e.source,
          target: e.target,
          linkType: e.type || 'related',
          strength: e.strength || 0.5,
        })),
      };
      set({ graphData, graphPreview: false, graphLoading: false });
    } catch (err) {
      console.error('Failed to load graph for IDs:', err);
      set({ graphLoading: false });
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
            avatarUrl: node.avatarUrl,
            thumbnailDataUrl: node.thumbnailDataUrl,
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
            avatarUrl: contact.avatarUrl,
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

  mergeGraphDeltaBatch: (deltas) => {
    if (!deltas.length) return;
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

      for (const delta of deltas) {
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
              avatarUrl: node.avatarUrl,
            });
            existingNodeIds.add(node.id);
          }
        }
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
              avatarUrl: contact.avatarUrl,
            });
            existingNodeIds.add(contact.id);
          }
        }
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
        // Only merge deltas when showing the full graph (not preview)
        if (!get().graphPreview) {
          deltaBuffer.push(msg.data);
          if (flushTimer) clearTimeout(flushTimer);
          flushTimer = setTimeout(() => {
            const batch = deltaBuffer;
            deltaBuffer = [];
            flushTimer = null;
            get().mergeGraphDeltaBatch(batch);
          }, 2000);
        }
      }
      if (msg.event === 'dashboard:memory-stats-changed') {
        const bankId = useMemoryBankStore.getState().activeMemoryBankId;
        api.getMemoryStats({ memoryBankId: bankId || undefined })
          .then((stats) => set({ memoryStats: stats }))
          .catch(() => {});
      }
    });

    // Fetch initial stats
    const bankId = useMemoryBankStore.getState().activeMemoryBankId;
    api
      .getMemoryStats({ memoryBankId: bankId || undefined })
      .then((stats) => set({ memoryStats: stats }))
      .catch(() => {});
  },

  reset: () => {
    memoryWsConnected = false;
    set({
      memories: [],
      query: '',
      filters: { source: null, minImportance: 0 },
      graphData: { nodes: [], links: [] },
      graphPreview: true,
      graphLoading: false,
      loading: false,
      loadingMore: false,
      hasMore: true,
      totalMemories: 0,
      searchFallback: false,
      resolvedEntities: null,
      parsed: null,
      memoryStats: null,
    });
  },
}));

// Reset memory store when user logs out (avoids circular import with authStore)
useAuthStore.subscribe((state, prev) => {
  if (prev.user && !state.user) {
    useMemoryStore.getState().reset();
  }
});

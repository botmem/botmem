import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useMemoryStore } from '../memoryStore';

vi.mock('../../lib/api', () => ({
  api: {
    listMemories: vi.fn(),
    searchMemories: vi.fn(),
    pinMemory: vi.fn(),
    unpinMemory: vi.fn(),
    recordRecall: vi.fn(),
    getGraphData: vi.fn(),
    getMemoryStats: vi.fn(),
  },
}));

vi.mock('../../lib/ws', () => ({
  sharedWs: { subscribe: vi.fn(), unsubscribe: vi.fn(), onMessage: vi.fn(), offMessage: vi.fn(), connect: vi.fn() },
}));

vi.mock('../authStore', () => ({
  useAuthStore: Object.assign(
    (sel: any) => sel({ accessToken: 'tok', user: { id: 'u1' } }),
    {
      getState: () => ({ accessToken: 'tok', user: { id: 'u1' }, refreshSession: vi.fn() }),
      setState: vi.fn(),
      subscribe: vi.fn(),
    },
  ),
}));

vi.mock('../memoryBankStore', () => ({
  useMemoryBankStore: Object.assign(
    (sel: any) => sel({ activeMemoryBankId: null }),
    { getState: () => ({ activeMemoryBankId: null }), setState: vi.fn(), subscribe: vi.fn() },
  ),
}));

vi.mock('../../lib/posthog', () => ({ trackEvent: vi.fn() }));

import { api } from '../../lib/api';

describe('memoryStore extended', () => {
  beforeEach(() => {
    useMemoryStore.getState().reset();
    vi.clearAllMocks();
  });

  describe('loadMemories', () => {
    it('fetches and maps memories', async () => {
      (api.listMemories as any).mockResolvedValue({
        items: [{ id: 'm1', sourceType: 'email', connectorType: 'gmail', text: 'Hello', eventTime: '2026-01-01', pinned: false }],
        total: 1,
      });
      await useMemoryStore.getState().loadMemories();
      const s = useMemoryStore.getState();
      expect(s.memories).toHaveLength(1);
      expect(s.memories[0].source).toBe('email');
      expect(s.hasMore).toBe(false);
      expect(s.loading).toBe(false);
    });

    it('handles error', async () => {
      (api.listMemories as any).mockRejectedValue(new Error('fail'));
      await useMemoryStore.getState().loadMemories();
      expect(useMemoryStore.getState().loading).toBe(false);
    });

    it('sets hasMore when more available', async () => {
      (api.listMemories as any).mockResolvedValue({
        items: Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`, text: `t${i}` })),
        total: 500,
      });
      await useMemoryStore.getState().loadMemories();
      expect(useMemoryStore.getState().hasMore).toBe(true);
    });
  });

  describe('loadMoreMemories', () => {
    it('appends memories', async () => {
      useMemoryStore.setState({
        memories: [{ id: 'm0', source: 'email', sourceConnector: 'gmail', accountIdentifier: null, text: '', time: '', ingestTime: '', factuality: { label: 'UNVERIFIED', confidence: 0.5, rationale: '' }, weights: { semantic: 0, rerank: 0, recency: 0, importance: 0.5, trust: 0.5, final: 0 }, entities: [], claims: [], metadata: {}, pinned: false }] as any,
        hasMore: true,
        loadingMore: false,
        query: '',
      });
      (api.listMemories as any).mockResolvedValue({
        items: [{ id: 'm1', text: 'new' }],
        total: 2,
      });
      await useMemoryStore.getState().loadMoreMemories();
      expect(useMemoryStore.getState().memories).toHaveLength(2);
    });

    it('skips if already loading', async () => {
      useMemoryStore.setState({ loadingMore: true, hasMore: true, query: '' });
      await useMemoryStore.getState().loadMoreMemories();
      expect(api.listMemories).not.toHaveBeenCalled();
    });

    it('skips if query active', async () => {
      useMemoryStore.setState({ hasMore: true, query: 'search term' });
      await useMemoryStore.getState().loadMoreMemories();
      expect(api.listMemories).not.toHaveBeenCalled();
    });

    it('handles error', async () => {
      useMemoryStore.setState({ hasMore: true, loadingMore: false, query: '', memories: [] });
      (api.listMemories as any).mockRejectedValue(new Error('fail'));
      await useMemoryStore.getState().loadMoreMemories();
      expect(useMemoryStore.getState().loadingMore).toBe(false);
    });
  });

  describe('searchMemories', () => {
    it('searches and sets results', async () => {
      (api.searchMemories as any).mockResolvedValue({
        items: [{ id: 'm1', text: 'result' }],
        fallback: false,
        resolvedEntities: { contacts: [], topicWords: ['test'], topicMatchCount: 1 },
        parsed: { intent: 'recall' },
      });
      await useMemoryStore.getState().searchMemories('test');
      const s = useMemoryStore.getState();
      expect(s.memories).toHaveLength(1);
      expect(s.searchFallback).toBe(false);
      expect(s.resolvedEntities).not.toBeNull();
      expect(s.parsed).not.toBeNull();
    });

    it('handles search error', async () => {
      (api.searchMemories as any).mockRejectedValue(new Error('fail'));
      await useMemoryStore.getState().searchMemories('test');
      expect(useMemoryStore.getState().loading).toBe(false);
    });
  });

  describe('pinMemory / unpinMemory', () => {
    it('pins a memory', async () => {
      useMemoryStore.setState({
        memories: [{ id: 'm1', pinned: false, source: 'email', sourceConnector: 'gmail', accountIdentifier: null, text: '', time: '', ingestTime: '', factuality: { label: 'UNVERIFIED', confidence: 0.5, rationale: '' }, weights: { semantic: 0, rerank: 0, recency: 0, importance: 0.5, trust: 0.5, final: 0 }, entities: [], claims: [], metadata: {} }] as any,
      });
      (api.pinMemory as any).mockResolvedValue({ ok: true });
      await useMemoryStore.getState().pinMemory('m1');
      expect(useMemoryStore.getState().memories[0].pinned).toBe(true);
    });

    it('unpins a memory', async () => {
      useMemoryStore.setState({
        memories: [{ id: 'm1', pinned: true, source: 'email', sourceConnector: 'gmail', accountIdentifier: null, text: '', time: '', ingestTime: '', factuality: { label: 'UNVERIFIED', confidence: 0.5, rationale: '' }, weights: { semantic: 0, rerank: 0, recency: 0, importance: 0.5, trust: 0.5, final: 0 }, entities: [], claims: [], metadata: {} }] as any,
      });
      (api.unpinMemory as any).mockResolvedValue({ ok: true });
      await useMemoryStore.getState().unpinMemory('m1');
      expect(useMemoryStore.getState().memories[0].pinned).toBe(false);
    });
  });

  describe('mergeGraphDelta', () => {
    it('adds new nodes and links', () => {
      useMemoryStore.setState({ graphData: { nodes: [{ id: 'n1', label: 'A', source: 'email', sourceConnector: 'gmail', importance: 0.5, factuality: 'UNVERIFIED', cluster: 0, nodeType: 'memory', entities: [], connectors: [], text: '', weights: {}, eventTime: '', metadata: {} }], links: [] } });
      useMemoryStore.getState().mergeGraphDelta({
        nodes: [{ id: 'n2', label: 'B' }],
        contacts: [{ id: 'c1', label: 'Person' }],
        links: [{ source: 'n1', target: 'n2', type: 'related' }],
        contactEdges: [{ source: 'n1', target: 'c1', type: 'involves' }],
      });
      const g = useMemoryStore.getState().graphData;
      expect(g.nodes).toHaveLength(3);
      expect(g.links).toHaveLength(2);
    });

    it('deduplicates nodes', () => {
      useMemoryStore.setState({ graphData: { nodes: [{ id: 'n1', label: 'A', source: 'email', sourceConnector: 'gmail', importance: 0.5, factuality: 'UNVERIFIED', cluster: 0, nodeType: 'memory', entities: [], connectors: [], text: '', weights: {}, eventTime: '', metadata: {} }], links: [] } });
      useMemoryStore.getState().mergeGraphDelta({ nodes: [{ id: 'n1', label: 'A-dup' }], links: [] });
      expect(useMemoryStore.getState().graphData.nodes).toHaveLength(1);
    });
  });

  describe('mergeGraphDeltaBatch', () => {
    it('handles empty batch', () => {
      useMemoryStore.setState({ graphData: { nodes: [], links: [] } });
      useMemoryStore.getState().mergeGraphDeltaBatch([]);
      expect(useMemoryStore.getState().graphData.nodes).toHaveLength(0);
    });

    it('merges multiple deltas', () => {
      useMemoryStore.setState({ graphData: { nodes: [], links: [] } });
      useMemoryStore.getState().mergeGraphDeltaBatch([
        { nodes: [{ id: 'n1', label: 'A' }], links: [], contacts: [], contactEdges: [] },
        { nodes: [{ id: 'n2', label: 'B' }], links: [{ source: 'n1', target: 'n2', type: 'related' }], contacts: [], contactEdges: [] },
      ]);
      const g = useMemoryStore.getState().graphData;
      expect(g.nodes).toHaveLength(2);
      expect(g.links).toHaveLength(1);
    });
  });

  describe('reset', () => {
    it('resets all state', () => {
      useMemoryStore.setState({ memories: [{ id: 'x' }] as any, query: 'test', loading: true });
      useMemoryStore.getState().reset();
      const s = useMemoryStore.getState();
      expect(s.memories).toHaveLength(0);
      expect(s.query).toBe('');
      expect(s.loading).toBe(false);
    });
  });

  describe('setSearchResults', () => {
    it('maps items and sets fallback state', () => {
      useMemoryStore.setState({ query: 'test' });
      useMemoryStore.getState().setSearchResults({
        items: [{ id: 'm1', sourceType: 'message', text: 'hi', pinned: 0 }],
        fallback: true,
        resolvedEntities: { contacts: [], topicWords: ['hi'], topicMatchCount: 1 },
        parsed: null,
      });
      const s = useMemoryStore.getState();
      expect(s.memories).toHaveLength(1);
      expect(s.searchFallback).toBe(true);
    });
  });

  describe('loadGraph', () => {
    it('loads graph data', async () => {
      (api.getGraphData as any).mockResolvedValue({
        nodes: [{ id: 'n1', label: 'A', type: 'email' }],
        links: [{ source: 'n1', target: 'n1', type: 'related', strength: 0.5 }],
      });
      await useMemoryStore.getState().loadGraph();
      const g = useMemoryStore.getState().graphData;
      expect(g.nodes).toHaveLength(1);
      expect(useMemoryStore.getState().graphLoading).toBe(false);
    });

    it('handles error', async () => {
      (api.getGraphData as any).mockRejectedValue(new Error('fail'));
      await useMemoryStore.getState().loadGraph();
      expect(useMemoryStore.getState().graphLoading).toBe(false);
    });
  });

  describe('loadGraphForIds', () => {
    it('does nothing for empty ids', async () => {
      await useMemoryStore.getState().loadGraphForIds([]);
      expect(api.getGraphData).not.toHaveBeenCalled();
    });
  });
});

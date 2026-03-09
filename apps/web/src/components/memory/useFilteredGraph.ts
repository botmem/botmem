import { useMemo, useEffect, useRef, useCallback } from 'react';
import type { GraphData } from '@botmem/shared';
import type { FilterState, SearchState, SearchAction } from './graphReducers';
import { api } from '../../lib/api';

interface AdaptiveConfig {
  cooldownTicks: number;
  performanceMode: boolean;
  hideDecorativeLinks: boolean;
  autoMinConnections: number | null;
  disableLinkDash: boolean;
}

interface UseFilteredGraphArgs {
  data: GraphData;
  filters: FilterState;
  search: SearchState;
  dispatchSearch: React.Dispatch<SearchAction>;
  connectionCounts: Map<string, number>;
  selfNodeId: string | null;
  focusedNodeId: string | null;
  focusExpansion: number;
  onReload?: () => void;
  graphRef: React.RefObject<any>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  dimensions: { width: number; height: number };
  adaptiveConfig?: AdaptiveConfig;
}

export function useFilteredGraph({
  data, filters, search, dispatchSearch, connectionCounts, selfNodeId,
  focusedNodeId, focusExpansion, onReload,
  graphRef, containerRef, dimensions, adaptiveConfig,
}: UseFilteredGraphArgs) {
  const nodePositionsRef = useRef<Map<string, { x: number; y: number; vx: number; vy: number }>>(new Map());
  const isInitialRender = useRef(true);
  const prevFilteredRef = useRef<{ nodes: any[]; links: any[] } | null>(null);
  const prevDataRef = useRef(data);
  const prevNodeIdsRef = useRef<Set<string>>(new Set());
  const isDataRefresh = useRef(false);
  const isIncremental = useRef(false);

  const searchMatchIds = useMemo(() => {
    if (search.pending && !search.results) return new Set<string>();
    if (!search.results) return null;
    const matched = new Set<string>();
    for (const id of search.results.memoryIds) matched.add(id);
    for (const id of search.results.contactNodeIds) matched.add(id);
    return matched;
  }, [search.results, search.pending]);

  const contactFilterIds = useMemo(() => {
    if (!search.results || !search.results.contactNodeIds.length) return null;
    const visible = new Set<string>();
    if (selfNodeId) visible.add(selfNodeId);
    for (const contactId of search.results.contactNodeIds) {
      visible.add(contactId);
      for (const link of data.links) {
        const src = typeof link.source === 'object' ? (link.source as any).id : link.source;
        const tgt = typeof link.target === 'object' ? (link.target as any).id : link.target;
        if (src === contactId) visible.add(tgt);
        if (tgt === contactId) visible.add(src);
      }
    }
    return visible;
  }, [search.results, selfNodeId, data.links]);

  const highlightedIds = useMemo(() => {
    if (!searchMatchIds) return null;
    if (contactFilterIds) return contactFilterIds;
    const expanded = new Set(searchMatchIds);
    for (const link of data.links) {
      const src = typeof link.source === 'object' ? (link.source as any).id : link.source;
      const tgt = typeof link.target === 'object' ? (link.target as any).id : link.target;
      if (searchMatchIds.has(src)) expanded.add(tgt);
      if (searchMatchIds.has(tgt)) expanded.add(src);
    }
    return expanded;
  }, [searchMatchIds, data.links, contactFilterIds]);

  const filteredData = useMemo(() => {
    const searchVisible = contactFilterIds ?? highlightedIds;
    // Dynamic minConnections: when search is active, show all matched nodes (0)
    // Otherwise, scale based on total node count to reduce clutter
    const searchActive = !!(contactFilterIds ?? highlightedIds);
    const nodeCount = data.nodes.length;
    const dynamicMin = searchActive ? 0 : (nodeCount > 800 ? 3 : nodeCount > 500 ? 2 : nodeCount > 200 ? 1 : 0);
    const effectiveMinConn = dynamicMin;
    const keepNodes = new Set<string>();
    for (const node of data.nodes) {
      if (searchVisible && !searchVisible.has(node.id)) continue;
      if (node.nodeType === 'contact' && filters.hideContacts) continue;
      if (node.nodeType === 'group' && filters.hideGroups) continue;
      if (node.nodeType === 'file' && filters.hideFiles) continue;
      if (node.nodeType === 'device' && filters.hideDevices) continue;
      if (node.nodeType === 'connector') {
        if (!searchVisible) keepNodes.add(node.id);
        continue;
      }
      if (node.nodeType === 'memory' && filters.hiddenSourceTypes.has(node.source)) continue;
      const isSearchMatch = searchVisible && searchVisible.has(node.id);
      if (!isSearchMatch) {
        const count = connectionCounts.get(node.id) || 0;
        if (count < effectiveMinConn) continue;
      }
      keepNodes.add(node.id);
    }

    if (graphRef.current) {
      const currentNodes = graphRef.current.graphData?.()?.nodes;
      if (currentNodes) {
        for (const n of currentNodes) {
          if (n.id && n.x !== undefined) {
            nodePositionsRef.current.set(n.id, { x: n.x, y: n.y, vx: n.vx || 0, vy: n.vy || 0 });
          }
        }
      }
    }

    const links = data.links.filter((l) => {
      const src = typeof l.source === 'object' ? (l.source as any).id : l.source;
      const tgt = typeof l.target === 'object' ? (l.target as any).id : l.target;
      if (!keepNodes.has(src) || !keepNodes.has(tgt)) return false;
      const type = l.linkType || 'related';
      if (filters.hiddenEdgeTypes.has(type)) return false;
      // Hide decorative link types in performance mode
      if (adaptiveConfig?.hideDecorativeLinks && (type === 'involves' || type === 'source')) return false;
      return true;
    });

    const linkedNodes = new Set<string>();
    for (const l of links) {
      const linkType = l.linkType || 'related';
      if (linkType === 'source') continue;
      const src = typeof l.source === 'object' ? (l.source as any).id : l.source;
      const tgt = typeof l.target === 'object' ? (l.target as any).id : l.target;
      linkedNodes.add(src);
      linkedNodes.add(tgt);
    }
    for (const node of data.nodes) {
      if (keepNodes.has(node.id) && node.nodeType !== 'memory') linkedNodes.add(node.id);
    }

    const neighborPos = new Map<string, { x: number; y: number }>();
    for (const l of links) {
      const src = typeof l.source === 'object' ? (l.source as any).id : l.source;
      const tgt = typeof l.target === 'object' ? (l.target as any).id : l.target;
      const srcPos = nodePositionsRef.current.get(src);
      const tgtPos = nodePositionsRef.current.get(tgt);
      if (srcPos && !neighborPos.has(tgt)) neighborPos.set(tgt, srcPos);
      if (tgtPos && !neighborPos.has(src)) neighborPos.set(src, tgtPos);
    }

    const nodes = data.nodes
      .filter((n) => keepNodes.has(n.id) && linkedNodes.has(n.id))
      .map((n) => {
        // Pin self node to center on initial render
        if (n.id === selfNodeId && isInitialRender.current) {
          return { ...n, x: 0, y: 0, fx: 0, fy: 0 };
        }
        const pos = nodePositionsRef.current.get(n.id);
        if (pos) {
          if (isDataRefresh.current && !isIncremental.current) {
            // Full refresh: pin nodes to prevent layout reset
            return { ...n, x: pos.x, y: pos.y, fx: pos.x, fy: pos.y, vx: 0, vy: 0 };
          }
          // Incremental or filter change: let simulation absorb gently
          return { ...n, x: pos.x, y: pos.y, vx: pos.vx, vy: pos.vy };
        }
        const nb = neighborPos.get(n.id);
        if (nb) {
          const jitter = () => (Math.random() - 0.5) * 30;
          return { ...n, x: nb.x + jitter(), y: nb.y + jitter() };
        }
        return { ...n };
      });

    if (search.results?.scoreMap) {
      const sm = search.results.scoreMap;
      nodes.sort((a, b) => (sm.get(a.id) ?? -1) - (sm.get(b.id) ?? -1));
    }

    return { nodes, links };
  }, [data, connectionCounts, filters, contactFilterIds, highlightedIds, search.results, adaptiveConfig]);

  // Track data vs filter changes — detect incremental vs full refresh
  useEffect(() => {
    if (data !== prevDataRef.current) {
      isDataRefresh.current = true;
      const currentIds = new Set(data.nodes.map((n) => n.id));
      const prevIds = prevNodeIdsRef.current;
      // Incremental: previous nodes are a subset of current nodes (additions only)
      let allPrevExist = prevIds.size > 0;
      if (allPrevExist) {
        for (const id of prevIds) {
          if (!currentIds.has(id)) { allPrevExist = false; break; }
        }
      }
      isIncremental.current = allPrevExist && currentIds.size > prevIds.size;
      prevNodeIdsRef.current = currentIds;
      prevDataRef.current = data;
    } else {
      isDataRefresh.current = false;
      isIncremental.current = false;
    }
  });

  // Restore camera on data refreshes
  useEffect(() => {
    if (isInitialRender.current) {
      prevFilteredRef.current = filteredData;
      return;
    }
    if (!graphRef.current) {
      prevFilteredRef.current = filteredData;
      return;
    }
    if (isDataRefresh.current) {
      const fg = graphRef.current;
      const canvas = containerRef.current?.querySelector('canvas');
      const d3Zoom = canvas && (canvas as any).__zoom;
      const savedK = d3Zoom?.k;
      const savedX = d3Zoom?.x;
      const savedY = d3Zoom?.y;
      requestAnimationFrame(() => {
        if (!fg || savedK === undefined) return;
        fg.zoom(savedK, 0);
        const cx = (dimensions.width / 2 - savedX) / savedK;
        const cy = (dimensions.height / 2 - savedY) / savedK;
        fg.centerAt(cx, cy, 0);
      });
    }
    prevFilteredRef.current = filteredData;
  }, [filteredData, dimensions]);

  // Debounced search effect
  useEffect(() => {
    const trimmed = search.term.trim();
    if (!trimmed) {
      dispatchSearch({ type: 'clearSearch' });
      return;
    }
    if (trimmed.length < 3) return;
    const timer = setTimeout(async () => {
      dispatchSearch({ type: 'startSearch' });
      try {
        const res = await api.searchMemories(trimmed, undefined, 100);
        const memoryIds = new Set(res.items.map((item: any) => item.id));
        const contactNodeIds = (res.resolvedEntities?.contacts || []).map(
          (c: { id: string }) => `contact-${c.id}`,
        );
        const scoreMap = new Map<string, number>();
        const total = res.items.length;
        res.items.forEach((item: any, idx: number) => {
          scoreMap.set(item.id, total > 1 ? 1 - idx / (total - 1) : 1);
        });
        for (const id of contactNodeIds) scoreMap.set(id, 1);
        if (onReload) await onReload();
        dispatchSearch({ type: 'searchComplete', results: { memoryIds, contactNodeIds, scoreMap, resolvedEntities: res.resolvedEntities ?? undefined } });
      } catch {
        dispatchSearch({ type: 'searchComplete', results: null });
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [search.term]);

  // Focus mode: show only focused node's connections
  const focusVisibleIds = useMemo(() => {
    if (!focusedNodeId) return null;
    const visible = new Set<string>([focusedNodeId]);
    const connectedLinks = filteredData.links
      .map((link) => {
        const src = typeof link.source === 'object' ? (link.source as any).id : link.source;
        const tgt = typeof link.target === 'object' ? (link.target as any).id : link.target;
        if (src !== focusedNodeId && tgt !== focusedNodeId) return null;
        const neighbor = src === focusedNodeId ? tgt : src;
        return { neighbor, strength: link.strength ?? 0.5 };
      })
      .filter(Boolean) as Array<{ neighbor: string; strength: number }>;
    connectedLinks.sort((a, b) => b.strength - a.strength);
    const showCount = focusExpansion * 5;
    for (let i = 0; i < Math.min(showCount, connectedLinks.length); i++) {
      visible.add(connectedLinks[i].neighbor);
    }
    return visible;
  }, [focusedNodeId, focusExpansion, filteredData.links]);

  // Adjacency list for keyboard navigation
  const adjacency = useMemo(() => {
    const adj = new Map<string, string[]>();
    for (const link of filteredData.links) {
      const src = typeof link.source === 'object' ? (link.source as any).id : link.source;
      const tgt = typeof link.target === 'object' ? (link.target as any).id : link.target;
      if (!adj.has(src)) adj.set(src, []);
      if (!adj.has(tgt)) adj.set(tgt, []);
      adj.get(src)!.push(tgt);
      adj.get(tgt)!.push(src);
    }
    return adj;
  }, [filteredData.links]);

  // Zoom to fit when search results change
  useEffect(() => {
    if (!graphRef.current || !searchMatchIds || searchMatchIds.size === 0) return;
    const timer = setTimeout(() => {
      if (graphRef.current) graphRef.current.zoomToFit(400, 80);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchMatchIds]);

  const linkColor = useCallback((link: any) => {
    const DIM_OPACITY = 0.15;
    const src = typeof link.source === 'object' ? link.source.id : link.source;
    const tgt = typeof link.target === 'object' ? link.target.id : link.target;
    if (searchMatchIds) {
      const srcH = highlightedIds?.has(src);
      const tgtH = highlightedIds?.has(tgt);
      if (!srcH || !tgtH) return `rgba(102, 102, 102, ${DIM_OPACITY})`;
    }
    if (focusVisibleIds) {
      if (!focusVisibleIds.has(src) || !focusVisibleIds.has(tgt)) return `rgba(102, 102, 102, ${DIM_OPACITY})`;
    }
    if (link.linkType === 'contradicts') return '#EF4444';
    if (link.linkType === 'supports') return '#22C55E';
    if (link.linkType === 'involves') return 'rgba(96, 165, 250, 0.4)';
    if (link.linkType === 'attachment') return 'rgba(251, 146, 60, 0.4)';
    if (link.linkType === 'source') return 'rgba(163, 230, 53, 0.15)';
    return '#666';
  }, [searchMatchIds, highlightedIds, focusVisibleIds]);

  const linkWidth = useCallback((link: any) => {
    if (link.linkType === 'involves') return adaptiveConfig?.performanceMode ? 0.5 : 1;
    if (link.linkType === 'source') return 0.5;
    return 2;
  }, [adaptiveConfig?.performanceMode]);

  return {
    filteredData, isInitialRender,
    searchMatchIds, highlightedIds, focusVisibleIds,
    adjacency, linkColor, linkWidth,
  };
}

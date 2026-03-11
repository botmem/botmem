import { useMemo, useEffect, useRef, useCallback } from 'react';
import type { GraphData, GraphNode, GraphEdge } from '@botmem/shared';
import type { FilterState, SearchState } from './graphReducers';
import type { ForceGraphInstance } from './graphTypes';

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
  connectionCounts: Map<string, number>;
  selfNodeId: string | null;
  focusedNodeId: string | null;
  focusExpansion: number;
  onReloadPreview?: () => void;
  graphRef: React.RefObject<ForceGraphInstance | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  dimensions: { width: number; height: number };
  adaptiveConfig?: AdaptiveConfig;
}

function linkNodeId(node: string | { id: string }): string {
  return typeof node === 'object' ? node.id : node;
}

export function useFilteredGraph({
  data,
  filters,
  search,
  connectionCounts,
  selfNodeId,
  focusedNodeId,
  focusExpansion,
  onReloadPreview: _onReloadPreview,
  graphRef,
  containerRef: _containerRef,
  dimensions: _dimensions,
  adaptiveConfig,
}: UseFilteredGraphArgs) {
  const isInitialRender = useRef(true);

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
        const src = linkNodeId(link.source);
        const tgt = linkNodeId(link.target);
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
      const src = linkNodeId(link.source);
      const tgt = linkNodeId(link.target);
      if (searchMatchIds.has(src)) expanded.add(tgt);
      if (searchMatchIds.has(tgt)) expanded.add(src);
    }
    return expanded;
  }, [searchMatchIds, data.links, contactFilterIds]);

  const filteredData = useMemo(() => {
    const searchVisible = contactFilterIds ?? highlightedIds;
    const searchActive = !!(contactFilterIds ?? highlightedIds);
    const nodeCount = data.nodes.length;
    const dynamicMin = searchActive
      ? 0
      : nodeCount > 800
        ? 3
        : nodeCount > 500
          ? 2
          : nodeCount > 200
            ? 1
            : 0;
    const effectiveMinConn = dynamicMin;
    const keepNodes = new Set<string>();
    for (const node of data.nodes) {
      if (node.nodeType === 'contact' && filters.hideContacts) continue;
      if (node.nodeType === 'group' && filters.hideGroups) continue;
      if (node.nodeType === 'file' && filters.hideFiles) continue;
      if (node.nodeType === 'memory' && node.source === 'file' && filters.hideFiles) continue;
      if (node.nodeType === 'memory' && node.source === 'photo' && filters.hidePhotos) continue;
      if (node.nodeType === 'device' && filters.hideDevices) continue;
      if (node.nodeType === 'connector') {
        if (!searchVisible) keepNodes.add(node.id);
        continue;
      }
      if (node.nodeType === 'memory' && filters.hiddenSourceTypes.has(node.source)) continue;
      // When search is active, only show matching nodes + their neighbors
      if (searchVisible) {
        if (!searchVisible.has(node.id)) continue;
      } else {
        const count = connectionCounts.get(node.id) || 0;
        // Hide unconnected nodes — all node types must have at least 1 edge
        if (count === 0) continue;
        // Memory nodes must meet the dynamic minimum for large graphs
        if (node.nodeType === 'memory' && count < effectiveMinConn) continue;
      }
      keepNodes.add(node.id);
    }

    const links = data.links.filter((l) => {
      const src = linkNodeId(l.source);
      const tgt = linkNodeId(l.target);
      if (!keepNodes.has(src) || !keepNodes.has(tgt)) return false;
      const type = l.linkType || 'related';
      if (filters.hiddenEdgeTypes.has(type)) return false;
      if (adaptiveConfig?.hideDecorativeLinks && (type === 'involves' || type === 'source'))
        return false;
      return true;
    });

    // Build connection counts from filtered links only (not all links)
    const filteredConnCounts = new Map<string, number>();
    for (const l of links) {
      const linkType = l.linkType || 'related';
      if (linkType === 'source') continue;
      const src = linkNodeId(l.source);
      const tgt = linkNodeId(l.target);
      filteredConnCounts.set(src, (filteredConnCounts.get(src) || 0) + 1);
      filteredConnCounts.set(tgt, (filteredConnCounts.get(tgt) || 0) + 1);
    }

    // Only include nodes that have at least one visible (filtered) edge
    const linkedNodes = new Set<string>();
    for (const l of links) {
      const src = linkNodeId(l.source);
      const tgt = linkNodeId(l.target);
      linkedNodes.add(src);
      linkedNodes.add(tgt);
    }
    // Always show self node
    if (selfNodeId && keepNodes.has(selfNodeId)) linkedNodes.add(selfNodeId);

    // Preserve node identity: reuse existing simulation node objects to keep x/y/vx/vy
    const simNodeMap = new Map<string, GraphNode & { x?: number; y?: number }>();
    if (graphRef.current) {
      const currentNodes = graphRef.current.graphData?.()?.nodes;
      if (currentNodes) {
        for (const n of currentNodes) {
          if (n.id) simNodeMap.set(n.id, n as GraphNode & { x?: number; y?: number });
        }
      }
    }

    const nodes = data.nodes
      .filter((n) => keepNodes.has(n.id) && linkedNodes.has(n.id))
      .map((n) => {
        // Pin self node to center on initial render
        if (n.id === selfNodeId && isInitialRender.current) {
          return { ...n, x: 0, y: 0, fx: 0, fy: 0 };
        }
        // Reuse existing simulation node to preserve position
        const existing = simNodeMap.get(n.id);
        if (existing) {
          // Update data fields on the existing object, preserve physics state
          existing.label = n.label;
          existing.source = n.source;
          existing.sourceConnector = n.sourceConnector;
          existing.importance = n.importance;
          existing.factuality = n.factuality;
          existing.nodeType = n.nodeType;
          existing.entities = n.entities;
          existing.connectors = n.connectors;
          existing.text = n.text;
          existing.weights = n.weights;
          existing.eventTime = n.eventTime;
          existing.metadata = n.metadata;
          return existing;
        }
        // New node: place near a neighbor if possible
        for (const l of links) {
          const src = linkNodeId(l.source);
          const tgt = linkNodeId(l.target);
          const neighborId = src === n.id ? tgt : tgt === n.id ? src : null;
          if (neighborId) {
            const nb = simNodeMap.get(neighborId);
            if (nb && nb.x !== undefined) {
              const jitter = () => (Math.random() - 0.5) * 30;
              return { ...n, x: nb.x + jitter(), y: (nb.y || 0) + jitter() };
            }
          }
        }
        return { ...n };
      });

    if (search.results?.scoreMap) {
      const sm = search.results.scoreMap;
      nodes.sort((a, b) => (sm.get(a.id) ?? -1) - (sm.get(b.id) ?? -1));
    }

    return { nodes, links };
  }, [
    data,
    connectionCounts,
    filters,
    contactFilterIds,
    highlightedIds,
    search.results,
    adaptiveConfig,
  ]);

  // No data-tracking or camera-restore effects needed — node identity preservation
  // keeps positions stable across updates.

  // Focus mode: show only focused node's connections
  const focusVisibleIds = useMemo(() => {
    if (!focusedNodeId) return null;
    const visible = new Set<string>([focusedNodeId]);
    const connectedLinks = filteredData.links
      .map((link) => {
        const src = linkNodeId(link.source);
        const tgt = linkNodeId(link.target);
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
      const src = linkNodeId(link.source);
      const tgt = linkNodeId(link.target);
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

  const linkColor = useCallback(
    (link: GraphEdge) => {
      const DIM_OPACITY = 0.15;
      const src = linkNodeId(link.source);
      const tgt = linkNodeId(link.target);
      if (searchMatchIds) {
        const srcH = highlightedIds?.has(src);
        const tgtH = highlightedIds?.has(tgt);
        if (!srcH || !tgtH) return `rgba(102, 102, 102, ${DIM_OPACITY})`;
      }
      if (focusVisibleIds) {
        if (!focusVisibleIds.has(src) || !focusVisibleIds.has(tgt))
          return `rgba(102, 102, 102, ${DIM_OPACITY})`;
      }
      if (link.linkType === 'contradicts') return '#EF4444';
      if (link.linkType === 'supports') return '#22C55E';
      if (link.linkType === 'involves') return 'rgba(96, 165, 250, 0.4)';
      if (link.linkType === 'attachment') return 'rgba(251, 146, 60, 0.4)';
      if (link.linkType === 'source') return 'rgba(163, 230, 53, 0.15)';
      return '#666';
    },
    [searchMatchIds, highlightedIds, focusVisibleIds],
  );

  const linkWidth = useCallback(
    (link: GraphEdge) => {
      if (link.linkType === 'involves') return adaptiveConfig?.performanceMode ? 0.5 : 1;
      if (link.linkType === 'source') return 0.5;
      return 2;
    },
    [adaptiveConfig?.performanceMode],
  );

  return {
    filteredData,
    isInitialRender,
    searchMatchIds,
    highlightedIds,
    focusVisibleIds,
    adjacency,
    linkColor,
    linkWidth,
  };
}

import { useRef, useCallback, useState, useMemo, useReducer, useEffect } from 'react';
import { cn } from '@/lib/utils';
import type { GraphData, GraphNode, GraphEdge } from '@botmem/shared';
import { SearchResultsBanner } from './SearchResultsBanner';
import { NodeDetailPanel } from './NodeDetailPanel';
import { GraphLegend } from './GraphLegend';

import { filterReducer, uiReducer } from './graphReducers';
import { renderNode, renderNodePointerArea, refreshThemeCache } from './graphDrawing';
import type { NodeRenderCtx } from './graphDrawing';
import { useGraphKeyboard } from './useGraphKeyboard';
import { useFilteredGraph } from './useFilteredGraph';
import { useGraphEffects } from './useGraphEffects';
import type { ForceGraphInstance, SimulationNode } from './graphTypes';
import { api } from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import { trackEvent } from '../../lib/posthog';
import type { UseSearchReturn } from '../../hooks/useSearch';

type ForceGraphComponent = React.ComponentType<Record<string, unknown>>;

interface MemoryGraphProps {
  data: GraphData;
  onReloadPreview?: () => void;
  graphPreview?: boolean;
  graphLoading?: boolean;
  onLoadAll?: () => void;
  search: UseSearchReturn;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
}

export function MemoryGraph({
  data,
  onReloadPreview,
  graphPreview,
  graphLoading,
  onLoadAll,
  search,
  searchInputRef: externalSearchInputRef,
}: MemoryGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphInstance | null>(null);
  const fallbackSearchInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = externalSearchInputRef || fallbackSearchInputRef;

  const [ForceGraph, setForceGraph] = useState<ForceGraphComponent | null>(null);
  const [dimensions, setDimensions] = useState({ width: 900, height: 500 });
  const [bgColor, setBgColor] = useState('#1A1A1A');
  const [selfNodeId, setSelfNodeId] = useState<string | null>(null);

  const [filters, dispatchFilter] = useReducer(filterReducer, {
    hiddenSourceTypes: new Set<string>(),
    hideContacts: false,
    hideGroups: false,
    hideFiles: false,
    hidePhotos: false,
    hideDevices: false,
    hiddenEdgeTypes: new Set<string>(),
  });

  // Bridge useSearch return into SearchState format for useFilteredGraph
  const searchState = useMemo(
    () => ({
      term: search.term,
      pending: search.pending,
      results: search.results
        ? {
            memoryIds: search.results.memoryIds,
            contactNodeIds: search.results.contactNodeIds,
            scoreMap: search.results.scoreMap,
            resolvedEntities: search.results.resolvedEntities ?? undefined,
          }
        : null,
    }),
    [search.term, search.pending, search.results],
  );

  const [ui, dispatchUI] = useReducer(uiReducer, {
    legendOpen: false,
    isFullscreen: false,
    showHint: false,
    searchFocused: false,
    selectedNode: null,
    focusedNodeId: null,
    focusExpansion: 1,
    contactInfo: null,
  });

  useEffect(() => {
    import('react-force-graph-2d').then((mod) => {
      setForceGraph(() => mod.default);
    });
    api
      .getMeStatus()
      .then(({ contactId }) => {
        if (contactId) setSelfNodeId(`contact-${contactId}`);
      })
      .catch(() => {});
  }, []);

  // Graph updates are now driven by WebSocket deltas — no polling needed

  const hasTrackedView = useRef(false);
  useEffect(() => {
    if (!hasTrackedView.current && data.nodes.length > 0) {
      hasTrackedView.current = true;
      trackEvent('graph_view', {
        node_count: data.nodes.length,
        link_count: data.links.length,
      });
    }
  }, [data.nodes.length, data.links.length]);

  // Listen for search-person events from NodeDetailPanel SEARCH button
  useEffect(() => {
    const handler = (e: Event) => {
      const name = (e as CustomEvent).detail?.name;
      if (name) search.setTerm(name);
    };
    window.addEventListener('botmem:search-person', handler);
    return () => window.removeEventListener('botmem:search-person', handler);
  }, [search]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      if (ui.isFullscreen) {
        const rect = el.getBoundingClientRect();
        setDimensions({ width: rect.width, height: window.innerHeight - rect.top });
      } else {
        const rect = el.getBoundingClientRect();
        setDimensions({
          width: rect.width,
          height: Math.max(300, Math.min(rect.width * 0.4, 450)),
        });
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ForceGraph, ui.isFullscreen]);

  const connectionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const link of data.links) {
      const src =
        typeof link.source === 'object' ? (link.source as { id: string }).id : link.source;
      const tgt =
        typeof link.target === 'object' ? (link.target as { id: string }).id : link.target;
      counts.set(src, (counts.get(src) || 0) + 1);
      counts.set(tgt, (counts.get(tgt) || 0) + 1);
    }
    return counts;
  }, [data.links]);

  const sourceTypes = useMemo(() => {
    const types = new Set<string>();
    for (const node of data.nodes) {
      if (node.nodeType === 'memory' && node.source) types.add(node.source);
    }
    return Array.from(types).sort();
  }, [data.nodes]);

  const edgeTypes = useMemo(() => {
    const types = new Set<string>();
    for (const link of data.links) types.add(link.linkType || 'related');
    return Array.from(types).sort();
  }, [data.links]);

  // Adaptive performance config based on node count
  const adaptiveConfig = useMemo(() => {
    const count = data.nodes.length;
    return {
      cooldownTicks: count > 300 ? 50 : 100,
      performanceMode: count > 300,
      hideDecorativeLinks: count > 500,
      autoMinConnections: count > 800 ? 3 : count > 500 ? 2 : null,
      disableLinkDash: count > 800,
    };
  }, [data.nodes.length]);

  const {
    filteredData,
    isInitialRender,
    searchMatchIds,
    highlightedIds,
    focusVisibleIds,
    adjacency,
    linkColor,
    linkWidth,
  } = useFilteredGraph({
    data,
    filters,
    search: searchState,
    connectionCounts,
    selfNodeId,
    focusedNodeId: ui.focusedNodeId,
    focusExpansion: ui.focusExpansion,
    onReloadPreview,
    graphRef,
    containerRef,
    dimensions,
    adaptiveConfig,
  });

  const handleNodeDoubleClick = useCallback(
    (node: GraphNode) => {
      // For contact/person nodes, trigger a search with their name
      if (node.nodeType === 'contact' && node.label) {
        search.setTerm(node.label);
      }
      dispatchUI({ type: 'doubleClickNode', node });
    },
    [search],
  );

  const authToken = useAuthStore((s) => s.accessToken);

  const renderCtx = useMemo<NodeRenderCtx>(
    () => ({
      searchMatchIds,
      highlightedIds,
      focusVisibleIds,
      selfNodeId,
      scoreMap: searchState.results?.scoreMap ?? null,
      authToken,
      selectedNodeId: ui.selectedNode?.id ?? null,
    }),
    [
      searchMatchIds,
      highlightedIds,
      focusVisibleIds,
      selfNodeId,
      searchState.results,
      authToken,
      ui.selectedNode,
    ],
  );

  // Refresh theme colors + graph background when data-theme attribute changes
  useEffect(() => {
    const syncTheme = () => {
      refreshThemeCache();
      const surface = getComputedStyle(document.documentElement)
        .getPropertyValue('--color-nb-surface')
        .trim();
      if (surface) setBgColor(surface);
    };
    syncTheme();
    const obs = new MutationObserver(syncTheme);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  const nodeCanvasObject = useCallback(
    (node: SimulationNode, ctx: CanvasRenderingContext2D, globalScale: number) =>
      renderNode(node, ctx, globalScale, renderCtx),
    [renderCtx],
  );

  const nodePointerArea = useCallback(
    (node: SimulationNode, color: string, ctx: CanvasRenderingContext2D) =>
      renderNodePointerArea(node, color, ctx),
    [],
  );

  const { handleRemoveIdentifier } = useGraphEffects({
    selectedNode: ui.selectedNode,
    isFullscreen: ui.isFullscreen,
    selfNodeId,
    search: searchState,
    filteredNodes: filteredData.nodes,
    graphRef,
    dispatchUI,
  });

  useGraphKeyboard({
    isFullscreen: ui.isFullscreen,
    selectedNode: ui.selectedNode,
    focusedNodeId: ui.focusedNodeId,
    selfNodeId,
    nodes: filteredData.nodes,
    adjacency,
    searchInputRef,
    graphRef,
    dispatchUI,
  });

  const graphNotReady = !ForceGraph || (graphLoading && data.nodes.length === 0);

  const totalNodes = data.nodes.length;
  const visibleNodes = filteredData.nodes.length;
  const matchCount = searchMatchIds?.size || 0;

  return (
    <div
      className={
        ui.isFullscreen ? 'fixed inset-0 z-50 bg-nb-bg flex flex-col p-4 overflow-hidden' : ''
      }
    >
      {/* Status bar */}
      <div className="flex items-center gap-4 mb-2 font-mono text-xs text-nb-muted uppercase">
        {graphNotReady ? (
          <span className="text-nb-lime">LOADING...</span>
        ) : (
          <>
            <span>
              {visibleNodes} / {totalNodes} nodes
            </span>
            <span>{filteredData.links.length} edges</span>
            {searchState.term && <span>{matchCount} matches</span>}
            {graphPreview && onLoadAll && (
              <button
                onClick={onLoadAll}
                disabled={graphLoading}
                className="px-2 py-0.5 border-2 border-nb-lime text-nb-lime font-bold cursor-pointer hover:bg-nb-lime hover:text-black transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {graphLoading ? 'LOADING...' : 'LOAD ALL'}
              </button>
            )}
            {graphLoading && !graphPreview && <span className="text-nb-lime">LOADING...</span>}
            {adaptiveConfig.performanceMode && (
              <span className="text-nb-lime cursor-help relative group" title="">
                &#9889;
                <span className="absolute left-0 top-full mt-1 z-20 hidden group-hover:block bg-nb-surface border-2 border-nb-border px-2 py-1 text-[11px] text-nb-text normal-case whitespace-nowrap shadow-lg">
                  {totalNodes}+ nodes — reduced detail for performance
                </span>
              </span>
            )}
          </>
        )}
      </div>

      {!searchState.pending && searchState.results && searchState.term.trim() && (
        <SearchResultsBanner
          resolvedEntities={searchState.results.resolvedEntities ?? null}
          resultCount={searchState.results.memoryIds.size}
        />
      )}

      <div
        ref={containerRef}
        className={cn(
          'relative border-3 border-nb-border bg-nb-surface overflow-hidden',
          ui.isFullscreen && 'flex-1',
        )}
        style={ui.isFullscreen ? undefined : { maxHeight: dimensions.height, minHeight: 300 }}
      >
        {graphNotReady ? (
          <div className="flex items-center justify-center h-[300px]">
            <div className="flex flex-col items-center gap-3">
              <div className="size-6 border-3 border-nb-lime border-t-transparent rounded-full animate-spin" />
              <p className="font-mono text-sm uppercase text-nb-text">
                {!ForceGraph ? 'LOADING GRAPH ENGINE...' : 'LOADING GRAPH DATA...'}
              </p>
            </div>
          </div>
        ) : (
          <ForceGraph
            ref={graphRef}
            graphData={filteredData}
            width={dimensions.width}
            height={dimensions.height}
            nodeCanvasObject={nodeCanvasObject}
            nodePointerAreaPaint={nodePointerArea}
            linkColor={linkColor}
            linkWidth={linkWidth}
            linkLineDash={
              adaptiveConfig.disableLinkDash
                ? undefined
                : (link: GraphEdge) =>
                    link.linkType === 'involves' || link.linkType === 'source' ? [4, 2] : []
            }
            onNodeClick={(node: GraphNode) => {
              dispatchUI({ type: 'selectNode', node });
              trackEvent('graph_node_click', {
                node_type: node.nodeType || 'unknown',
              });
            }}
            onNodeDoubleClick={handleNodeDoubleClick}
            onNodeDragEnd={(node: SimulationNode) => {
              node.fx = undefined;
              node.fy = undefined;
            }}
            onBackgroundClick={() => dispatchUI({ type: 'clearFocus' })}
            d3VelocityDecay={0.4}
            cooldownTicks={adaptiveConfig.cooldownTicks}
            onEngineStop={() => {
              if (isInitialRender.current) {
                isInitialRender.current = false;
                const g = graphRef.current;
                if (!g) return;
                const gd = g.graphData?.();
                const meNode = gd?.nodes?.find((n) => n.id === selfNodeId) as
                  | SimulationNode
                  | undefined;
                if (meNode && meNode.x !== undefined) {
                  g.centerAt(meNode.x, meNode.y || 0, 400);
                  setTimeout(() => g.zoomToFit(400, 80), 450);
                } else {
                  g.zoomToFit(400, 80);
                }
                if (gd?.nodes) {
                  for (const n of gd.nodes as SimulationNode[]) {
                    if (n.fx !== undefined) {
                      n.fx = undefined;
                      n.fy = undefined;
                    }
                  }
                }
              }
            }}
            backgroundColor={bgColor}
          />
        )}

        {/* Keyboard shortcuts hint */}
        {ui.isFullscreen && (
          <div
            className="absolute top-3 left-3 z-10 border-2 border-nb-border bg-nb-surface/90 px-3 py-2 font-mono text-[11px] text-nb-muted flex flex-col gap-0.5 pointer-events-none"
            style={{
              opacity: ui.showHint ? 1 : 0,
              transition: 'opacity 0.6s ease-out',
            }}
          >
            <div className="font-bold uppercase text-nb-text text-[11px] mb-1">Keyboard</div>
            <div>
              <span className="inline-block w-12 text-nb-lime font-bold">Arrows</span> Navigate
              nodes
            </div>
            <div>
              <span className="inline-block w-12 text-nb-lime font-bold">{'\u2318'}F</span> Search
            </div>
            <div>
              <span className="inline-block w-12 text-nb-lime font-bold">M</span> Go to me
            </div>
            <div>
              <span className="inline-block w-12 text-nb-lime font-bold">Esc</span> Exit fullscreen
            </div>
          </div>
        )}

        {ui.selectedNode && (
          <NodeDetailPanel
            selectedNode={ui.selectedNode}
            selfNodeId={selfNodeId}
            contactInfo={ui.contactInfo}
            connectionCounts={connectionCounts}
            onClose={() => dispatchUI({ type: 'selectNode', node: null })}
            onRemoveIdentifier={handleRemoveIdentifier}
          />
        )}

        <GraphLegend
          filters={filters}
          dispatch={dispatchFilter}
          sourceTypes={sourceTypes}
          edgeTypes={edgeTypes}
          legendOpen={ui.legendOpen}
          onToggleLegend={() => dispatchUI({ type: 'toggleLegend' })}
          graphRef={graphRef}
        />

        {/* Fullscreen toggle */}
        <button
          onClick={() => dispatchUI({ type: 'toggleFullscreen' })}
          title={ui.isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
          className="absolute bottom-2 right-2 z-10 border-2 border-nb-border size-8 flex items-center justify-center font-mono text-sm font-bold bg-nb-surface text-nb-text hover:bg-nb-lime hover:text-black cursor-pointer transition-colors"
        >
          {ui.isFullscreen ? (
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polyline points="9,1 9,5 13,5" />
              <polyline points="5,13 5,9 1,9" />
            </svg>
          ) : (
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polyline points="1,5 1,1 5,1" />
              <polyline points="13,9 13,13 9,13" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

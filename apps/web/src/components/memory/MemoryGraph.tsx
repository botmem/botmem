import { useRef, useCallback, useState, useMemo, useReducer, useEffect } from 'react';
import type { GraphData } from '@botmem/shared';
import { Card } from '../ui/Card';
import { SearchResultsBanner } from './SearchResultsBanner';
import { NodeDetailPanel } from './NodeDetailPanel';
import { GraphLegend } from './GraphLegend';
import { filterReducer, searchReducer, uiReducer } from './graphReducers';
import { renderNode, renderNodePointerArea } from './graphDrawing';
import type { NodeRenderCtx } from './graphDrawing';
import { useGraphKeyboard } from './useGraphKeyboard';
import { useFilteredGraph } from './useFilteredGraph';
import { useGraphEffects } from './useGraphEffects';
import { api } from '../../lib/api';
import { trackEvent } from '../../lib/posthog';

interface MemoryGraphProps {
  data: GraphData;
  onReload?: () => void;
}


export function MemoryGraph({ data, onReload }: MemoryGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<any>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [ForceGraph, setForceGraph] = useState<any>(null);
  const [dimensions, setDimensions] = useState({ width: 900, height: 500 });
  const [selfNodeId, setSelfNodeId] = useState<string | null>(null);

  const [filters, dispatchFilter] = useReducer(filterReducer, {
    hiddenSourceTypes: new Set<string>(),
    hideContacts: false,
    hideGroups: false,
    hideFiles: false,
    hideDevices: false,
    hiddenEdgeTypes: new Set<string>(),
  });

  const [search, dispatchSearch] = useReducer(searchReducer, {
    term: '',
    pending: false,
    results: null,
  });

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
    api.getMeStatus().then(({ contactId }) => {
      if (contactId) setSelfNodeId(`contact-${contactId}`);
    }).catch(() => {});
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

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      if (ui.isFullscreen) {
        const rect = el.getBoundingClientRect();
        setDimensions({ width: rect.width, height: window.innerHeight - rect.top });
      } else {
        const rect = el.getBoundingClientRect();
        setDimensions({ width: rect.width, height: Math.max(300, Math.min(rect.width * 0.4, 450)) });
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
      const src = typeof link.source === 'object' ? (link.source as any).id : link.source;
      const tgt = typeof link.target === 'object' ? (link.target as any).id : link.target;
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

  const { filteredData, isInitialRender, searchMatchIds, highlightedIds, focusVisibleIds, adjacency, linkColor, linkWidth } = useFilteredGraph({
    data, filters, search, dispatchSearch, connectionCounts, selfNodeId,
    focusedNodeId: ui.focusedNodeId, focusExpansion: ui.focusExpansion, onReload,
    graphRef, containerRef, dimensions, adaptiveConfig,
  });

  const handleNodeDoubleClick = useCallback((node: any) => {
    dispatchUI({ type: 'doubleClickNode', node });
  }, []);

  const renderCtx = useMemo<NodeRenderCtx>(() => ({
    searchMatchIds,
    highlightedIds,
    focusVisibleIds,
    selfNodeId,
    scoreMap: search.results?.scoreMap ?? null,
  }), [searchMatchIds, highlightedIds, focusVisibleIds, selfNodeId, search.results]);

  const nodeCanvasObject = useCallback(
    (node: any, ctx: CanvasRenderingContext2D, globalScale: number) => renderNode(node, ctx, globalScale, renderCtx),
    [renderCtx]
  );

  const nodePointerArea = useCallback(
    (node: any, color: string, ctx: CanvasRenderingContext2D) => renderNodePointerArea(node, color, ctx),
    []
  );

  const { handleRemoveIdentifier } = useGraphEffects({
    selectedNode: ui.selectedNode,
    isFullscreen: ui.isFullscreen,
    selfNodeId,
    search,
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

  if (!ForceGraph) {
    return (
      <Card className="flex items-center justify-center h-[300px]">
        <p className="font-mono text-sm uppercase text-nb-text">LOADING GRAPH ENGINE...</p>
      </Card>
    );
  }

  const totalNodes = data.nodes.length;
  const visibleNodes = filteredData.nodes.length;
  const matchCount = searchMatchIds?.size || 0;

  return (
    <div className={ui.isFullscreen ? 'fixed inset-0 z-50 bg-nb-bg flex flex-col p-4 overflow-hidden' : ''}>
      {/* Controls */}
      <div className="flex items-center gap-3 mb-2">
        <div className="flex-1 relative">
          <input
            ref={searchInputRef}
            type="text"
            value={search.term}
            onChange={(e) => dispatchSearch({ type: 'setTerm', term: e.target.value })}
            placeholder="SEARCH NODES, ENTITIES..."
            className="w-full border-3 px-3 py-1.5 pr-24 font-mono text-xs bg-nb-surface text-nb-text focus:outline-none focus:border-nb-lime placeholder:text-nb-muted placeholder:uppercase transition-all duration-300"
            style={{
              borderColor: search.pending ? '#C4F53A' : ui.searchFocused ? '#C4F53A' : undefined,
              boxShadow: search.pending ? '0 0 8px #C4F53A40' : ui.searchFocused ? '0 0 8px #C4F53A60' : undefined,
            }}
          />
          {search.pending && (
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
              <div className="w-3 h-3 border-2 border-nb-lime border-t-transparent rounded-full animate-spin" />
              <span className="font-mono text-[10px] text-nb-lime uppercase">Searching...</span>
            </div>
          )}
        </div>
      </div>

      {/* Status bar */}
      <div className="flex gap-4 mb-2 font-mono text-xs text-nb-muted uppercase">
        <span>{visibleNodes} / {totalNodes} nodes</span>
        <span>{filteredData.links.length} edges</span>
        {search.term && <span>{matchCount} matches</span>}
        {adaptiveConfig.performanceMode && (
          <span className="text-nb-lime cursor-help relative group" title="">
            &#9889;
            <span className="absolute left-0 top-full mt-1 z-20 hidden group-hover:block bg-nb-surface border-2 border-nb-border px-2 py-1 text-[10px] text-nb-text normal-case whitespace-nowrap shadow-lg">
              {totalNodes}+ nodes — reduced detail for performance
            </span>
          </span>
        )}
      </div>

      {!search.pending && search.results && search.term.trim() && (
        <SearchResultsBanner
          resolvedEntities={search.results.resolvedEntities ?? null}
          resultCount={search.results.memoryIds.size}
        />
      )}

      <div ref={containerRef} className={`relative border-3 border-nb-border bg-nb-surface overflow-hidden ${ui.isFullscreen ? 'flex-1' : ''}`} style={ui.isFullscreen ? undefined : { maxHeight: dimensions.height }}>
        <ForceGraph
          ref={graphRef}
          graphData={filteredData}
          width={dimensions.width}
          height={dimensions.height}
          nodeCanvasObject={nodeCanvasObject}
          nodePointerAreaPaint={nodePointerArea}
          linkColor={linkColor}
          linkWidth={linkWidth}
          linkLineDash={adaptiveConfig.disableLinkDash ? undefined : (link: any) => (link.linkType === 'involves' || link.linkType === 'source') ? [4, 2] : []}
          onNodeClick={(node: any) => {
            dispatchUI({ type: 'selectNode', node });
            trackEvent('graph_node_click', {
              node_type: node.nodeType || 'unknown',
            });
          }}
          onNodeDoubleClick={handleNodeDoubleClick}
          onNodeDragEnd={(node: any) => { node.fx = undefined; node.fy = undefined; }}
          onBackgroundClick={() => dispatchUI({ type: 'clearFocus' })}
          cooldownTicks={adaptiveConfig.cooldownTicks}
          onEngineStop={() => {
            if (isInitialRender.current) {
              isInitialRender.current = false;
              // Center on self node and zoom to fit
              const g = graphRef.current;
              if (!g) return;
              const gd = g.graphData?.();
              const meNode = gd?.nodes?.find((n: any) => n.id === selfNodeId);
              if (meNode && meNode.x !== undefined) {
                g.centerAt(meNode.x, meNode.y, 400);
                setTimeout(() => g.zoomToFit(400, 80), 450);
              } else {
                g.zoomToFit(400, 80);
              }
              if (gd?.nodes) {
                for (const n of gd.nodes) {
                  if (n.fx !== undefined) { n.fx = undefined; n.fy = undefined; }
                }
              }
            }
          }}
          backgroundColor="#1A1A2E"
        />

        {/* Keyboard shortcuts hint */}
        {ui.isFullscreen && (
          <div
            className="absolute top-3 left-3 z-10 border-2 border-nb-border bg-nb-surface/90 px-3 py-2 font-mono text-[10px] text-nb-muted space-y-0.5 pointer-events-none"
            style={{
              opacity: ui.showHint ? 1 : 0,
              transition: 'opacity 0.6s ease-out',
            }}
          >
            <div className="font-bold uppercase text-nb-text text-[11px] mb-1">Keyboard</div>
            <div><span className="inline-block w-12 text-nb-lime font-bold">Arrows</span> Navigate nodes</div>
            <div><span className="inline-block w-12 text-nb-lime font-bold">{'\u2318'}F</span> Search</div>
            <div><span className="inline-block w-12 text-nb-lime font-bold">M</span> Go to me</div>
            <div><span className="inline-block w-12 text-nb-lime font-bold">Esc</span> Exit fullscreen</div>
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
          className="absolute bottom-2 right-2 z-10 border-2 border-nb-border w-8 h-8 flex items-center justify-center font-mono text-sm font-bold bg-nb-surface text-nb-text hover:bg-nb-lime hover:text-black cursor-pointer transition-colors"
        >
          {ui.isFullscreen ? (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="9,1 9,5 13,5" />
              <polyline points="5,13 5,9 1,9" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="1,5 1,1 5,1" />
              <polyline points="13,9 13,13 9,13" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

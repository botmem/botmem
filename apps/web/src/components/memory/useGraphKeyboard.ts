import { useEffect } from 'react';
import type { GraphNode } from '@botmem/shared';
import type { UIAction } from './graphReducers';
import type { ForceGraphInstance, SimulationNode } from './graphTypes';

interface UseGraphKeyboardArgs {
  isFullscreen: boolean;
  selectedNode: GraphNode | null;
  focusedNodeId: string | null;
  selfNodeId: string | null;
  nodes: GraphNode[];
  adjacency: Map<string, string[]>;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  graphRef: React.RefObject<ForceGraphInstance | null>;
  dispatchUI: React.Dispatch<UIAction>;
}

export function useGraphKeyboard({
  isFullscreen,
  selectedNode,
  focusedNodeId,
  selfNodeId,
  nodes,
  adjacency,
  searchInputRef,
  graphRef,
  dispatchUI,
}: UseGraphKeyboardArgs) {
  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
        dispatchUI({ type: 'setSearchFocused', value: true });
        setTimeout(() => dispatchUI({ type: 'setSearchFocused', value: false }), 600);
        return;
      }
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'Escape') {
        if (focusedNodeId) {
          dispatchUI({ type: 'clearFocus' });
          return;
        }
        dispatchUI({ type: 'exitFullscreen' });
        return;
      }
      if (e.key === 'm' || e.key === 'M') {
        if (selfNodeId) {
          const meNode = nodes.find((n) => n.id === selfNodeId) as SimulationNode | undefined;
          if (meNode) {
            dispatchUI({ type: 'selectNode', node: meNode });
            if (graphRef.current && meNode.x !== undefined) {
              graphRef.current.centerAt(meNode.x, meNode.y || 0, 400);
              graphRef.current.zoom(2.5, 400);
            }
          }
        }
        return;
      }
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      e.preventDefault();
      if (nodes.length === 0) return;
      if (!selectedNode) {
        const first = nodes[0];
        dispatchUI({ type: 'selectNode', node: first });
        const n = first as SimulationNode;
        if (n.x !== undefined && graphRef.current) {
          graphRef.current.centerAt(n.x, n.y || 0, 300);
          graphRef.current.zoom(2.5, 300);
        }
        return;
      }
      const sel = selectedNode;
      const neighbors = adjacency.get(sel.id) || [];
      if (neighbors.length === 0) return;
      const current = nodes.find((n) => n.id === sel.id) as SimulationNode | undefined;
      const cx = current?.x ?? 0;
      const cy = current?.y ?? 0;
      const neighborNodes = neighbors
        .map((id) => nodes.find((n) => n.id === id) as SimulationNode | undefined)
        .filter((n): n is SimulationNode => !!n && n.x !== undefined);
      if (neighborNodes.length === 0) return;
      let best: SimulationNode | null = null;
      let bestScore = -Infinity;
      for (const n of neighborNodes) {
        const dx = (n.x || 0) - cx;
        const dy = (n.y || 0) - cy;
        let score = 0;
        switch (e.key) {
          case 'ArrowRight':
            score = dx - Math.abs(dy) * 0.5;
            break;
          case 'ArrowLeft':
            score = -dx - Math.abs(dy) * 0.5;
            break;
          case 'ArrowDown':
            score = dy - Math.abs(dx) * 0.5;
            break;
          case 'ArrowUp':
            score = -dy - Math.abs(dx) * 0.5;
            break;
        }
        if (score > bestScore) {
          bestScore = score;
          best = n;
        }
      }
      if (best) {
        dispatchUI({ type: 'selectNode', node: best });
        if (graphRef.current) graphRef.current.centerAt(best.x || 0, best.y || 0, 300);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    isFullscreen,
    selectedNode,
    nodes,
    adjacency,
    selfNodeId,
    searchInputRef,
    graphRef,
    dispatchUI,
  ]);
}

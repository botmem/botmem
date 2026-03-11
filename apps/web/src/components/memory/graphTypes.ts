import type { GraphNode, GraphEdge } from '@botmem/shared';

/** Subset of the react-force-graph-2d instance API that we actually use. */
export interface ForceGraphInstance {
  zoom: (val?: number, ms?: number) => number;
  zoomToFit: (ms: number, padding?: number) => void;
  centerAt: (x: number, y: number, ms: number) => void;
  graphData?: () => { nodes: GraphNode[]; links: GraphEdge[] };
}

/** A graph node extended with simulation position fields set by d3-force. */
export interface SimulationNode extends GraphNode {
  x?: number;
  y?: number;
  fx?: number;
  fy?: number;
  vx?: number;
  vy?: number;
}

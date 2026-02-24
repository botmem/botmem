import { useRef, useCallback, useEffect, useState } from 'react';
import type { GraphData, GraphNode } from '@botmem/shared';
import { CONNECTOR_COLORS, truncate } from '@botmem/shared';
import { Card } from '../ui/Card';

interface MemoryGraphProps {
  data: GraphData;
}

const factualityColors: Record<string, string> = {
  FACT: '#22C55E',
  UNVERIFIED: '#FFE66D',
  FICTION: '#EF4444',
};

const CONTACT_COLOR = '#60A5FA';

export function MemoryGraph({ data }: MemoryGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ForceGraph, setForceGraph] = useState<any>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);

  useEffect(() => {
    import('react-force-graph-2d').then((mod) => {
      setForceGraph(() => mod.default);
    });
  }, []);

  const nodeCanvasObject = useCallback(
    (node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const x = node.x || 0;
      const y = node.y || 0;
      const isContact = node.nodeType === 'contact';

      if (isContact) {
        // Contact nodes: circles
        const radius = 8;

        // Shadow
        ctx.beginPath();
        ctx.arc(x + 1.5, y + 1.5, radius, 0, 2 * Math.PI);
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fill();

        // Body
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, 2 * Math.PI);
        ctx.fillStyle = CONTACT_COLOR;
        ctx.fill();
        ctx.strokeStyle = '#E0E0E0';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Person icon (simple)
        ctx.fillStyle = '#1A1A2E';
        ctx.beginPath();
        ctx.arc(x, y - 2, 3, 0, 2 * Math.PI);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y + 5, 5, Math.PI, 0);
        ctx.fill();

        // Label
        if (globalScale > 1.2) {
          ctx.font = `bold ${10 / globalScale}px IBM Plex Mono`;
          ctx.fillStyle = CONTACT_COLOR;
          ctx.textAlign = 'center';
          ctx.fillText(truncate(node.label, 20), x, y + radius + 12 / globalScale);
        }
      } else {
        // Memory nodes: squares sized by importance
        const size = 6 + (node.importance || 0.5) * 12;
        const color = CONNECTOR_COLORS[node.sourceConnector] || '#999';

        // Shadow
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(x - size / 2 + 2, y - size / 2 + 2, size, size);

        // Body
        ctx.fillStyle = color;
        ctx.fillRect(x - size / 2, y - size / 2, size, size);

        // Border
        ctx.strokeStyle = '#E0E0E0';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x - size / 2, y - size / 2, size, size);

        // Factuality dot
        const dotColor = factualityColors[node.factuality] || '#999';
        ctx.fillStyle = dotColor;
        ctx.fillRect(x + size / 2 - 4, y - size / 2, 4, 4);
        ctx.strokeRect(x + size / 2 - 4, y - size / 2, 4, 4);

        // Label on zoom
        if (globalScale > 1.5) {
          ctx.font = `bold ${10 / globalScale}px IBM Plex Mono`;
          ctx.fillStyle = '#F0F0F0';
          ctx.textAlign = 'center';
          ctx.fillText(truncate(node.label, 20), x, y + size / 2 + 10 / globalScale);
        }
      }
    },
    []
  );

  const nodePointerArea = useCallback(
    (node: any, color: string, ctx: CanvasRenderingContext2D) => {
      const x = node.x || 0;
      const y = node.y || 0;
      ctx.fillStyle = color;
      if (node.nodeType === 'contact') {
        ctx.beginPath();
        ctx.arc(x, y, 10, 0, 2 * Math.PI);
        ctx.fill();
      } else {
        const size = 6 + (node.importance || 0.5) * 12;
        ctx.fillRect(x - size / 2, y - size / 2, size, size);
      }
    },
    []
  );

  const linkColor = useCallback((link: any) => {
    if (link.linkType === 'contradicts') return '#EF4444';
    if (link.linkType === 'supports') return '#22C55E';
    if (link.linkType === 'involves') return 'rgba(96, 165, 250, 0.4)';
    return '#666';
  }, []);

  const linkWidth = useCallback((link: any) => {
    if (link.linkType === 'involves') return 1;
    return 2;
  }, []);

  if (!ForceGraph) {
    return (
      <Card className="flex items-center justify-center h-[500px]">
        <p className="font-mono text-sm uppercase text-nb-text">LOADING GRAPH ENGINE...</p>
      </Card>
    );
  }

  return (
    <div className="relative">
      <div ref={containerRef} className="border-3 border-nb-border bg-nb-surface">
        <ForceGraph
          graphData={data}
          width={900}
          height={500}
          nodeCanvasObject={nodeCanvasObject}
          nodePointerAreaPaint={nodePointerArea}
          linkColor={linkColor}
          linkWidth={linkWidth}
          linkLineDash={(link: any) => link.linkType === 'involves' ? [4, 2] : []}
          onNodeClick={(node: any) => setSelectedNode(node)}
          cooldownTicks={100}
          backgroundColor="#1A1A2E"
        />
      </div>

      {selectedNode && (
        <div className="absolute top-4 right-4 w-72">
          <Card>
            <div className="flex items-center justify-between mb-2">
              <span className="font-display text-xs font-bold uppercase text-nb-text">
                {selectedNode.nodeType === 'contact' ? 'Contact' : 'Memory'}
              </span>
              <button
                onClick={() => setSelectedNode(null)}
                className="text-xs font-bold cursor-pointer hover:text-nb-red text-nb-text"
              >
                X
              </button>
            </div>
            <p className="font-mono text-xs mb-2 text-nb-text">{selectedNode.label}</p>
            <div className="flex gap-1 flex-wrap">
              {selectedNode.nodeType === 'contact' ? (
                // Show all connectors this contact appears in
                (selectedNode.connectors || []).map((c: string) => (
                  <span
                    key={c}
                    className="border-2 border-nb-border px-2 py-0.5 font-mono text-xs font-bold uppercase"
                    style={{ backgroundColor: CONNECTOR_COLORS[c] || '#999', color: '#000' }}
                  >
                    {c}
                  </span>
                ))
              ) : (
                <>
                  <span
                    className="border-2 border-nb-border px-2 py-0.5 font-mono text-xs font-bold uppercase"
                    style={{ backgroundColor: CONNECTOR_COLORS[selectedNode.sourceConnector], color: '#000' }}
                  >
                    {selectedNode.sourceConnector}
                  </span>
                  <span
                    className="border-2 border-nb-border px-2 py-0.5 font-mono text-xs font-bold uppercase"
                    style={{ backgroundColor: factualityColors[selectedNode.factuality], color: '#000' }}
                  >
                    {selectedNode.factuality}
                  </span>
                </>
              )}
            </div>
            {selectedNode.nodeType !== 'contact' && (
              <div className="mt-2">
                <span className="font-mono text-xs text-nb-muted">Importance: </span>
                <span className="font-mono text-xs font-bold text-nb-text">
                  {(selectedNode.importance * 100).toFixed(0)}%
                </span>
              </div>
            )}
            {selectedNode.entities && selectedNode.entities.length > 0 && (
              <div className="mt-2">
                <span className="font-mono text-xs text-nb-muted block mb-1">Entities:</span>
                <div className="flex gap-1 flex-wrap">
                  {selectedNode.entities.map((e: string, i: number) => (
                    <span
                      key={i}
                      className="border border-nb-border px-1.5 py-0.5 font-mono text-xs bg-nb-surface text-nb-text"
                    >
                      {e}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </Card>
        </div>
      )}

      <div className="absolute bottom-4 left-4">
        <Card className="p-2">
          <div className="flex items-center gap-3 font-mono text-xs text-nb-text">
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded-full inline-block" style={{ backgroundColor: CONTACT_COLOR }} /> contact
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-0.5 bg-nb-muted inline-block" /> related
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-0.5 bg-nb-green inline-block" /> supports
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-0.5 bg-nb-red inline-block" /> contradicts
            </span>
          </div>
        </Card>
      </div>
    </div>
  );
}

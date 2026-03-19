import { useRef, useEffect } from 'react';
import { CONNECTOR_COLORS } from '@botmem/shared';
import type { Memory } from '@botmem/shared';
import { MemoryDetailCore } from './MemoryDetailCore';

/** Read live CSS custom-property values so the canvas matches the active theme. */
function getThemeColors() {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return {
    bg: v('--color-nb-bg') || '#0D0D0D',
    surface: v('--color-nb-surface') || '#1A1A1A',
    border: v('--color-nb-border') || '#333',
    text: v('--color-nb-text') || '#E0E0E0',
    muted: v('--color-nb-muted') || '#A0A0A0',
    accent: v('--color-nb-lime') || '#C4F53A',
    blue: v('--color-nb-blue') || '#4ECDC4',
  };
}

interface MemoryDetailSidebarProps {
  memory: Memory;
  onClose: () => void;
}

export function MemoryDetailSidebar({ memory, onClose }: MemoryDetailSidebarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Draw context mini-graph
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.parentElement?.getBoundingClientRect();
    if (!rect) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    const W = rect.width,
      H = rect.height;
    const CX = W / 2,
      CY = H / 2 + 8;

    ctx.clearRect(0, 0, W, H);

    const tc = getThemeColors();

    // Center node (the memory)
    const connColor = CONNECTOR_COLORS[memory.sourceConnector] || tc.muted;
    ctx.beginPath();
    ctx.arc(CX, CY, 10, 0, Math.PI * 2);
    ctx.fillStyle = connColor;
    ctx.fill();
    ctx.strokeStyle = tc.text;
    ctx.lineWidth = 2;
    ctx.stroke();

    // People in orbit
    const people = memory.people || [];
    const pplRadius = Math.min(W, H) * 0.28;
    if (people.length > 0) {
      const step = (2 * Math.PI) / people.length;
      people.forEach((p, i) => {
        const a = step * i - Math.PI / 2;
        const px = CX + Math.cos(a) * pplRadius;
        const py = CY + Math.sin(a) * pplRadius;
        // Edge
        ctx.beginPath();
        ctx.moveTo(CX, CY);
        ctx.lineTo(px, py);
        ctx.strokeStyle = tc.accent + '4D';
        ctx.lineWidth = 1;
        ctx.stroke();
        // Node
        ctx.beginPath();
        ctx.arc(px, py, 5, 0, Math.PI * 2);
        ctx.fillStyle = tc.accent;
        ctx.fill();
        ctx.strokeStyle = tc.text;
        ctx.lineWidth = 1;
        ctx.stroke();
        // Label
        ctx.font = '8px IBM Plex Mono';
        ctx.fillStyle = tc.muted;
        ctx.textAlign = 'center';
        ctx.fillText((p.displayName || '?').split(' ')[0], px, py + 12);
      });
    }

    // Entities in outer orbit
    const entities = memory.entities || [];
    const entRadius = pplRadius * 1.6;
    if (entities.length > 0) {
      const step = (2 * Math.PI) / entities.length;
      entities.forEach((e, i) => {
        const a = step * i;
        const ex = CX + Math.cos(a) * entRadius;
        const ey = CY + Math.sin(a) * entRadius;
        // Edge
        ctx.beginPath();
        ctx.moveTo(CX, CY);
        ctx.lineTo(ex, ey);
        ctx.strokeStyle = tc.blue + '33';
        ctx.lineWidth = 1;
        ctx.stroke();
        // Diamond node
        ctx.save();
        ctx.translate(ex, ey);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = tc.blue;
        ctx.fillRect(-3, -3, 6, 6);
        ctx.restore();
        // Label
        ctx.font = '7px IBM Plex Mono';
        ctx.fillStyle = tc.muted;
        ctx.textAlign = 'center';
        ctx.fillText((e.value || '').slice(0, 10), ex, ey + 10);
      });
    }
  }, [memory]);

  return (
    <div className="flex flex-col h-full border-l-2 border-nb-border bg-nb-surface">
      <div className="flex items-center justify-between border-b-2 border-nb-border px-3 py-2.5">
        <span className="font-display text-xs font-bold uppercase tracking-wider text-nb-text">
          DETAIL
        </span>
        <button
          onClick={onClose}
          className="border-2 border-nb-border size-6 flex items-center justify-center text-xs font-bold cursor-pointer hover:bg-nb-red hover:text-white text-nb-text"
        >
          X
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
        <MemoryDetailCore
          id={memory.id}
          source={memory.source}
          sourceConnector={memory.sourceConnector}
          text={memory.text}
          eventTime={memory.time}
          weights={memory.weights}
          entities={memory.entities}
          claims={memory.claims}
          metadata={memory.metadata as Record<string, unknown>}
          people={memory.people}
          importance={memory.weights?.importance}
          showTimestamps
          showClaims
        />

        {/* Context mini-graph */}
        {memory.people?.length || memory.entities?.length ? (
          <div>
            <span className="font-display text-xs font-bold uppercase mb-1 block text-nb-text">
              Context Graph
            </span>
            <div className="border-2 border-nb-border bg-nb-surface-muted h-48 relative">
              <canvas ref={canvasRef} className="w-full h-full block" />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

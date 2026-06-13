import { useRef, useEffect } from 'react';
import { CONNECTOR_COLORS } from '@botmem/shared';
import type { Memory } from '@botmem/shared';

function getThemeColor(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

interface StreamGraphProps {
  memories: Memory[];
  className?: string;
}

export function StreamGraph({ memories, className }: StreamGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

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
    const PAD = { l: 48, r: 16, t: 24, b: 20 };
    const plotW = W - PAD.l - PAD.r,
      plotH = H - PAD.t - PAD.b;
    ctx.clearRect(0, 0, W, H);
    if (memories.length === 0) return;

    // Bin by day and connector
    const bins = new Map<string, Record<string, number>>();
    for (const m of memories) {
      const time = new Date(m.time || '');
      if (Number.isNaN(time.getTime())) continue;
      const day = time.toISOString().slice(0, 10);
      if (!bins.has(day)) bins.set(day, {});
      const b = bins.get(day)!;
      b[m.sourceConnector] = (b[m.sourceConnector] || 0) + 1;
    }

    const days = [...bins.keys()].sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
    if (days.length === 0) return;

    const connTypes = [...new Set(memories.map((m) => m.sourceConnector))];
    const maxTotal = Math.max(
      ...days.map((d) => {
        const b = bins.get(d)!;
        return connTypes.reduce((s, c) => s + (b[c] || 0), 0);
      }),
    );

    const xStep = days.length > 1 ? plotW / (days.length - 1) : plotW;
    const yScale = plotH / (maxTotal * 1.1 || 1);

    if (days.length === 1) {
      const x = PAD.l + plotW / 2;
      const barW = Math.min(48, plotW * 0.35);
      let bottom = PAD.t + plotH;
      for (const ct of connTypes) {
        const val = bins.get(days[0])?.[ct] || 0;
        if (!val) continue;
        const h = Math.max(3, val * yScale);
        ctx.fillStyle = CONNECTOR_COLORS[ct] || '#888';
        ctx.fillRect(x - barW / 2, bottom - h, barW, h);
        bottom -= h;
      }
      ctx.strokeStyle = getThemeColor('--color-nb-border', '#333333');
      ctx.lineWidth = 2;
      ctx.strokeRect(x - barW / 2, bottom, barW, PAD.t + plotH - bottom);
    } else {
      // Stacked area
      const stackBottom = new Array(days.length).fill(0);
      for (const ct of connTypes) {
        const color = CONNECTOR_COLORS[ct] || '#888';
        ctx.fillStyle = color + '30';
        ctx.strokeStyle = color + '80';
        ctx.lineWidth = 1.5;

        ctx.beginPath();
        for (let i = 0; i < days.length; i++) {
          const x = PAD.l + i * xStep;
          const val = bins.get(days[i])?.[ct] || 0;
          const y = PAD.t + plotH - (stackBottom[i] + val) * yScale;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        for (let i = days.length - 1; i >= 0; i--) {
          const x = PAD.l + i * xStep;
          ctx.lineTo(x, PAD.t + plotH - stackBottom[i] * yScale);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        for (let i = 0; i < days.length; i++) {
          stackBottom[i] += bins.get(days[i])?.[ct] || 0;
        }
      }
    }

    const includeYear = new Set(days.map((d) => d.slice(0, 4))).size > 1 || days.length === 1;
    const label = (day: string) => {
      const options: Intl.DateTimeFormatOptions = {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      };
      if (includeYear) options.year = '2-digit';
      return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', options);
    };

    // X-axis labels (show ~5 dates)
    ctx.fillStyle = getThemeColor('--color-nb-muted', '#A0A0A0');
    ctx.font = '9px IBM Plex Mono';
    ctx.textAlign = 'center';
    const step = Math.max(1, Math.floor(days.length / 5));
    for (let i = 0; i < days.length; i += step) {
      const x = PAD.l + i * xStep;
      ctx.fillText(label(days[i]), x, H - 4);
    }

    // Y-axis
    ctx.textAlign = 'right';
    ctx.fillText(String(maxTotal), PAD.l - 6, PAD.t + 10);
    ctx.fillText('0', PAD.l - 6, PAD.t + plotH);
  }, [memories]);

  return (
    <div className={`relative ${className || ''}`}>
      <div className="absolute top-2 left-3 font-mono text-[9px] font-bold uppercase tracking-wider text-nb-muted z-10">
        Results Over Time
      </div>
      <canvas ref={canvasRef} className="w-full h-full block" />
    </div>
  );
}

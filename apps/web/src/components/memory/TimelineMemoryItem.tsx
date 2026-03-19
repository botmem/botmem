import { CONNECTOR_COLORS, formatTime } from '@botmem/shared';
import type { Memory } from '@botmem/shared';

const FACTUALITY_COLORS: Record<string, string> = {
  FACT: 'var(--color-nb-green)',
  UNVERIFIED: 'var(--color-nb-yellow)',
  FICTION: 'var(--color-nb-red)',
};

interface TimelineMemoryItemProps {
  memory: Memory;
  selected: boolean;
  onClick: () => void;
}

export function TimelineMemoryItem({ memory, selected, onClick }: TimelineMemoryItemProps) {
  const connColor = CONNECTOR_COLORS[memory.sourceConnector] || '#888';
  const score = memory.weights?.final || 0;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left p-3 border-b-2 border-nb-border font-mono text-xs cursor-pointer transition-colors ${
        selected
          ? 'bg-nb-surface-hover border-l-4 border-l-nb-lime'
          : 'bg-nb-surface hover:bg-nb-surface-hover border-l-4 border-l-transparent'
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="size-2.5 shrink-0" style={{ backgroundColor: connColor }} />
        <span className="font-bold uppercase text-[11px] text-nb-muted">
          {memory.sourceConnector}
        </span>
        <span className="text-nb-muted text-[11px] ml-auto">{formatTime(memory.time)}</span>
        <span
          className="font-bold text-[11px] px-1 border border-nb-border"
          style={{ color: score > 0.7 ? 'var(--color-nb-lime)' : 'var(--color-nb-muted)' }}
        >
          {(score * 100).toFixed(0)}%
        </span>
      </div>
      <p className="text-nb-text line-clamp-2 text-[11px] mb-1">{memory.text}</p>
      <div className="flex gap-1 flex-wrap">
        {memory.people?.slice(0, 3).map((p) => (
          <span key={p.personId} className="border border-nb-border px-1 text-[9px] text-nb-muted">
            {p.displayName}
          </span>
        ))}
        {memory.factuality?.label && memory.factuality.label !== 'UNVERIFIED' && (
          <span
            className="text-[9px] font-bold px-1"
            style={{ color: FACTUALITY_COLORS[memory.factuality.label] }}
          >
            {memory.factuality.label}
          </span>
        )}
      </div>
    </button>
  );
}

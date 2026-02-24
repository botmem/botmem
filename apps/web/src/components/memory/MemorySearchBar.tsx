import { cn } from '@botmem/shared';
import type { SourceType, FactualityLabel } from '@botmem/shared';
import { Input } from '../ui/Input';

interface MemorySearchBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  sourceFilter: SourceType | null;
  onSourceChange: (s: SourceType | null) => void;
  factualityFilter: FactualityLabel | null;
  onFactualityChange: (f: FactualityLabel | null) => void;
}

const sources: Array<{ value: SourceType; label: string }> = [
  { value: 'email', label: '✉ EMAIL' },
  { value: 'message', label: '💬 MESSAGE' },
  { value: 'photo', label: '📷 PHOTO' },
  { value: 'location', label: '📍 LOCATION' },
];

const factualities: Array<{ value: FactualityLabel; label: string; color: string }> = [
  { value: 'FACT', label: 'FACT', color: '#22C55E' },
  { value: 'UNVERIFIED', label: 'UNVERIFIED', color: '#FFE66D' },
  { value: 'FICTION', label: 'FICTION', color: '#EF4444' },
];

export function MemorySearchBar({
  query,
  onQueryChange,
  sourceFilter,
  onSourceChange,
  factualityFilter,
  onFactualityChange,
}: MemorySearchBarProps) {
  return (
    <div className="flex flex-col gap-3">
      <Input
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="SEARCH YOUR MEMORIES..."
        className="text-lg py-4"
      />
      <div className="flex gap-2 flex-wrap">
        {sources.map((s) => (
          <button
            key={s.value}
            onClick={() => onSourceChange(sourceFilter === s.value ? null : s.value)}
            className={cn(
              'border-2 border-nb-border px-3 py-1 font-mono text-xs font-bold uppercase cursor-pointer transition-all',
              sourceFilter === s.value
                ? 'bg-nb-text text-nb-bg'
                : 'bg-nb-surface hover:bg-nb-surface-hover text-nb-text'
            )}
          >
            {s.label}
          </button>
        ))}
        <div className="w-px bg-nb-border mx-1" />
        {factualities.map((f) => (
          <button
            key={f.value}
            onClick={() => onFactualityChange(factualityFilter === f.value ? null : f.value)}
            className={cn(
              'border-2 border-nb-border px-3 py-1 font-mono text-xs font-bold uppercase cursor-pointer transition-all',
              factualityFilter !== f.value && 'text-nb-text'
            )}
            style={{
              backgroundColor: factualityFilter === f.value ? f.color : undefined,
              color: factualityFilter === f.value ? '#000' : undefined,
            }}
          >
            {f.label}
          </button>
        ))}
      </div>
    </div>
  );
}

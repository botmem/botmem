import { cn } from '@botmem/shared';
import type { SourceType } from '@botmem/shared';
import { Input } from '../ui/Input';

interface MemorySearchBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  sourceFilter: SourceType | null;
  onSourceChange: (s: SourceType | null) => void;
  resultCount?: number;
  loading?: boolean;
}

const sources: Array<{ value: SourceType; label: string }> = [
  { value: 'email', label: 'EMAIL' },
  { value: 'message', label: 'MESSAGE' },
  { value: 'photo', label: 'PHOTO' },
  { value: 'location', label: 'LOCATION' },
];

export function MemorySearchBar({
  query,
  onQueryChange,
  sourceFilter,
  onSourceChange,
  resultCount,
  loading,
}: MemorySearchBarProps) {
  return (
    <div className="flex flex-col gap-3">
      <Input
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="SEARCH YOUR MEMORIES..."
        className="text-lg py-4"
      />
      <div className="flex items-center gap-2 flex-wrap">
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
        {resultCount !== undefined && (
          <span className="ml-auto font-mono text-xs text-nb-muted uppercase">
            {loading ? 'SEARCHING...' : `${resultCount} memories found`}
          </span>
        )}
      </div>
    </div>
  );
}

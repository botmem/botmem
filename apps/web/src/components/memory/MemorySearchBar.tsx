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
  pending?: boolean;
  availableSources?: SourceType[];
}

const sourceLabels: Partial<Record<SourceType, string>> = {
  email: 'EMAIL',
  message: 'MESSAGE',
  photo: 'PHOTO',
  location: 'LOCATION',
  file: 'FILE',
};

export function MemorySearchBar({
  query,
  onQueryChange,
  sourceFilter,
  onSourceChange,
  resultCount,
  loading,
  pending,
  availableSources,
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
        {availableSources &&
          availableSources.map((value) => (
            <button
              key={value}
              onClick={() => onSourceChange(sourceFilter === value ? null : value)}
              className={cn(
                'border-2 border-nb-border px-3 py-1 font-mono text-xs font-bold uppercase cursor-pointer transition-all',
                sourceFilter === value
                  ? 'bg-nb-text text-nb-bg'
                  : 'bg-nb-surface hover:bg-nb-surface-hover text-nb-text',
              )}
            >
              {sourceLabels[value] || value.toUpperCase()}
            </button>
          ))}
        {resultCount !== undefined && (
          <span className="ml-auto font-mono text-xs text-nb-muted uppercase">
            {loading || pending ? (
              <span className="flex items-center gap-2">
                <span className="size-3 border-2 border-nb-text border-t-transparent rounded-full animate-spin" />
                SEARCHING...
              </span>
            ) : (
              `${resultCount} memories found`
            )}
          </span>
        )}
      </div>
    </div>
  );
}

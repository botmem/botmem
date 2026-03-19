import type { RefObject } from 'react';

interface SearchHeaderProps {
  query: string;
  onQueryChange: (q: string) => void;
  onSearch?: () => void;
  loading?: boolean;
  resultCount?: number;
  inputRef?: RefObject<HTMLInputElement | null>;
}

export function SearchHeader({
  query,
  onQueryChange,
  onSearch,
  loading,
  resultCount,
  inputRef,
}: SearchHeaderProps) {
  return (
    <div className="flex items-center gap-2">
      {/* Search input */}
      <div className="relative flex-1">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onSearch?.();
            }
          }}
          placeholder="SEARCH YOUR MEMORIES..."
          aria-label="Search memories"
          className="w-full border-2 border-nb-border bg-nb-bg px-3 py-2 font-mono text-sm text-nb-text placeholder:text-nb-muted/50 focus:border-nb-lime focus:outline-none"
        />
        {loading && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-xs text-nb-lime animate-pulse">
            ...
          </span>
        )}
      </div>

      {/* Result count */}
      {resultCount !== undefined && (
        <span className="hidden shrink-0 font-mono text-xs text-nb-muted sm:block">
          {resultCount} RESULTS
        </span>
      )}
    </div>
  );
}

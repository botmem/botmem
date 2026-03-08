import { useState, useMemo, useRef, useEffect } from 'react';
import type { Memory, SourceType } from '@botmem/shared';
import { PageContainer } from '../components/layout/PageContainer';
import { MemorySearchBar } from '../components/memory/MemorySearchBar';
import { SearchResultsBanner } from '../components/memory/SearchResultsBanner';
import { MemoryCard } from '../components/memory/MemoryCard';
import { MemoryDetailPanel } from '../components/memory/MemoryDetailPanel';
import { useMemories } from '../hooks/useMemories';
import { EmptyState } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';

const PAGE_SIZE = 20;

export function MemoryExplorerPage() {
  const [selectedMemory, setSelectedMemory] = useState<Memory | null>(null);
  const [page, setPage] = useState(1);
  const listRef = useRef<HTMLDivElement>(null);
  const prevQueryRef = useRef(undefined as string | undefined);
  const prevSourceRef = useRef<SourceType | null | undefined>(undefined);
  const { filtered, query, filters, setQuery, setFilters, loading, searchFallback, resolvedEntities, parsed } = useMemories();

  // Reset to page 1 when filters/query change (synchronous state adjustment during render)
  if (prevQueryRef.current !== query || prevSourceRef.current !== filters.source) {
    prevQueryRef.current = query;
    prevSourceRef.current = filters.source;
    if (page !== 1) setPage(1);
  }

  const availableSources = useMemo(
    () => [...new Set(filtered.map((m) => m.source))] as SourceType[],
    [filtered],
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filtered, page],
  );

  // Scroll list to top on page change
  useEffect(() => { listRef.current?.scrollTo(0, 0); }, [page]);

  // Auto-select top result when search completes
  useEffect(() => {
    if (!loading && query.trim() && filtered.length > 0) {
      setSelectedMemory(filtered[0]);
    }
  }, [loading, query, filtered]);

  return (
    <PageContainer>
      <div className="mt-4 flex flex-col" style={{ height: 'calc(100vh - 10rem)' }}>
          <div className="flex flex-col min-h-0 h-full">
            <MemorySearchBar
              query={query}
              onQueryChange={setQuery}
              sourceFilter={filters.source}
              onSourceChange={(s) => setFilters({ source: s })}
              resultCount={filtered.length}
              loading={loading}
              availableSources={availableSources}
            />

            <div className="mt-4 flex gap-4 min-h-0 flex-1">
              <div
                ref={listRef}
                className="flex-1 flex flex-col gap-3 overflow-y-auto pr-2"
              >
                {!loading && query.trim() && (
                  <SearchResultsBanner
                    resolvedEntities={resolvedEntities}
                    resultCount={filtered.length}
                    searchFallback={searchFallback}
                    query={query}
                    parsed={parsed}
                  />
                )}
                {loading && <Skeleton variant="card" count={3} />}
                {!loading && paged.map((m, i) => (
                  <MemoryCard
                    key={m.id}
                    memory={m}
                    onClick={() => setSelectedMemory(m)}
                    selected={selectedMemory?.id === m.id}
                    topResult={i === 0 && page === 1 && !!query.trim()}
                  />
                ))}
                {!loading && filtered.length === 0 && (
                  <EmptyState
                    icon="◉"
                    title="No Memories Found"
                    subtitle="Try adjusting your filters"
                  />
                )}
              </div>

              {selectedMemory && (
                <div className="w-96 shrink-0 overflow-y-auto">
                  <MemoryDetailPanel
                    memory={selectedMemory}
                    onClose={() => setSelectedMemory(null)}
                  />
                </div>
              )}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 pt-3 border-t-2 border-nb-border mt-3 shrink-0">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="border-2 border-nb-border px-3 py-1 font-mono text-xs font-bold cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed hover:bg-nb-surface-hover transition-colors"
                >
                  ← PREV
                </button>
                <span className="font-mono text-xs text-nb-muted px-2">
                  {page} / {totalPages}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="border-2 border-nb-border px-3 py-1 font-mono text-xs font-bold cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed hover:bg-nb-surface-hover transition-colors"
                >
                  NEXT →
                </button>
              </div>
            )}
          </div>
      </div>
    </PageContainer>
  );
}

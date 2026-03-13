import { useState, useRef, useEffect, useMemo } from 'react';
import { cn } from '@/lib/utils';
import type { Memory, SourceType } from '@botmem/shared';
import { PageContainer } from '../components/layout/PageContainer';
import { MemorySearchBar } from '../components/memory/MemorySearchBar';
import { SearchResultsBanner } from '../components/memory/SearchResultsBanner';
import { MemoryCard } from '../components/memory/MemoryCard';
import { MemoryDetailPanel } from '../components/memory/MemoryDetailPanel';
import { useMemories } from '../hooks/useMemories';
import { EmptyState } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';
import { InfiniteScrollList } from '../components/ui/InfiniteScrollList';
import { ReauthModal } from '../components/ui/ReauthModal';

export function MemoryExplorerPage() {
  const [selectedMemory, setSelectedMemory] = useState<Memory | null>(null);
  const lastAutoSelectQuery = useRef('');
  const {
    filtered,
    query,
    filters,
    setQuery,
    setFilters,
    loading,
    loadingMore,
    hasMore,
    loadMoreMemories,
    loadMemories,
    searchFallback,
    searchPending,
    resolvedEntities,
    parsed,
    memoryStats,
    totalMemories,
    error,
  } = useMemories();
  const needsRecoveryKey = !!memoryStats?.needsRecoveryKey;
  const availableSources = useMemo(() => {
    if (!memoryStats?.bySource) return [];
    return Object.keys(memoryStats.bySource).filter(
      (k) => Number(memoryStats.bySource[k]) > 0,
    ) as SourceType[];
  }, [memoryStats?.bySource]);
  const [reauthOpen, setReauthOpen] = useState(false);

  // Auto-select top result only when a new search completes
  useEffect(() => {
    if (!loading && query.trim() && filtered.length > 0 && lastAutoSelectQuery.current !== query) {
      lastAutoSelectQuery.current = query;
      setSelectedMemory(filtered[0]);
    }
  }, [loading, query, filtered]);

  return (
    <PageContainer>
      <ReauthModal open={reauthOpen} onClose={() => setReauthOpen(false)} />
      {needsRecoveryKey && (
        <div className="mt-4 flex flex-col items-center justify-center gap-4 py-20 border-2 border-nb-border/40 bg-nb-surface/30">
          <svg
            width="48"
            height="48"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-nb-text"
          >
            <rect x="3" y="11" width="18" height="11" rx="0" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <p className="font-display text-lg text-nb-muted text-center max-w-md">
            Enter your recovery key to access your memories.
          </p>
          <button
            onClick={() => setReauthOpen(true)}
            className="px-5 py-2.5 border-2 border-nb-lime bg-nb-lime/20 font-display text-sm font-bold uppercase tracking-wider text-nb-lime hover:bg-nb-lime/40 cursor-pointer transition-colors"
          >
            Unlock
          </button>
        </div>
      )}
      {!needsRecoveryKey && (
        <div className="mt-4 flex flex-col h-[calc(100dvh-9rem)] sm:h-[calc(100dvh-10rem)]">
          <div className="flex flex-col min-h-0 h-full">
            <div className="flex items-center gap-3" data-tour="memory-search">
              <div className="flex-1">
                <MemorySearchBar
                  query={query}
                  onQueryChange={setQuery}
                  sourceFilter={filters.source}
                  onSourceChange={(s) => setFilters({ source: s })}
                  resultCount={query.trim() ? filtered.length : totalMemories}
                  loading={loading}
                  pending={searchPending}
                  availableSources={availableSources}
                />
              </div>
            </div>

            <div className="mt-4 flex flex-col md:flex-row gap-4 min-h-0 flex-1">
              <InfiniteScrollList
                items={filtered}
                renderItem={(m, i) => (
                  <MemoryCard
                    memory={m}
                    onClick={() => setSelectedMemory(m)}
                    selected={selectedMemory?.id === m.id}
                    topResult={i === 0 && !!query.trim()}
                  />
                )}
                keyExtractor={(m) => m.id}
                hasMore={hasMore}
                loading={loading}
                loadingMore={loadingMore}
                onLoadMore={loadMoreMemories}
                disabled={!!query.trim()}
                className="flex-1 flex flex-col gap-3 overflow-y-auto pr-2"
                header={
                  !loading && query.trim() ? (
                    <SearchResultsBanner
                      resolvedEntities={resolvedEntities}
                      resultCount={filtered.length}
                      searchFallback={searchFallback}
                      query={query}
                      parsed={parsed}
                    />
                  ) : undefined
                }
                loadingSkeleton={<Skeleton variant="card" count={3} />}
                emptyState={
                  error ? (
                    <EmptyState
                      icon="!"
                      title="Failed to Load"
                      subtitle={error}
                      action={{ label: 'Retry', onClick: loadMemories }}
                    />
                  ) : (
                    <EmptyState
                      icon="0"
                      title="No Memories Found"
                      subtitle="Try adjusting your filters"
                    />
                  )
                }
              />

              {/* Desktop detail panel */}
              {selectedMemory && (
                <div className="hidden md:block md:w-96 md:shrink-0 overflow-y-auto">
                  <MemoryDetailPanel
                    memory={selectedMemory}
                    onClose={() => setSelectedMemory(null)}
                  />
                </div>
              )}

              {/* Mobile full-screen detail overlay */}
              <div
                className={cn(
                  'fixed inset-0 z-50 bg-nb-bg overflow-y-auto md:hidden',
                  selectedMemory ? 'block' : 'hidden',
                )}
              >
                <div className="p-4 border-b-4 border-nb-border flex items-center gap-3 bg-nb-surface">
                  <button
                    onClick={() => setSelectedMemory(null)}
                    className="border-2 border-nb-border size-9 flex items-center justify-center hover:bg-nb-lime hover:text-black transition-colors cursor-pointer text-nb-text"
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M10 3L5 8l5 5" />
                    </svg>
                  </button>
                  <span className="font-display text-sm font-bold uppercase tracking-wider text-nb-text">
                    DETAIL
                  </span>
                </div>
                {selectedMemory && (
                  <div className="p-4">
                    <MemoryDetailPanel
                      memory={selectedMemory}
                      onClose={() => setSelectedMemory(null)}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </PageContainer>
  );
}

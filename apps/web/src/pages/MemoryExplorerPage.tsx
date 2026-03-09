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
import { ReauthModal } from '../components/ui/ReauthModal';

const PAGE_SIZE = 20;
const ALL_SOURCES: SourceType[] = ['email', 'message', 'photo', 'location', 'file'];

export function MemoryExplorerPage() {
  const [selectedMemory, setSelectedMemory] = useState<Memory | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const lastAutoSelectQuery = useRef('');
  const prevQueryRef = useRef(undefined as string | undefined);
  const prevSourceRef = useRef<SourceType | null | undefined>(undefined);
  const {
    filtered,
    query,
    filters,
    setQuery,
    setFilters,
    loading,
    searchFallback,
    resolvedEntities,
    parsed,
    memoryStats,
  } = useMemories();
  const needsRelogin = !!memoryStats?.needsRelogin;
  const [reauthOpen, setReauthOpen] = useState(false);

  // Reset visibleCount when filters/query change (synchronous state adjustment during render)
  if (prevQueryRef.current !== query || prevSourceRef.current !== filters.source) {
    prevQueryRef.current = query;
    prevSourceRef.current = filters.source;
    if (visibleCount !== PAGE_SIZE) setVisibleCount(PAGE_SIZE);
  }

  const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);

  // Auto-select top result only when a new search completes (not on every filtered change)
  useEffect(() => {
    if (!loading && query.trim() && filtered.length > 0 && lastAutoSelectQuery.current !== query) {
      lastAutoSelectQuery.current = query;
      setSelectedMemory(filtered[0]);
    }
  }, [loading, query, filtered]);

  // Infinite scroll via IntersectionObserver
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && visibleCount < filtered.length) {
          setVisibleCount((prev) => Math.min(prev + PAGE_SIZE, filtered.length));
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [visibleCount, filtered.length]);

  return (
    <PageContainer>
      <ReauthModal open={reauthOpen} onClose={() => setReauthOpen(false)} />
      {needsRelogin && (
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
            Your encryption key needs to be restored. Enter your password to unlock your memories.
          </p>
          <button
            onClick={() => setReauthOpen(true)}
            className="px-5 py-2.5 border-2 border-nb-lime bg-nb-lime/20 font-display text-sm font-bold uppercase tracking-wider text-nb-lime hover:bg-nb-lime/40 cursor-pointer transition-colors"
          >
            Unlock
          </button>
        </div>
      )}
      {!needsRelogin && (
        <div className="mt-4 flex flex-col" style={{ height: 'calc(100vh - 10rem)' }}>
          <div className="flex flex-col min-h-0 h-full">
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <MemorySearchBar
                  query={query}
                  onQueryChange={setQuery}
                  sourceFilter={filters.source}
                  onSourceChange={(s) => setFilters({ source: s })}
                  resultCount={filtered.length}
                  loading={loading}
                  availableSources={ALL_SOURCES}
                />
              </div>
            </div>

            <div className="mt-4 flex flex-col md:flex-row gap-4 min-h-0 flex-1">
              <div ref={listRef} className="flex-1 flex flex-col gap-3 overflow-y-auto pr-2">
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
                {!loading &&
                  visible.map((m, i) => (
                    <MemoryCard
                      key={m.id}
                      memory={m}
                      onClick={() => setSelectedMemory(m)}
                      selected={selectedMemory?.id === m.id}
                      topResult={i === 0 && !!query.trim()}
                    />
                  ))}
                {!loading && filtered.length === 0 && (
                  <EmptyState
                    icon="0"
                    title="No Memories Found"
                    subtitle="Try adjusting your filters"
                  />
                )}
                {!loading && visibleCount < filtered.length && (
                  <div ref={sentinelRef} className="py-4 text-center">
                    <span className="font-mono text-xs text-nb-muted uppercase">
                      Loading more...
                    </span>
                  </div>
                )}
              </div>

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
                className={`fixed inset-0 z-50 bg-nb-bg overflow-y-auto md:hidden ${selectedMemory ? 'block' : 'hidden'}`}
              >
                <div className="p-4 border-b-4 border-nb-border flex items-center gap-3 bg-nb-surface">
                  <button
                    onClick={() => setSelectedMemory(null)}
                    className="border-2 border-nb-border w-9 h-9 flex items-center justify-center hover:bg-nb-lime hover:text-black transition-colors cursor-pointer text-nb-text"
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

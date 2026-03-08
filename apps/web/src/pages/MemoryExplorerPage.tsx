import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import type { Memory, SourceType } from '@botmem/shared';
import { PageContainer } from '../components/layout/PageContainer';
import { MemorySearchBar } from '../components/memory/MemorySearchBar';
import { SearchResultsBanner } from '../components/memory/SearchResultsBanner';
import { MemoryCard } from '../components/memory/MemoryCard';
import { MemoryDetailPanel } from '../components/memory/MemoryDetailPanel';
import { useMemories } from '../hooks/useMemories';
import { EmptyState } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';
import { api } from '../lib/api';

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
  } = useMemories();

  // Backfill state
  const [backfillLoading, setBackfillLoading] = useState(false);
  const [backfillMessage, setBackfillMessage] = useState<string | null>(null);

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

  const handleBackfillEnrich = useCallback(async () => {
    setBackfillLoading(true);
    setBackfillMessage(null);
    try {
      const result = await api.backfillEnrich();
      if (result.jobId) {
        setBackfillMessage(`Backfill started: ${result.enqueued} memories queued`);
      } else {
        setBackfillMessage(result.message || 'No memories need re-enrichment');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to start backfill';
      setBackfillMessage(`Error: ${msg}`);
    } finally {
      setBackfillLoading(false);
    }
  }, []);

  // Clear backfill message after 5s
  useEffect(() => {
    if (!backfillMessage) return;
    const t = setTimeout(() => setBackfillMessage(null), 5000);
    return () => clearTimeout(t);
  }, [backfillMessage]);

  return (
    <PageContainer>
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
            <button
              onClick={handleBackfillEnrich}
              disabled={backfillLoading}
              className="shrink-0 rounded-lg border border-nb-border bg-nb-surface px-3 py-2 text-xs font-mono uppercase tracking-wider text-nb-text hover:bg-nb-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {backfillLoading ? 'Starting...' : 'Re-enrich All'}
            </button>
          </div>

          {backfillMessage && (
            <div className="mt-2 rounded-md bg-nb-surface border border-nb-border px-3 py-1.5 text-xs font-mono text-nb-muted">
              {backfillMessage}
            </div>
          )}

          <div className="mt-4 flex gap-4 min-h-0 flex-1">
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
                  icon="*"
                  title="No Memories Found"
                  subtitle="Try adjusting your filters"
                />
              )}
              {!loading && visibleCount < filtered.length && (
                <div ref={sentinelRef} className="py-4 text-center">
                  <span className="font-mono text-xs text-nb-muted uppercase">Loading more...</span>
                </div>
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
        </div>
      </div>
    </PageContainer>
  );
}

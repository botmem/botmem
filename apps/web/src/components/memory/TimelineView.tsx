import { useState, useMemo, useEffect, useRef } from 'react';
import type { Memory } from '@botmem/shared';
import { formatDate } from '@botmem/shared';
import { StreamGraph } from './StreamGraph';
import { TimelineMemoryItem } from './TimelineMemoryItem';
import { MemoryDetailSidebar } from './MemoryDetailSidebar';

interface TimelineViewProps {
  memories: Memory[];
  loading: boolean;
  loadingMore?: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void | Promise<void>;
  emptyMessage?: string;
}

export function TimelineView({
  memories,
  loading,
  loadingMore = false,
  hasMore = false,
  onLoadMore,
  emptyMessage = 'No memories found. Try a search query.',
}: TimelineViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const scrollRootRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const selectedMemory = memories.find((m) => m.id === selectedId) || null;

  // Group memories by day
  const dayGroups = useMemo(() => {
    const groups = new Map<string, Memory[]>();
    for (const m of memories) {
      const day = (m.time || '').slice(0, 10) || 'Unknown';
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day)!.push(m);
    }
    // Sort days descending
    return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [memories]);

  useEffect(() => {
    const root = scrollRootRef.current;
    const target = loadMoreRef.current;
    if (!root || !target || !hasMore || loading || loadingMore || !onLoadMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void onLoadMore();
        }
      },
      { root, rootMargin: '480px 0px', threshold: 0 },
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, onLoadMore, memories.length]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Stream Graph — full width, above the list+sidebar row */}
      <div className="h-36 border-b-2 border-nb-border shrink-0">
        <StreamGraph memories={memories} className="h-full" />
      </div>

      {/* Timeline list + Detail sidebar row */}
      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Left: Day-grouped Timeline */}
        <div ref={scrollRootRef} className="flex-1 overflow-y-auto min-w-0">
          {loading && (
            <div className="p-4 font-mono text-xs text-nb-muted uppercase">Loading...</div>
          )}
          {!loading && memories.length === 0 && (
            <div className="p-8 text-center font-mono text-sm text-nb-muted">
              {emptyMessage}
            </div>
          )}
          {dayGroups.map(([day, mems]) => (
            <div key={day}>
              <div className="sticky top-0 z-10 px-3 py-1.5 border-b-2 border-nb-border bg-nb-bg font-display text-[11px] font-bold uppercase tracking-wider text-nb-muted">
                {day === 'Unknown' ? 'Unknown Date' : formatDate(day + 'T00:00:00')}
                <span className="ml-2 text-nb-text">{mems.length}</span>
              </div>
              {mems.map((m) => (
                <TimelineMemoryItem
                  key={m.id}
                  memory={m}
                  selected={selectedId === m.id}
                  onClick={() => setSelectedId(m.id)}
                />
              ))}
            </div>
          ))}
          <div ref={loadMoreRef} className="min-h-10">
            {loadingMore && (
              <div className="border-t-2 border-nb-border px-3 py-3 font-mono text-xs uppercase text-nb-muted">
                Loading more...
              </div>
            )}
            {!loading && !loadingMore && hasMore && (
              <div className="border-t-2 border-nb-border px-3 py-3 font-mono text-[11px] uppercase text-nb-muted">
                More memories queued
              </div>
            )}
          </div>
        </div>

        {/* Right: Detail Panel — only beside the timeline list, not the stream graph */}
        {selectedMemory && (
          <aside className="hidden lg:flex w-96 shrink-0">
            <MemoryDetailSidebar memory={selectedMemory} onClose={() => setSelectedId(null)} />
          </aside>
        )}
      </div>

      {selectedMemory && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Memory detail"
          className="fixed inset-0 z-50 bg-nb-surface lg:hidden"
        >
          <MemoryDetailSidebar memory={selectedMemory} onClose={() => setSelectedId(null)} />
        </div>
      )}
    </div>
  );
}

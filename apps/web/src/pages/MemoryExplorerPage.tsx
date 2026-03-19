import { useState, useRef, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { PageContainer } from '../components/layout/PageContainer';
import { useMemoryStore } from '../store/memoryStore';
import { SearchHeader } from '../components/memory/SearchHeader';
import { MemoryCard } from '../components/memory/MemoryCard';
import { MemoryDetailPanel } from '../components/memory/MemoryDetailPanel';
import { SearchResultsBanner } from '../components/memory/SearchResultsBanner';
import { useSearchKeyboard } from '../hooks/useSearchKeyboard';
import { EmptyState } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';
import { ReauthModal } from '../components/ui/ReauthModal';

export function MemoryExplorerPage() {
  const query = useMemoryStore((s) => s.query);
  const setQuery = useMemoryStore((s) => s.setQuery);
  const memories = useMemoryStore((s) => s.memories);
  const loading = useMemoryStore((s) => s.loading);
  const loadingMore = useMemoryStore((s) => s.loadingMore);
  const hasMore = useMemoryStore((s) => s.hasMore);
  const searchMemories = useMemoryStore((s) => s.searchMemories);
  const loadMemories = useMemoryStore((s) => s.loadMemories);
  const loadMoreMemories = useMemoryStore((s) => s.loadMoreMemories);
  const totalMemories = useMemoryStore((s) => s.totalMemories);
  const searchFallback = useMemoryStore((s) => s.searchFallback);
  const resolvedEntities = useMemoryStore((s) => s.resolvedEntities);
  const parsed = useMemoryStore((s) => s.parsed);
  const connectWs = useMemoryStore((s) => s.connectWs);
  const memoryStats = useMemoryStore((s) => s.memoryStats);
  const error = useMemoryStore((s) => s.error);

  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null);
  const [reauthOpen, setReauthOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  const needsRecoveryKey = !!memoryStats?.needsRecoveryKey;
  const selectedMemory = memories.find((m) => m.id === selectedMemoryId) || null;

  useSearchKeyboard({
    searchInputRef,
    resultsRef,
    memories,
    selectedMemoryId,
    onSelectMemory: setSelectedMemoryId,
  });

  // Load memories and connect WS on mount
  useEffect(() => {
    loadMemories();
    connectWs();
  }, [loadMemories, connectWs]);

  // Debounced search: triggers searchMemories 500ms after typing stops
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = query.trim();
    if (!trimmed) {
      // Empty query — reload all memories
      loadMemories();
      return;
    }
    if (trimmed.length < 3) return; // wait for at least 3 chars

    debounceRef.current = setTimeout(() => {
      searchMemories(trimmed);
    }, 500);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, searchMemories, loadMemories]);

  // Immediate search on Enter
  const handleSearch = useCallback(() => {
    const trimmed = query.trim();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!trimmed) {
      loadMemories();
    } else {
      searchMemories(trimmed);
    }
  }, [query, searchMemories, loadMemories]);

  // Auto-select top result on new search (only on large screens where detail panel is inline)
  const lastAutoSelectQuery = useRef('');
  useEffect(() => {
    if (!loading && query.trim() && memories.length > 0 && lastAutoSelectQuery.current !== query) {
      lastAutoSelectQuery.current = query;
      // Only auto-select on lg+ viewports — on smaller screens it triggers the full-screen overlay
      if (window.innerWidth >= 1024) {
        setSelectedMemoryId(memories[0].id);
      }
    }
  }, [loading, query, memories]);

  // Infinite scroll handler
  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLElement>) => {
      if (loadingMore || !hasMore || query.trim()) return;
      const el = e.currentTarget;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) {
        loadMoreMemories();
      }
    },
    [loadingMore, hasMore, query, loadMoreMemories],
  );

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
        <div className="flex flex-col h-[calc(100dvh-5rem)]">
          {/* Search Header */}
          <SearchHeader
            query={query}
            onQueryChange={setQuery}
            onSearch={handleSearch}
            loading={loading}
            resultCount={query.trim() ? memories.length : totalMemories}
            inputRef={searchInputRef}
          />

          {/* Main Content */}
          <div className="flex flex-1 overflow-hidden">
            {/* Center: Results */}
            <main ref={resultsRef} className="flex-1 overflow-y-auto p-4" onScroll={handleScroll}>
              {!loading && query.trim() && (
                <SearchResultsBanner
                  resolvedEntities={resolvedEntities}
                  resultCount={memories.length}
                  searchFallback={searchFallback}
                  query={query}
                  parsed={parsed}
                />
              )}

              {loading && <Skeleton variant="card" count={3} />}

              {!loading &&
                memories.length === 0 &&
                (error ? (
                  <EmptyState
                    icon="!"
                    title="Failed to Load"
                    subtitle={error}
                    action={{ label: 'Retry', onClick: loadMemories }}
                  />
                ) : !(resolvedEntities || searchFallback) ? (
                  <EmptyState
                    icon="0"
                    title="No Memories Found"
                    subtitle="Try a different search query"
                  />
                ) : null)}

              <div className="flex flex-col gap-3">
                {memories.map((m, i) => (
                  <MemoryCard
                    key={m.id}
                    memory={m}
                    onClick={() => setSelectedMemoryId(m.id)}
                    selected={selectedMemoryId === m.id}
                    topResult={i === 0 && !!query.trim()}
                  />
                ))}
              </div>

              {loadingMore && (
                <div className="py-4">
                  <Skeleton variant="card" count={2} />
                </div>
              )}
            </main>

            {/* Right: Detail Panel (shown when memory selected, hidden on mobile) */}
            {selectedMemory && (
              <aside className="hidden lg:block w-96 flex-shrink-0 border-l-2 border-nb-border overflow-y-auto">
                <MemoryDetailPanel
                  memory={selectedMemory}
                  onClose={() => setSelectedMemoryId(null)}
                />
              </aside>
            )}
          </div>

          {/* Mobile full-screen detail overlay */}
          <div
            className={cn(
              'fixed inset-0 z-50 bg-nb-bg overflow-y-auto lg:hidden',
              selectedMemory ? 'block' : 'hidden',
            )}
          >
            <div className="p-4 border-b-4 border-nb-border flex items-center gap-3 bg-nb-surface">
              <button
                onClick={() => setSelectedMemoryId(null)}
                className="border-2 border-nb-border size-11 flex items-center justify-center hover:bg-nb-lime hover:text-black transition-colors cursor-pointer text-nb-text"
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
                  onClose={() => setSelectedMemoryId(null)}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </PageContainer>
  );
}

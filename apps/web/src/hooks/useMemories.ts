import { useEffect, useMemo } from 'react';
import { useMemoryStore } from '../store/memoryStore';
import { useMemoryBankStore } from '../store/memoryBankStore';
import { useSearch } from './useSearch';

export function useMemories() {
  // Select only the slices we need — avoids re-render on unrelated state changes
  const memories = useMemoryStore((s) => s.memories);
  const filters = useMemoryStore((s) => s.filters);
  const loading = useMemoryStore((s) => s.loading);
  const loadingMore = useMemoryStore((s) => s.loadingMore);
  const hasMore = useMemoryStore((s) => s.hasMore);
  const totalMemories = useMemoryStore((s) => s.totalMemories);
  const searchFallback = useMemoryStore((s) => s.searchFallback);
  const resolvedEntities = useMemoryStore((s) => s.resolvedEntities);
  const parsed = useMemoryStore((s) => s.parsed);
  const memoryStats = useMemoryStore((s) => s.memoryStats);
  const error = useMemoryStore((s) => s.error);
  const graphData = useMemoryStore((s) => s.graphData);
  const graphPreview = useMemoryStore((s) => s.graphPreview);
  const graphLoading = useMemoryStore((s) => s.graphLoading);

  // New Phase 7 selectors
  const mode = useMemoryStore((s) => s.mode);
  const setMode = useMemoryStore((s) => s.setMode);
  const facets = useMemoryStore((s) => s.facets);
  const activeFilters = useMemoryStore((s) => s.activeFilters);
  const toggleFilter = useMemoryStore((s) => s.toggleFilter);
  const setTimeRange = useMemoryStore((s) => s.setTimeRange);
  const setPinnedFilter = useMemoryStore((s) => s.setPinnedFilter);
  const clearAllFilters = useMemoryStore((s) => s.clearAllFilters);
  const activePreset = useMemoryStore((s) => s.activePreset);
  const applyPreset = useMemoryStore((s) => s.applyPreset);
  const conversation = useMemoryStore((s) => s.conversation);
  const sendMessage = useMemoryStore((s) => s.sendMessage);
  const clearConversation = useMemoryStore((s) => s.clearConversation);

  // Actions are stable references — selecting individually avoids re-render
  const setFilters = useMemoryStore((s) => s.setFilters);
  const loadMemories = useMemoryStore((s) => s.loadMemories);
  const loadMoreMemories = useMemoryStore((s) => s.loadMoreMemories);
  const loadGraph = useMemoryStore((s) => s.loadGraph);
  const loadFullGraph = useMemoryStore((s) => s.loadFullGraph);
  const loadGraphForIds = useMemoryStore((s) => s.loadGraphForIds);
  const connectWs = useMemoryStore((s) => s.connectWs);
  const setQuery = useMemoryStore((s) => s.setQuery);
  const setSearchResults = useMemoryStore((s) => s.setSearchResults);

  const activeMemoryBankId = useMemoryBankStore((s) => s.activeMemoryBankId);

  // Memoize filtered list — only recomputes when memories or filters change
  const filtered = useMemo(() => {
    return memories.filter((m) => {
      if (filters.source && m.source !== filters.source) return false;
      if (m.weights.importance < filters.minImportance) return false;
      return true;
    });
  }, [memories, filters]);

  const search = useSearch({
    onResults: (results) => {
      setQuery(search.term);
      setSearchResults({
        items: results.items,
        fallback: results.fallback,
        resolvedEntities: results.resolvedEntities,
        parsed: results.parsed ?? null,
      });
    },
    onClear: () => {
      setQuery('');
      loadMemories();
    },
  });

  useEffect(() => {
    loadMemories();
    connectWs();
  }, [activeMemoryBankId]);

  return {
    memories,
    filters,
    loading,
    loadingMore,
    hasMore,
    totalMemories,
    searchFallback,
    resolvedEntities,
    parsed,
    memoryStats,
    error,
    graphData,
    graphPreview,
    graphLoading,
    setFilters,
    loadMemories,
    loadMoreMemories,
    loadGraph,
    loadFullGraph,
    loadGraphForIds,
    filtered,
    query: search.term,
    setQuery: search.setTerm,
    searchPending: search.pending,
    // Phase 7
    mode,
    setMode,
    facets,
    activeFilters,
    toggleFilter,
    setTimeRange,
    setPinnedFilter,
    clearAllFilters,
    activePreset,
    applyPreset,
    conversation,
    sendMessage,
    clearConversation,
  };
}

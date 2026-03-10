import { useEffect } from 'react';
import { useMemoryStore } from '../store/memoryStore';
import { useMemoryBankStore } from '../store/memoryBankStore';
import { useSearch } from './useSearch';

export function useMemories() {
  const store = useMemoryStore();
  const filtered = store.getFiltered();
  const activeMemoryBankId = useMemoryBankStore((s) => s.activeMemoryBankId);

  const search = useSearch({
    onResults: (results) => {
      store.setQuery(search.term);
      store.setSearchResults({
        items: results.items,
        fallback: results.fallback,
        resolvedEntities: results.resolvedEntities,
        parsed: results.parsed ?? null,
      });
    },
    onClear: () => {
      store.setQuery('');
      store.loadMemories();
    },
  });

  useEffect(() => {
    store.loadMemories();
    store.connectWs();
  }, [activeMemoryBankId]);

  return {
    ...store,
    filtered,
    query: search.term,
    setQuery: search.setTerm,
    searchPending: search.pending,
  };
}

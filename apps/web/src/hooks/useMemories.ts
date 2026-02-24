import { useEffect } from 'react';
import { useMemoryStore } from '../store/memoryStore';

export function useMemories() {
  const store = useMemoryStore();
  const filtered = store.getFiltered();

  useEffect(() => {
    store.loadMemories();
  }, []);

  return { ...store, filtered };
}

import { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import type { ApiMemoryItem, ApiSearchResponse } from '../lib/api';
import { useMemoryBankStore } from '../store/memoryBankStore';

interface ResolvedEntities {
  contacts: { id: string; displayName: string }[];
  topicWords: string[];
  topicMatchCount: number;
}

export interface SearchResult {
  items: ApiMemoryItem[];
  memoryIds: Set<string>;
  contactNodeIds: string[];
  scoreMap: Map<string, number>;
  resolvedEntities: ResolvedEntities | null;
  fallback: boolean;
  parsed?: ApiSearchResponse['parsed'];
}

interface UseSearchOptions {
  debounceMs?: number;
  minLength?: number;
  limit?: number;
  onResults?: (results: SearchResult) => void;
  onClear?: () => void;
}

export interface UseSearchReturn {
  term: string;
  setTerm: (t: string) => void;
  pending: boolean;
  results: SearchResult | null;
  clear: () => void;
}

export function useSearch(opts: UseSearchOptions = {}): UseSearchReturn {
  const { debounceMs = 500, minLength = 3, limit = 100, onResults, onClear } = opts;

  const [term, setTerm] = useState('');
  const [pending, setPending] = useState(false);
  const [results, setResults] = useState<SearchResult | null>(null);
  const hadResults = useRef(false);

  const clear = useCallback(() => {
    setTerm('');
    setPending(false);
    setResults(null);
    hadResults.current = false;
    onClear?.();
  }, [onClear]);

  useEffect(() => {
    const trimmed = term.trim();
    if (!trimmed) {
      const shouldNotify = hadResults.current;
      hadResults.current = false;
      setResults(null);
      setPending(false);
      if (shouldNotify) onClear?.();
      return;
    }
    if (trimmed.length < minLength) return;

    const timer = setTimeout(async () => {
      setPending(true);
      try {
        const bankId = useMemoryBankStore.getState().activeMemoryBankId;
        const res = await api.searchMemories(trimmed, undefined, limit, bankId || undefined);

        const memoryIds = new Set<string>(res.items.map((item) => item.id));
        const contactNodeIds = (res.resolvedEntities?.contacts || []).map(
          (c: { id: string }) => `contact-${c.id}`,
        );
        const scoreMap = new Map<string, number>();
        const total = res.items.length;
        res.items.forEach((item, idx) => {
          scoreMap.set(item.id, total > 1 ? 1 - idx / (total - 1) : 1);
        });
        for (const id of contactNodeIds) scoreMap.set(id, 1);

        const result: SearchResult = {
          items: res.items,
          memoryIds,
          contactNodeIds,
          scoreMap,
          resolvedEntities: res.resolvedEntities ?? null,
          fallback: res.fallback ?? false,
          parsed: res.parsed,
        };

        hadResults.current = true;
        setResults(result);
        setPending(false);
        onResults?.(result);
      } catch {
        setResults(null);
        setPending(false);
      }
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [term]);

  return { term, setTerm, pending, results, clear };
}

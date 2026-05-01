import { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import type { ApiMemoryItem, ApiSearchResponse } from '../lib/api';
import { useMemoryBankStore } from '../store/memoryBankStore';
import { useAuthStore } from '../store/authStore';

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
  pendingMore: boolean;
  hasMore: boolean;
  results: SearchResult | null;
  clear: () => void;
  loadMore: () => Promise<void>;
}

const SEARCH_MAX_LIMIT = 250;

export function useSearch(opts: UseSearchOptions = {}): UseSearchReturn {
  const { debounceMs = 500, minLength = 3, limit = 100, onResults, onClear } = opts;
  const pageSize = Math.min(limit, SEARCH_MAX_LIMIT);

  const [term, setTerm] = useState('');
  const [pending, setPending] = useState(false);
  const [pendingMore, setPendingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [results, setResults] = useState<SearchResult | null>(null);
  const hadResults = useRef(false);
  const currentLimit = useRef(pageSize);

  const applyResponse = useCallback(
    (res: ApiSearchResponse, requestedLimit: number) => {
      // Surface recovery key requirement from search response
      if (res.needsRecoveryKey) {
        useAuthStore.setState({ needsRecoveryKey: true });
      }

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

      const reportedTotal = res.found ?? res.items.length;
      const canAskForMore = requestedLimit < SEARCH_MAX_LIMIT;
      setHasMore(res.items.length < reportedTotal && canAskForMore);
      hadResults.current = true;
      setResults(result);
      onResults?.(result);
    },
    [onResults],
  );

  const clear = useCallback(() => {
    setTerm('');
    setPending(false);
    setPendingMore(false);
    setHasMore(false);
    setResults(null);
    currentLimit.current = pageSize;
    hadResults.current = false;
    onClear?.();
  }, [onClear, pageSize]);

  const runSearch = useCallback(
    async (query: string, requestedLimit: number) => {
      const bankId = useMemoryBankStore.getState().activeMemoryBankId;
      const res = await api.searchMemories(query, undefined, requestedLimit, bankId || undefined);
      applyResponse(res, requestedLimit);
    },
    [applyResponse],
  );

  const loadMore = useCallback(async () => {
    const trimmed = term.trim();
    if (!trimmed || trimmed.length < minLength || pending || pendingMore || !hasMore) return;

    const nextLimit = Math.min(currentLimit.current + pageSize, SEARCH_MAX_LIMIT);
    if (nextLimit <= currentLimit.current) {
      setHasMore(false);
      return;
    }

    setPendingMore(true);
    try {
      await runSearch(trimmed, nextLimit);
      currentLimit.current = nextLimit;
    } finally {
      setPendingMore(false);
    }
  }, [hasMore, minLength, pageSize, pending, pendingMore, runSearch, term]);

  useEffect(() => {
    const trimmed = term.trim();
    if (!trimmed) {
      const shouldNotify = hadResults.current;
      hadResults.current = false;
      setResults(null);
      setPending(false);
      setPendingMore(false);
      setHasMore(false);
      currentLimit.current = pageSize;
      if (shouldNotify) onClear?.();
      return;
    }
    if (trimmed.length < minLength) return;

    const timer = setTimeout(async () => {
      setPending(true);
      setHasMore(false);
      currentLimit.current = pageSize;
      try {
        await runSearch(trimmed, pageSize);
        setPending(false);
      } catch {
        setResults(null);
        setHasMore(false);
        setPending(false);
      }
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [debounceMs, minLength, onClear, pageSize, runSearch, term]);

  return { term, setTerm, pending, pendingMore, hasMore, results, clear, loadMore };
}

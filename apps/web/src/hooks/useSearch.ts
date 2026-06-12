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
  lowConfidence: boolean;
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
  error: string | null;
  results: SearchResult | null;
  clear: () => void;
  loadMore: () => Promise<void>;
}

const SEARCH_MAX_LIMIT = 250;
// ponytail: UI-only score floor; move to the API if other clients need shared relevance semantics.
const MIN_DISPLAY_SCORE = 0.5;

function itemScore(item: ApiMemoryItem): number {
  if (typeof item.score === 'number') return item.score;
  const weights = item.weights;
  if (weights == null) return 1;
  if (typeof weights === 'string') {
    try {
      const parsed = JSON.parse(weights) as { final?: number };
      return parsed.final ?? 0;
    } catch {
      return 0;
    }
  }
  return weights?.final ?? 0;
}

export function useSearch(opts: UseSearchOptions = {}): UseSearchReturn {
  const { debounceMs = 500, minLength = 3, limit = 100, onResults, onClear } = opts;
  const pageSize = Math.min(limit, SEARCH_MAX_LIMIT);

  const [term, setTerm] = useState('');
  const [pending, setPending] = useState(false);
  const [pendingMore, setPendingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SearchResult | null>(null);
  const hadResults = useRef(false);
  const currentLimit = useRef(pageSize);
  const requestSeq = useRef(0);
  const onResultsRef = useRef(onResults);
  const onClearRef = useRef(onClear);

  useEffect(() => {
    onResultsRef.current = onResults;
    onClearRef.current = onClear;
  }, [onClear, onResults]);

  const applyResponse = useCallback((res: ApiSearchResponse, requestedLimit: number) => {
    // Surface recovery key requirement from search response
    if (res.needsRecoveryKey) {
      useAuthStore.setState({ needsRecoveryKey: true });
    }

    const fallback = res.fallback ?? false;
    const displayItems = fallback
      ? res.items
      : res.items.filter((item) => itemScore(item) >= MIN_DISPLAY_SCORE);
    const lowConfidence = !fallback && res.items.length > 0 && displayItems.length === 0;
    const memoryIds = new Set<string>(displayItems.map((item) => item.id));
    const contactNodeIds = (res.resolvedEntities?.contacts || []).map(
      (c: { id: string }) => `contact-${c.id}`,
    );
    const scoreMap = new Map<string, number>();
    const total = displayItems.length;
    displayItems.forEach((item, idx) => {
      scoreMap.set(item.id, total > 1 ? 1 - idx / (total - 1) : 1);
    });
    for (const id of contactNodeIds) scoreMap.set(id, 1);

    const result: SearchResult = {
      items: displayItems,
      memoryIds,
      contactNodeIds,
      scoreMap,
      resolvedEntities: res.resolvedEntities ?? null,
      fallback,
      lowConfidence,
      parsed: res.parsed,
    };

    const reportedTotal = lowConfidence ? 0 : (res.found ?? displayItems.length);
    const canAskForMore = requestedLimit < SEARCH_MAX_LIMIT;
    setHasMore(res.items.length < reportedTotal && canAskForMore);
    hadResults.current = true;
    setResults(result);
    onResultsRef.current?.(result);
  }, []);

  const clear = useCallback(() => {
    setTerm('');
    setPending(false);
    setPendingMore(false);
    setHasMore(false);
    setError(null);
    setResults(null);
    currentLimit.current = pageSize;
    hadResults.current = false;
    requestSeq.current++;
    onClearRef.current?.();
  }, [pageSize]);

  const runSearch = useCallback(
    async (query: string, requestedLimit: number) => {
      const seq = ++requestSeq.current;
      const bankId = useMemoryBankStore.getState().activeMemoryBankId;
      const res = await api.searchMemories(query, undefined, requestedLimit, bankId || undefined);
      if (seq !== requestSeq.current) return false;
      setError(null);
      applyResponse(res, requestedLimit);
      return true;
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
      const applied = await runSearch(trimmed, nextLimit);
      if (applied) currentLimit.current = nextLimit;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
      setResults(null);
      setHasMore(false);
    } finally {
      if (trimmed === term.trim()) setPendingMore(false);
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
      setError(null);
      currentLimit.current = pageSize;
      requestSeq.current++;
      if (shouldNotify) onClearRef.current?.();
      return;
    }
    if (trimmed.length < minLength) {
      requestSeq.current++;
      return;
    }

    const seq = ++requestSeq.current;
    const timer = setTimeout(async () => {
      setPending(true);
      setHasMore(false);
      setError(null);
      currentLimit.current = pageSize;
      try {
        const bankId = useMemoryBankStore.getState().activeMemoryBankId;
        const res = await api.searchMemories(trimmed, undefined, pageSize, bankId || undefined);
        if (seq !== requestSeq.current) return;
        applyResponse(res, pageSize);
      } catch (err) {
        if (seq !== requestSeq.current) return;
        setError(err instanceof Error ? err.message : 'Search failed');
        setResults(null);
        setHasMore(false);
      } finally {
        if (seq === requestSeq.current) setPending(false);
      }
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [applyResponse, debounceMs, minLength, pageSize, term]);

  return { term, setTerm, pending, pendingMore, hasMore, error, results, clear, loadMore };
}

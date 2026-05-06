import { useCallback, useEffect, useRef, type ReactNode } from 'react';

interface InfiniteScrollListProps<T> {
  items: T[];
  renderItem: (item: T, index: number) => ReactNode;
  keyExtractor: (item: T) => string;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  disabled?: boolean;
  emptyState?: ReactNode;
  loadingSkeleton?: ReactNode;
  header?: ReactNode;
  className?: string;
}

export function InfiniteScrollList<T>({
  items,
  renderItem,
  keyExtractor,
  hasMore,
  loading,
  loadingMore,
  onLoadMore,
  disabled,
  emptyState,
  loadingSkeleton,
  header,
  className,
}: InfiniteScrollListProps<T>) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const requestPendingRef = useRef(false);

  useEffect(() => {
    if (!loadingMore) requestPendingRef.current = false;
  }, [items.length, loadingMore]);

  const requestMore = useCallback(() => {
    if (disabled || loading || loadingMore || !hasMore || requestPendingRef.current) return;
    requestPendingRef.current = true;
    onLoadMore();
  }, [disabled, hasMore, loading, loadingMore, onLoadMore]);

  const checkSentinel = useCallback(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const rect = sentinel.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    if (rect.top <= viewportHeight + 120 && rect.bottom >= -120) {
      requestMore();
    }
  }, [requestMore]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || disabled) return;
    checkSentinel();
    let observer: IntersectionObserver | null = null;
    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) requestMore();
        },
        { rootMargin: '120px 0px', threshold: 0.01 },
      );
      observer.observe(sentinel);
    }
    const scrollParent = sentinel.parentElement;
    window.addEventListener('scroll', checkSentinel, { passive: true });
    scrollParent?.addEventListener('scroll', checkSentinel, { passive: true });
    window.addEventListener('resize', checkSentinel);
    return () => {
      observer?.disconnect();
      window.removeEventListener('scroll', checkSentinel);
      scrollParent?.removeEventListener('scroll', checkSentinel);
      window.removeEventListener('resize', checkSentinel);
    };
  }, [checkSentinel, disabled, requestMore]);

  return (
    <div className={className}>
      {header}
      {loading && loadingSkeleton}
      {!loading &&
        items.map((item, i) => <div key={keyExtractor(item)}>{renderItem(item, i)}</div>)}
      {!loading && items.length === 0 && emptyState}
      {!loading && (hasMore || loadingMore) && !disabled && (
        <div ref={sentinelRef} className="py-4 text-center">
          <span className="font-mono text-xs text-nb-muted uppercase">Loading more...</span>
        </div>
      )}
    </div>
  );
}

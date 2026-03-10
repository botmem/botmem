import { useRef, useEffect, type ReactNode } from 'react';

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

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || disabled) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && hasMore && !loadingMore) {
          onLoadMore();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, onLoadMore, disabled]);

  return (
    <div className={className}>
      {header}
      {loading && loadingSkeleton}
      {!loading && items.map((item, i) => (
        <div key={keyExtractor(item)}>{renderItem(item, i)}</div>
      ))}
      {!loading && items.length === 0 && emptyState}
      {!loading && (hasMore || loadingMore) && !disabled && (
        <div ref={sentinelRef} className="py-4 text-center">
          <span className="font-mono text-xs text-nb-muted uppercase">Loading more...</span>
        </div>
      )}
    </div>
  );
}

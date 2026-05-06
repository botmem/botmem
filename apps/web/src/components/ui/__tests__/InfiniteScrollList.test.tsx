import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InfiniteScrollList } from '../InfiniteScrollList';

describe('InfiniteScrollList', () => {
  it('loads more when the sentinel is already visible', async () => {
    const onLoadMore = vi.fn();

    render(
      <InfiniteScrollList
        items={['one']}
        renderItem={(item) => <span>{item}</span>}
        keyExtractor={(item) => item}
        hasMore
        loading={false}
        loadingMore={false}
        onLoadMore={onLoadMore}
      />,
    );

    await waitFor(() => expect(onLoadMore).toHaveBeenCalledTimes(1));
  });

  it('does not load more while disabled', async () => {
    const onLoadMore = vi.fn();

    render(
      <InfiniteScrollList
        items={['one']}
        renderItem={(item) => <span>{item}</span>}
        keyExtractor={(item) => item}
        hasMore
        loading={false}
        loadingMore={false}
        onLoadMore={onLoadMore}
        disabled
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onLoadMore).not.toHaveBeenCalled();
  });
});

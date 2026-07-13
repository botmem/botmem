import type { SearchResponse } from '@botmem-v2/contracts';
import type { SearchApplicationService } from '@botmem-v2/sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  RateLimitedSearchService,
  SearchCapacityUnavailableError,
  SearchRateLimitExceededError,
  type SearchRateLimitStore,
} from './rate-limited-search.js';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const RESPONSE: SearchResponse = {
  version: 2,
  queryId: '30000000-0000-4000-8000-000000000001',
  items: [],
  coverage: { partial: false, lanes: [] },
  found: 0,
  tookMs: 1,
};

describe('RateLimitedSearchService', () => {
  it('search_whenBothSharedBucketsAllow_delegatesWithoutStoringTheQuery', async () => {
    const consume = vi.fn(async () => true);
    const search = vi.fn(async () => RESPONSE);
    const service = build({ consume }, { search });

    await expect(
      service.search(WORKSPACE_ID, { version: 2, query: 'private words' }),
    ).resolves.toBe(RESPONSE);

    expect(search).toHaveBeenCalledOnce();
    expect(consume).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(consume.mock.calls)).not.toContain('private words');
    expect(JSON.stringify(consume.mock.calls)).not.toContain(WORKSPACE_ID);
  });

  it('search_whenEitherBucketRejects_returnsRetryableRateLimitWithoutCallingProvider', async () => {
    const consume = vi.fn(async (input: { key: string }) => input.key !== 'search:global');
    const search = vi.fn(async () => RESPONSE);
    const service = build({ consume }, { search });

    await expect(service.search(WORKSPACE_ID, { version: 2, query: 'launch' })).rejects.toEqual(
      expect.objectContaining<SearchRateLimitExceededError>({
        retryAfterSeconds: 60,
      }),
    );
    expect(search).not.toHaveBeenCalled();
  });

  it('search_whenSharedStoreFails_failsClosedBeforeProviderCost', async () => {
    const search = vi.fn(async () => RESPONSE);
    const service = build(
      {
        consume: async () => {
          throw new Error('redis details');
        },
      },
      { search },
    );

    await expect(
      service.search(WORKSPACE_ID, { version: 2, query: 'launch' }),
    ).rejects.toBeInstanceOf(SearchCapacityUnavailableError);
    expect(search).not.toHaveBeenCalled();
  });
});

function build(
  store: SearchRateLimitStore,
  delegate: SearchApplicationService,
): RateLimitedSearchService {
  return new RateLimitedSearchService(
    delegate,
    store,
    { nowMs: () => 123 },
    {
      workspaceLimit: 60,
      globalLimit: 1_000,
      windowMs: 60_000,
    },
  );
}

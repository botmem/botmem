import type { SearchResponse } from '@botmem-v2/contracts';
import type { SearchApplicationService } from '@botmem-v2/sdk';
import { describe, expect, it } from 'vitest';
import { buildSearchApi } from './search-api.js';
import {
  SearchCapacityUnavailableError,
  SearchRateLimitExceededError,
} from './search/rate-limited-search.js';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';

describe('search API capacity errors', () => {
  it('returns 429 and Retry-After for the shared search quota', async () => {
    const app = build(() => {
      throw new SearchRateLimitExceededError(60);
    });
    const response = await app.inject({
      method: 'POST',
      url: `/v2/workspaces/${WORKSPACE_ID}/search`,
      payload: { version: 2, query: 'launch' },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('60');
    expect(response.json()).toEqual({
      error: {
        code: 'search_rate_limited',
        message: 'Search capacity exceeded; retry later',
      },
    });
    await app.close();
  });

  it('returns retryable 503 when quota enforcement is unavailable', async () => {
    const app = build(() => {
      throw new SearchCapacityUnavailableError();
    });
    const response = await app.inject({
      method: 'POST',
      url: `/v2/workspaces/${WORKSPACE_ID}/search`,
      payload: { version: 2, query: 'launch' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('1');
    expect(response.json().error.code).toBe('search_capacity_unavailable');
    await app.close();
  });
});

function build(search: () => Promise<SearchResponse> | never) {
  const service: SearchApplicationService = { search };
  return buildSearchApi({
    search: service,
    workspaceAuthorizer: { authorize: async (workspaceId) => workspaceId },
  });
}

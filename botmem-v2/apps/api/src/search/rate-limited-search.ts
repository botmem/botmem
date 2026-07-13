import type { SearchRequestInput, SearchResponse } from '@botmem-v2/contracts';
import type { SearchApplicationService } from '@botmem-v2/sdk';
import { createHash } from 'node:crypto';

export interface SearchRateLimitStore {
  /** Atomically consumes one fixed-window token in the shared deployment store. */
  consume(input: {
    readonly key: string;
    readonly limit: number;
    readonly windowMs: number;
    readonly nowMs: number;
  }): Promise<boolean>;
}

export interface SearchRateLimitOptions {
  readonly workspaceLimit: number;
  readonly globalLimit: number;
  readonly windowMs: number;
}

/**
 * One shared cost boundary around the canonical application service. REST,
 * CLI, Web, and MCP therefore cannot drift into different search quotas.
 */
export class RateLimitedSearchService implements SearchApplicationService {
  constructor(
    private readonly delegate: SearchApplicationService,
    private readonly store: SearchRateLimitStore,
    private readonly clock: { nowMs(): number },
    private readonly options: SearchRateLimitOptions,
  ) {
    assertPositiveInteger(options.workspaceLimit, 'workspaceLimit');
    assertPositiveInteger(options.globalLimit, 'globalLimit');
    assertPositiveInteger(options.windowMs, 'windowMs');
    if (options.globalLimit < options.workspaceLimit) {
      throw new RangeError('globalLimit must not be lower than workspaceLimit');
    }
    if (options.windowMs > 86_400_000) {
      throw new RangeError('windowMs must not exceed one day');
    }
  }

  async search(workspaceId: string, input: SearchRequestInput): Promise<SearchResponse> {
    const nowMs = this.clock.nowMs();
    let globalAllowed: boolean;
    let workspaceAllowed: boolean;
    try {
      // Consume both on every attempt. This prevents rejected workspace bursts
      // from being invisible to the deployment-wide abuse ceiling.
      [globalAllowed, workspaceAllowed] = await Promise.all([
        this.store.consume({
          key: 'search:global',
          limit: this.options.globalLimit,
          windowMs: this.options.windowMs,
          nowMs,
        }),
        this.store.consume({
          key: `search:workspace:${workspaceKey(workspaceId)}`,
          limit: this.options.workspaceLimit,
          windowMs: this.options.windowMs,
          nowMs,
        }),
      ]);
    } catch {
      // Search can incur provider cost. Failing closed is safer than silently
      // disabling the shared quota when Redis is unavailable.
      throw new SearchCapacityUnavailableError();
    }
    if (!globalAllowed || !workspaceAllowed) {
      throw new SearchRateLimitExceededError(Math.ceil(this.options.windowMs / 1_000));
    }
    return this.delegate.search(workspaceId, input);
  }
}

export class SearchRateLimitExceededError extends Error {
  override readonly name = 'SearchRateLimitExceededError';

  constructor(readonly retryAfterSeconds: number) {
    super('search rate limit exceeded');
  }
}

export class SearchCapacityUnavailableError extends Error {
  override readonly name = 'SearchCapacityUnavailableError';

  constructor() {
    super('search capacity control unavailable');
  }
}

function workspaceKey(workspaceId: string): string {
  return createHash('sha256').update(workspaceId).digest('hex').slice(0, 32);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

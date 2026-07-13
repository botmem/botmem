import type { JsonValue } from '@botmem-v2/connector-domain';
import { OwnTracksConnectorError, OwnTracksProviderError } from './errors.js';
import { SafeOwnTracksHttpClient } from './http-client.js';
import type {
  OwnTracksBasicCredentials,
  OwnTracksClockPort,
  OwnTracksLocationApiPort,
  ValidatedOwnTracksEndpoint,
} from './ports.js';

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_POINTS_PER_PAGE = 50_000;
const MAX_ATTEMPTS = 3;
const MAX_JSON_DEPTH = 32;

function asJsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > MAX_JSON_DEPTH) throw new OwnTracksProviderError('invalid_response', false);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((item) => asJsonValue(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, asJsonValue(item, depth + 1)]),
    );
  }
  return null;
}

function extractPoints(body: string): readonly JsonValue[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    throw new OwnTracksProviderError('invalid_response', false);
  }
  let points: unknown;
  if (Array.isArray(decoded)) {
    points = decoded;
  } else if (decoded && typeof decoded === 'object') {
    const record = decoded as Record<string, unknown>;
    points = record.data ?? record.locations;
  }
  if (!Array.isArray(points) || points.length > MAX_POINTS_PER_PAGE) {
    throw new OwnTracksProviderError('invalid_response', false);
  }
  return Object.freeze(points.map((point) => asJsonValue(point)));
}

export class OwnTracksRecorderApi implements OwnTracksLocationApiPort {
  public constructor(
    private readonly http: SafeOwnTracksHttpClient,
    private readonly clock: OwnTracksClockPort,
  ) {}

  public async listLocations(
    endpoint: ValidatedOwnTracksEndpoint,
    credentials: OwnTracksBasicCredentials,
    range: { readonly fromEpochSeconds: number; readonly toEpochSeconds: number },
    signal?: AbortSignal,
  ) {
    const url = new URL(endpoint.endpoint);
    url.searchParams.set('from', new Date(range.fromEpochSeconds * 1000).toISOString());
    url.searchParams.set('to', new Date(range.toEpochSeconds * 1000).toISOString());
    url.searchParams.set('format', 'json');

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      let response;
      try {
        response = await this.http.get({
          endpoint,
          url,
          credentials,
          timeoutMs: REQUEST_TIMEOUT_MS,
          maxResponseBytes: MAX_RESPONSE_BYTES,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        const retryable =
          (error instanceof OwnTracksProviderError || error instanceof OwnTracksConnectorError) &&
          error.retryable;
        if (!retryable || attempt === MAX_ATTEMPTS - 1) throw error;
        await this.clock.sleep(100 * 2 ** attempt, signal);
        continue;
      }
      if (response.status >= 200 && response.status < 300) {
        return Object.freeze({ points: extractPoints(response.body) });
      }
      if (response.status === 401 || response.status === 403) {
        throw new OwnTracksProviderError('auth_failed', false);
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === MAX_ATTEMPTS - 1) {
        throw new OwnTracksProviderError(
          response.status >= 400 && response.status < 500 ? 'invalid_response' : 'unavailable',
          retryable,
        );
      }
      await this.clock.sleep(100 * 2 ** attempt, signal);
    }
    throw new OwnTracksProviderError('unavailable', true);
  }
}

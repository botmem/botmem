import {
  OwnTracksProviderError,
  OwnTracksRedirectError,
  OwnTracksTransportError,
} from './errors.js';
import { OwnTracksEndpointPolicy } from './endpoint-policy.js';
import type {
  OwnTracksBasicCredentials,
  PinnedHttpsResponse,
  PinnedHttpsTransportPort,
  ValidatedOwnTracksEndpoint,
} from './ports.js';

const MAX_REDIRECTS = 5;

function authorizationHeader(credentials: OwnTracksBasicCredentials): string {
  if (
    credentials.username.length === 0 ||
    credentials.username.length > 4096 ||
    credentials.username.includes(':') ||
    credentials.password.length > 12_288
  ) {
    throw new OwnTracksProviderError('auth_failed', false);
  }
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, 'utf8').toString('base64')}`;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export class SafeOwnTracksHttpClient {
  public constructor(
    private readonly endpointPolicy: OwnTracksEndpointPolicy,
    private readonly transport: PinnedHttpsTransportPort,
  ) {}

  public async get(input: {
    readonly endpoint: ValidatedOwnTracksEndpoint;
    readonly url: URL;
    readonly credentials: OwnTracksBasicCredentials;
    readonly timeoutMs: number;
    readonly maxResponseBytes: number;
    readonly signal?: AbortSignal;
  }): Promise<PinnedHttpsResponse> {
    const deadlineAt = Date.now() + input.timeoutMs;
    const deadline = new AbortController();
    const abortFromCaller = () => deadline.abort();
    if (input.signal?.aborted) deadline.abort();
    input.signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timer = setTimeout(() => deadline.abort(), input.timeoutMs);
    try {
      let current = input.url;
      const authorization = authorizationHeader(input.credentials);
      for (let redirects = 0; ; redirects += 1) {
        if (deadline.signal.aborted) throw new OwnTracksProviderError('unavailable', false);
        if (redirects > MAX_REDIRECTS) throw new OwnTracksRedirectError();
        const pinned = await this.endpointPolicy.resolveAndPin(
          current,
          input.endpoint.allowedPorts,
          deadline.signal,
        );
        if (deadline.signal.aborted) throw new OwnTracksProviderError('unavailable', false);
        let response: PinnedHttpsResponse | null = null;
        let lastFailure: unknown = null;
        for (const address of pinned.addresses) {
          if (deadline.signal.aborted) break;
          try {
            response = await this.transport.get({
              url: pinned.url,
              address,
              headers: Object.freeze({
                accept: 'application/json',
                authorization,
              }),
              timeoutMs: Math.max(1, deadlineAt - Date.now()),
              maxResponseBytes: input.maxResponseBytes,
              signal: deadline.signal,
            });
            break;
          } catch (error) {
            lastFailure = error;
            if (
              error instanceof OwnTracksTransportError &&
              error.failure === 'response_too_large'
            ) {
              throw new OwnTracksProviderError('response_too_large', false);
            }
          }
        }
        if (!response) {
          throw new OwnTracksProviderError(
            'unavailable',
            !deadline.signal.aborted &&
              (!(lastFailure instanceof OwnTracksTransportError) ||
                lastFailure.failure === 'network' ||
                lastFailure.failure === 'timeout'),
          );
        }
        if (!isRedirect(response.status)) return response;
        current = this.endpointPolicy.redirectLocation(
          current,
          response.headers.location,
          input.endpoint.allowedPorts,
        );
      }
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abortFromCaller);
    }
  }
}

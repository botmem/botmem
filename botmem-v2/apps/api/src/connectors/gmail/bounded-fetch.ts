import { GmailProviderError } from './errors.js';
import type { BoundedHttpClientPort, BoundedHttpRequest, BoundedHttpResponse } from './ports.js';

const MAX_TIMEOUT_MS = 120_000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Concrete Google HTTP adapter with hard redirect, deadline, and body bounds. */
export class FetchGmailBoundedHttpClient implements BoundedHttpClientPort {
  public constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  public async request(request: BoundedHttpRequest): Promise<BoundedHttpResponse> {
    validateBound(request.timeoutMs, MAX_TIMEOUT_MS);
    validateBound(request.maxResponseBytes, MAX_BODY_BYTES);
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(request.signal?.reason);
    if (request.signal?.aborted) onExternalAbort();
    request.signal?.addEventListener('abort', onExternalAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        redirect: 'manual',
        signal: controller.signal,
      });
      const declaredLength = Number(response.headers.get('content-length') ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > request.maxResponseBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new GmailProviderError('response_too_large', response.status);
      }
      return Object.freeze({
        status: response.status,
        headers: Object.freeze({}),
        body: await readBoundedUtf8(response, request.maxResponseBytes),
      });
    } catch (error) {
      if (error instanceof GmailProviderError) throw error;
      throw new GmailProviderError('unavailable');
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}

function validateBound(value: number, maximum: number): void {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new GmailProviderError('invalid_response');
  }
}

async function readBoundedUtf8(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new GmailProviderError('response_too_large', response.status);
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new GmailProviderError('invalid_response', response.status);
  }
}

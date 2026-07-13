import { OutlookProviderError } from './errors.js';
import type {
  OutlookBoundedHttpClientPort,
  OutlookBoundedHttpRequest,
  OutlookBoundedHttpResponse,
} from './ports.js';

function validatedBound(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new OutlookProviderError('invalid_response');
  }
  if (label === 'timeout' && value > 120_000) {
    throw new OutlookProviderError('invalid_response');
  }
  if (label === 'body' && value > 32 * 1024 * 1024) {
    throw new OutlookProviderError('invalid_response');
  }
  return value;
}

/** Concrete HTTP adapter with hard redirect, deadline, and body-size bounds. */
export class FetchOutlookBoundedHttpClient implements OutlookBoundedHttpClientPort {
  public constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  public async request(request: OutlookBoundedHttpRequest): Promise<OutlookBoundedHttpResponse> {
    const timeoutMs = validatedBound(request.timeoutMs, 'timeout');
    const maxResponseBytes = validatedBound(request.maxResponseBytes, 'body');
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener('abort', onExternalAbort, { once: true });
    if (request.signal?.aborted) onExternalAbort();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        redirect: 'manual',
        signal: controller.signal,
      });
      const declaredLength = response.headers.get('content-length');
      if (declaredLength !== null) {
        const parsedLength = Number(declaredLength);
        if (Number.isFinite(parsedLength) && parsedLength > maxResponseBytes) {
          await response.body?.cancel().catch(() => undefined);
          throw new OutlookProviderError('response_too_large', response.status);
        }
      }
      const body = await this.readBounded(response, maxResponseBytes);
      return Object.freeze({ status: response.status, headers: Object.freeze({}), body });
    } catch (error) {
      if (error instanceof OutlookProviderError) throw error;
      throw new OutlookProviderError('unavailable');
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  private async readBounded(response: Response, maximumBytes: number): Promise<string> {
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
        throw new OutlookProviderError('response_too_large', response.status);
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
      throw new OutlookProviderError('invalid_response', response.status);
    }
  }
}

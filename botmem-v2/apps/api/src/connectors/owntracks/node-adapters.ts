import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { OwnTracksTransportError } from './errors.js';
import type {
  OwnTracksClockPort,
  OwnTracksDnsPort,
  OwnTracksHashPort,
  PinnedHttpsRequest,
  PinnedHttpsResponse,
  PinnedHttpsTransportPort,
} from './ports.js';

export class NodeOwnTracksDns implements OwnTracksDnsPort {
  public async resolveAll(hostname: string, signal?: AbortSignal) {
    if (signal?.aborted) throw signal.reason;
    const resolution = lookup(hostname, { all: true, verbatim: true });
    const result = signal ? await rejectWhenAborted(resolution, signal) : await resolution;
    return Object.freeze(
      result.map((entry) =>
        Object.freeze({ address: entry.address, family: entry.family as 4 | 6 }),
      ),
    );
  }
}

async function rejectWhenAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

export class NodeOwnTracksHash implements OwnTracksHashPort {
  public async sha256Hex(value: string): Promise<string> {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }
}

export class NodeOwnTracksClock implements OwnTracksClockPort {
  public now(): string {
    return new Date().toISOString();
  }

  public async sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const complete = () => {
        signal?.removeEventListener('abort', abort);
        resolve();
      };
      const timer = setTimeout(complete, milliseconds);
      const abort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
}

function normalizeResponseHeaders(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): Readonly<Record<string, string | undefined>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [
        name.toLowerCase(),
        typeof value === 'string' ? value : value?.[0],
      ]),
    ),
  );
}

export class NodePinnedHttpsTransport implements PinnedHttpsTransportPort {
  public async get(input: PinnedHttpsRequest): Promise<PinnedHttpsResponse> {
    return await new Promise<PinnedHttpsResponse>((resolve, reject) => {
      const hostname = input.url.hostname.startsWith('[')
        ? input.url.hostname.slice(1, -1)
        : input.url.hostname;
      let settled = false;
      const finish = (operation: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        operation();
      };
      const options = {
        protocol: 'https:',
        method: 'GET',
        hostname,
        port: input.url.port ? Number(input.url.port) : 443,
        path: `${input.url.pathname}${input.url.search}`,
        headers: { ...input.headers, host: input.url.host },
        agent: false,
        family: input.address.family,
        autoSelectFamily: false,
        lookup: (
          _lookupHostname: string,
          _options: unknown,
          callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void,
        ) => callback(null, input.address.address, input.address.family),
        ...(isIP(hostname) ? {} : { servername: hostname }),
        ...(input.signal ? { signal: input.signal } : {}),
      } as const;
      const client = httpsRequest(options, (response) => {
        response.on('error', (error) => {
          finish(() =>
            reject(
              error instanceof OwnTracksTransportError
                ? error
                : new OwnTracksTransportError('network'),
            ),
          );
        });
        const declaredLength = Number(response.headers['content-length'] ?? 0);
        if (Number.isFinite(declaredLength) && declaredLength > input.maxResponseBytes) {
          response.destroy(new OwnTracksTransportError('response_too_large'));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buffer.length;
          if (total > input.maxResponseBytes) {
            response.destroy(new OwnTracksTransportError('response_too_large'));
            return;
          }
          chunks.push(buffer);
        });
        response.on('end', () => {
          finish(() =>
            resolve(
              Object.freeze({
                status: response.statusCode ?? 0,
                headers: normalizeResponseHeaders(response.headers),
                body: Buffer.concat(chunks, total).toString('utf8'),
              }),
            ),
          );
        });
      });
      client.maxHeadersCount = 100;
      client.on('error', (error) => {
        finish(() =>
          reject(
            error instanceof OwnTracksTransportError
              ? error
              : new OwnTracksTransportError('network'),
          ),
        );
      });
      const deadline = setTimeout(
        () => client.destroy(new OwnTracksTransportError('timeout')),
        input.timeoutMs,
      );
      client.end();
    });
  }
}

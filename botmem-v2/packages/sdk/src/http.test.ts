import { describe, expect, it } from 'vitest';
import type { SearchResponse } from '@botmem-v2/contracts';
import {
  ConnectionsApiClient,
  FetchHttpTransport,
  SearchApiClient,
  type HttpRequest,
  type HttpTransport,
} from './http.js';

const WORKSPACE_ID = '8e5ffcc7-8e8f-4aaa-9c77-b87a979c60cf';
const RESPONSE: SearchResponse = {
  version: 2,
  queryId: '52b2ecba-3d9a-4c9d-89c8-e06c7916eec1',
  items: [],
  coverage: { partial: false, lanes: [] },
  found: 0,
  tookMs: 1,
};

describe('FetchHttpTransport', () => {
  it('request_preservesNativeFetchReceiverAndOmitsBodyHeadersForGet', async () => {
    let init: RequestInit | undefined;
    const fetch = function (this: unknown, _input: string | URL | Request, request?: RequestInit) {
      expect(this).toBe(globalThis);
      init = request;
      return Promise.resolve(
        new Response(JSON.stringify({ version: 2, items: [] }), { status: 200 }),
      );
    } as typeof globalThis.fetch;
    const transport = new FetchHttpTransport({ baseUrl: 'https://api.botmem.test', fetch });

    await transport.request({ method: 'GET', path: '/v2/connections', headers: {} });

    expect(init?.body).toBeUndefined();
    expect(init?.headers).toEqual({});
  });

  it('request_whenDeadlineExpires_abortsUnderlyingFetch', async () => {
    let aborted = false;
    const fetch: typeof globalThis.fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          },
          { once: true },
        );
      });
    const transport = new FetchHttpTransport({
      baseUrl: 'https://api.botmem.test',
      fetch,
      timeoutMs: 5,
    });

    await expect(
      transport.request({
        method: 'POST',
        path: '/v2/search',
        headers: {},
        body: {},
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted).toBe(true);
  });
});

describe('ConnectionsApiClient', () => {
  it('listConnections_usesTheCanonicalPathAndBearerWithoutARequestBody', async () => {
    let received: HttpRequest | undefined;
    const client = new ConnectionsApiClient({
      transport: {
        request: async (request) => {
          received = request;
          return { status: 200, body: { version: 2, items: [] } };
        },
      },
      authentication: { kind: 'bearer', accessToken: 'connection-token' },
    });

    await expect(client.listConnections(WORKSPACE_ID)).resolves.toEqual({
      version: 2,
      items: [],
    });
    expect(received).toEqual({
      method: 'GET',
      path: `/v2/workspaces/${WORKSPACE_ID}/connections`,
      headers: { authorization: 'Bearer connection-token' },
    });
  });

  it('connectOwnTracks_rejectsUnsafeEndpointBeforeCallingTransport', async () => {
    let called = false;
    const client = new ConnectionsApiClient({
      transport: {
        request: async () => {
          called = true;
          return { status: 500, body: null };
        },
      },
      authentication: { kind: 'ambient-session' },
    });

    await expect(
      client.connectOwnTracks(WORKSPACE_ID, {
        version: 2,
        endpoint: 'http://127.0.0.1:8083',
        username: 'owner',
        password: 'secret',
      }),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });
});

describe('SearchApiClient authentication', () => {
  it('search_whenBearerMode_addsAuthorizationHeader', async () => {
    let received: HttpRequest | undefined;
    const transport: HttpTransport = {
      request: async (request) => {
        received = request;
        return { status: 200, body: RESPONSE };
      },
    };
    const client = new SearchApiClient({
      transport,
      authentication: { kind: 'bearer', accessToken: 'opaque-token' },
    });

    await client.search(WORKSPACE_ID, { version: 2, query: 'launch' });

    expect(received?.headers).toEqual({ authorization: 'Bearer opaque-token' });
  });

  it('search_whenAmbientSessionMode_neverAddsAuthorizationHeader', async () => {
    let received: HttpRequest | undefined;
    const transport: HttpTransport = {
      request: async (request) => {
        received = request;
        return { status: 200, body: RESPONSE };
      },
    };
    const client = new SearchApiClient({
      transport,
      authentication: { kind: 'ambient-session' },
    });

    await client.search(WORKSPACE_ID, { version: 2, query: 'launch' });

    expect(received?.headers).toEqual({});
  });
});

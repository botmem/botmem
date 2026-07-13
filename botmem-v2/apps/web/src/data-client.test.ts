import type { SearchResponse } from '@botmem-v2/contracts';
import { describe, expect, it, vi } from 'vitest';
import { BrowserBotmemClient } from './data-client.js';

const WORKSPACE_ID = '8e5ffcc7-8e8f-4aaa-9c77-b87a979c60cf';
const RESPONSE: SearchResponse = {
  version: 2,
  queryId: '52b2ecba-3d9a-4c9d-89c8-e06c7916eec1',
  items: [],
  coverage: { partial: false, lanes: [] },
  found: 0,
  tookMs: 2,
};

describe('BrowserBotmemClient', () => {
  it('reads deployable release metadata from the runtime API', async () => {
    const releases = {
      version: 2 as const,
      apiBaseUrl: 'https://api.botmem.test/',
      macos: { available: false as const },
      cli: {
        available: true as const,
        url: 'https://github.com/botmem/botmem/releases/download/botmem-v2-v2.4.1/botmem-v2-cli-2.4.1.tgz',
        releaseVersion: '2.4.1',
        sha256: 'a'.repeat(64),
      },
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(JSON.stringify(releases), { status: 200 }));
    const client = new BrowserBotmemClient({ baseUrl: 'https://app.botmem.test', fetch });

    await expect(client.getPublicReleases()).resolves.toEqual(releases);
    expect(fetch).toHaveBeenCalledWith(
      'https://app.botmem.test/v2/public/releases',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('reads the public price from the runtime API rather than a static bundle value', async () => {
    const price = {
      version: 2 as const,
      currency: 'usd',
      unitAmountMinor: 1_900,
      interval: 'month' as const,
      intervalCount: 1,
      checkoutAvailable: true as const,
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(JSON.stringify(price), { status: 200 }));
    const client = new BrowserBotmemClient({ baseUrl: 'https://app.botmem.test', fetch });

    await expect(client.getBillingPrice()).resolves.toEqual(price);
    expect(fetch).toHaveBeenCalledWith(
      'https://app.botmem.test/v2/billing/price',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('getSession_preservesTheNativeFetchReceiver', async () => {
    const receiverCheckingFetch = function (this: unknown): Promise<Response> {
      expect(this).toBe(globalThis);
      return Promise.resolve(
        new Response(JSON.stringify({ version: 2, workspaceId: WORKSPACE_ID }), { status: 200 }),
      );
    } as typeof globalThis.fetch;
    const client = new BrowserBotmemClient({
      baseUrl: 'https://app.botmem.test',
      fetch: receiverCheckingFetch,
    });

    await expect(client.getSession()).resolves.toEqual({
      version: 2,
      workspaceId: WORKSPACE_ID,
    });
  });

  it('getSession_usesAmbientCookieAndNeverRequestsBrowserReadableToken', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ version: 2, workspaceId: WORKSPACE_ID }), {
        status: 200,
      }),
    );
    const client = new BrowserBotmemClient({ baseUrl: 'https://app.botmem.test', fetch });

    await expect(client.getSession()).resolves.toEqual({
      version: 2,
      workspaceId: WORKSPACE_ID,
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://app.botmem.test/v2/session',
      expect.objectContaining({ credentials: 'include' }),
    );
    const headers = fetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers).not.toHaveProperty('authorization');
  });

  it('search_usesAmbientCookieWithoutAuthorizationHeader', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(JSON.stringify(RESPONSE), { status: 200 }));
    const client = new BrowserBotmemClient({ baseUrl: 'https://app.botmem.test', fetch });

    await expect(client.search(WORKSPACE_ID, { version: 2, query: 'launch' })).resolves.toEqual(
      RESPONSE,
    );

    const init = fetch.mock.calls[0]?.[1];
    expect(init?.credentials).toBe('include');
    expect(init?.headers).not.toHaveProperty('authorization');
  });

  it('emailLogin_usesVersionedBodiesAndRequiresA204Completion', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            version: 2,
            status: 'accepted',
            message: 'If the account exists, a sign-in link has been sent',
          }),
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new BrowserBotmemClient({ baseUrl: 'https://app.botmem.test', fetch });
    const completionController = new AbortController();

    await client.startEmailLogin({ version: 2, email: 'me@example.com' });
    await client.completeEmailLogin(
      'bml_v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      completionController.signal,
    );

    expect(fetch.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        credentials: 'include',
        body: JSON.stringify({ version: 2, email: 'me@example.com' }),
      }),
    );
    expect(fetch.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        credentials: 'include',
        body: JSON.stringify({ token: 'bml_v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
        signal: completionController.signal,
      }),
    );
  });

  it('sends Stripe completion capability only in a POST body', async () => {
    const sessionId = 'cs_test_browserstatus123456';
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ version: 2, status: 'pending' }), { status: 200 }),
      );
    const client = new BrowserBotmemClient({ baseUrl: 'https://app.botmem.test', fetch });

    await client.getBillingCheckoutStatus(sessionId);

    expect(fetch).toHaveBeenCalledWith(
      'https://app.botmem.test/v2/billing/checkout/status',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ sessionId }),
      }),
    );
    expect(fetch.mock.calls[0]?.[0]).not.toContain(sessionId);
  });

  it('accountOwnerOperations_useAmbientSessionAndVersionedRoutes', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ version: 2, items: [] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            version: 2,
            job: {
              version: 2,
              jobId: '880a97f8-d069-4031-a26a-aa56baeb465e',
              kind: 'deletion',
              state: 'queued',
              requestedAt: '2026-07-13T12:00:00.000Z',
              attempts: 0,
              availableUntil: null,
              completedAt: null,
              failureCode: null,
              localDelete: { delivered: 0, unreachable: 0, pending: 0 },
            },
          }),
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new BrowserBotmemClient({ baseUrl: 'https://app.botmem.test', fetch });

    await client.listPersonalAccessTokens(WORKSPACE_ID);
    await client.requestWorkspaceDeletion(WORKSPACE_ID, `DELETE ${WORKSPACE_ID}`);
    await client.signOut();

    expect(fetch.mock.calls.map(([url, init]) => `${init?.method} ${url}`)).toEqual([
      `GET https://app.botmem.test/v2/workspaces/${WORKSPACE_ID}/pats`,
      `POST https://app.botmem.test/v2/workspaces/${WORKSPACE_ID}/lifecycle/deletion`,
      'DELETE https://app.botmem.test/v2/session',
    ]);
    for (const [, init] of fetch.mock.calls) {
      expect(init?.credentials).toBe('include');
      expect(init?.headers).not.toHaveProperty('authorization');
    }
  });
});

import { describe, expect, it, vi } from 'vitest';
import { FetchOutlookBoundedHttpClient, OutlookProviderError } from './index.js';

describe('FetchOutlookBoundedHttpClient', () => {
  it('request_forwardsOnlySpecifiedDataAndDisablesRedirectFollowing', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-length': '11', 'set-cookie': 'must-not-leave-adapter' },
      }),
    );
    const client = new FetchOutlookBoundedHttpClient(fetchImpl);

    const result = await client.request({
      method: 'POST',
      url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'redacted-fixture',
      timeoutMs: 10_000,
      maxResponseBytes: 64_000,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      expect.objectContaining({ method: 'POST', redirect: 'manual' }),
    );
    expect(result).toEqual({ status: 200, headers: {}, body: '{"ok":true}' });
  });

  it('request_whenDeclaredOrStreamedBodyExceedsLimit_failsWithoutLeakingBody', async () => {
    const declared = new FetchOutlookBoundedHttpClient(
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response('secret-provider-body', {
          status: 200,
          headers: { 'content-length': '9999' },
        }),
      ),
    );
    await expect(
      declared.request({
        method: 'GET',
        url: 'https://graph.microsoft.com/v1.0/me',
        headers: { authorization: 'Bearer secret-token' },
        timeoutMs: 10_000,
        maxResponseBytes: 8,
      }),
    ).rejects.toEqual(
      expect.objectContaining<OutlookProviderError>({ failure: 'response_too_large' }),
    );

    const streamed = new FetchOutlookBoundedHttpClient(
      vi.fn<typeof fetch>().mockResolvedValue(new Response('0123456789', { status: 200 })),
    );
    const rejection = streamed.request({
      method: 'GET',
      url: 'https://graph.microsoft.com/v1.0/me',
      headers: { authorization: 'Bearer secret-token' },
      timeoutMs: 10_000,
      maxResponseBytes: 4,
    });
    await expect(rejection).rejects.toEqual(
      expect.objectContaining<OutlookProviderError>({ failure: 'response_too_large' }),
    );
    await expect(rejection).rejects.not.toThrow(/secret|012345|graph\.microsoft/i);
  });

  it('request_whenDeadlineExpires_abortsFetchAndReturnsSanitizedUnavailableError', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('raw timeout detail')), {
            once: true,
          });
        }),
    );
    const client = new FetchOutlookBoundedHttpClient(fetchImpl);

    const rejection = client.request({
      method: 'GET',
      url: 'https://graph.microsoft.com/v1.0/me',
      headers: {},
      timeoutMs: 1,
      maxResponseBytes: 1024,
    });
    await expect(rejection).rejects.toEqual(
      expect.objectContaining<OutlookProviderError>({ failure: 'unavailable' }),
    );
    await expect(rejection).rejects.not.toThrow(/raw timeout|graph\.microsoft/i);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { FetchGmailBoundedHttpClient, GmailProviderError } from './index.js';

describe('FetchGmailBoundedHttpClient', () => {
  it('request_disablesRedirectsAndReturnsOnlyBoundedBody', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-length': '11', 'set-cookie': 'discard-me' },
      }),
    );
    const client = new FetchGmailBoundedHttpClient(fetchImpl);

    const result = await client.request({
      method: 'GET',
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
      headers: { authorization: 'Bearer secret' },
      timeoutMs: 10_000,
      maxResponseBytes: 64_000,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: 'manual' }),
    );
    expect(result).toEqual({ status: 200, headers: {}, body: '{"ok":true}' });
  });

  it('request_whenDeclaredOrStreamedBodyExceedsLimit_failsSanitized', async () => {
    const declared = new FetchGmailBoundedHttpClient(
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response('provider-secret', {
          status: 200,
          headers: { 'content-length': '9999' },
        }),
      ),
    );
    await expect(
      declared.request({
        method: 'GET',
        url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
        headers: {},
        timeoutMs: 10_000,
        maxResponseBytes: 8,
      }),
    ).rejects.toMatchObject({ failure: 'response_too_large' });

    const streamed = new FetchGmailBoundedHttpClient(
      vi.fn<typeof fetch>().mockResolvedValue(new Response('0123456789', { status: 200 })),
    );
    const rejection = streamed.request({
      method: 'GET',
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
      headers: {},
      timeoutMs: 10_000,
      maxResponseBytes: 4,
    });
    await expect(rejection).rejects.toMatchObject({ failure: 'response_too_large' });
    await expect(rejection).rejects.not.toThrow(/012345|provider-secret|gmail\.googleapis/i);
  });

  it('request_whenDeadlineExpires_abortsAndSanitizesTransportError', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('raw timeout')), {
            once: true,
          });
        }),
    );
    const client = new FetchGmailBoundedHttpClient(fetchImpl);

    const rejection = client.request({
      method: 'GET',
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
      headers: {},
      timeoutMs: 1,
      maxResponseBytes: 1024,
    });

    await expect(rejection).rejects.toEqual(
      expect.objectContaining<GmailProviderError>({ failure: 'unavailable' }),
    );
    await expect(rejection).rejects.not.toThrow(/raw timeout|gmail\.googleapis/i);
  });
});

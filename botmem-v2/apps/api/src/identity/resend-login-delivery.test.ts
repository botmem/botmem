import { describe, expect, it, vi } from 'vitest';
import { ResendLoginDelivery } from './resend-login-delivery.js';

describe('ResendLoginDelivery', () => {
  it('sendsABoundedEmailWithoutExposingTheKeyOutsideAuthorization', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ id: 'email-1' }), { status: 200 }));
    const delivery = new ResendLoginDelivery({
      apiKey: 're_123456789_test',
      from: 'Botmem <login@botmem.example>',
      fetch,
    });

    await delivery.deliverSignInLink({
      email: 'owner@example.com',
      url: 'https://app.botmem.example/#loginToken=bml_v2.secret&workspaceId=workspace',
      expiresAt: '2026-07-13T16:00:00.000Z',
    });

    const init = fetch.mock.calls[0]?.[1];
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.resend.com/emails');
    expect(init?.headers).toEqual(
      expect.objectContaining({ authorization: 'Bearer re_123456789_test' }),
    );
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      from: 'Botmem <login@botmem.example>',
      to: ['owner@example.com'],
      subject: 'Your Botmem sign-in link',
    });
    expect(String(body['html'])).toContain('https://app.botmem.example/#loginToken');
    expect(JSON.stringify(body)).not.toContain('re_123456789_test');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('failsClosedOnProviderErrorsAndUnsafeConfiguration', async () => {
    expect(() => new ResendLoginDelivery({ apiKey: 'bad', from: 'login@botmem.example' })).toThrow(
      'API key',
    );
    const delivery = new ResendLoginDelivery({
      apiKey: 're_123456789_test',
      from: 'login@botmem.example',
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 429 })),
    });
    await expect(
      delivery.deliverSignInLink({
        email: 'owner@example.com',
        url: 'https://app.botmem.example/#loginToken=secret',
        expiresAt: '2026-07-13T16:00:00.000Z',
      }),
    ).rejects.toThrow('rejected');
  });

  it.each([
    'http://mail.example.test/emails',
    'ftp://127.0.0.1/emails',
    'https://operator:secret@mail.example.test/emails',
    'https://mail.example.test/emails#ignored-fragment',
  ])('rejectsUnsafeProviderEndpointConfiguration: %s', (endpoint) => {
    expect(
      () =>
        new ResendLoginDelivery({
          apiKey: 're_123456789_test',
          from: 'login@botmem.example',
          endpoint,
        }),
    ).toThrow('credential-free HTTPS');
  });
});

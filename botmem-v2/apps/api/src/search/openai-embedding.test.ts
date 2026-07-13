import { describe, expect, it, vi } from 'vitest';
import { OpenAiEmbeddingError, OpenAiEmbeddingProvider } from './openai-embedding.js';

const vector = Array.from({ length: 768 }, (_, index) => index / 768);

describe('OpenAiEmbeddingProvider', () => {
  it('requestsThePinnedDimensionsAndValidatesTheReturnedProfile', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          object: 'list',
          model: 'text-embedding-3-small',
          data: [{ object: 'embedding', index: 0, embedding: vector }],
        }),
        { status: 200 },
      ),
    );
    const provider = new OpenAiEmbeddingProvider({
      apiKey: 'sk-12345678901234567890',
      fetch,
    });

    await expect(provider.embed('رسالة launch', new AbortController().signal)).resolves.toEqual({
      profileId: 'hosted-multilingual-v1',
      modelRevision: 'text-embedding-3-small',
      values: vector,
    });
    const init = fetch.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'text-embedding-3-small',
      input: ['رسالة launch'],
      dimensions: 768,
      encoding_format: 'float',
    });
    expect(init?.headers).toEqual(
      expect.objectContaining({
        authorization: 'Bearer sk-12345678901234567890',
      }),
    );
    expect(String(init?.body)).not.toContain('sk-12345678901234567890');
  });

  it('failsClosedOnDimensionDriftAndNeverReturnsPartialBatches', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: 'text-embedding-3-small',
          data: [{ index: 0, embedding: vector.slice(1) }],
        }),
        { status: 200 },
      ),
    );
    const provider = new OpenAiEmbeddingProvider({
      apiKey: 'sk-12345678901234567890',
      fetch,
    });

    await expect(provider.embed('launch', new AbortController().signal)).rejects.toMatchObject({
      code: 'embedding_response_invalid',
    });
    await expect(provider.embedMany([], new AbortController().signal)).rejects.toBeInstanceOf(
      OpenAiEmbeddingError,
    );
  });

  it('propagatesCallerCancellationAsAReasonCode', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
      throw new Error('unreachable');
    });
    const provider = new OpenAiEmbeddingProvider({
      apiKey: 'sk-12345678901234567890',
      fetch,
    });
    const controller = new AbortController();
    const promise = provider.embed('launch', controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'embedding_cancelled' });
  });

  it.each([
    'http://embedding.example.test/v1/embeddings',
    'ftp://127.0.0.1/v1/embeddings',
    'https://operator:secret@embedding.example.test/v1/embeddings',
    'https://embedding.example.test/v1/embeddings#ignored-fragment',
  ])('rejectsUnsafeProviderEndpointConfiguration: %s', (endpoint) => {
    expect(
      () =>
        new OpenAiEmbeddingProvider({
          apiKey: 'sk-12345678901234567890',
          endpoint,
        }),
    ).toThrow('credential-free HTTPS');
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RerankService } from '../rerank.service';
import { ConfigService } from '../../config/config.service';

function createConfig(overrides: Partial<ConfigService> = {}): ConfigService {
  return {
    rerankerBackend: 'none',
    rerankerUrl: '',
    jinaApiKey: '',
    ollamaBaseUrl: 'http://localhost:11434',
    ollamaRerankerModel: 'qwen3:0.6b',
    ...overrides,
  } as ConfigService;
}

describe('RerankService', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  describe('onModuleInit', () => {
    it('falls back to none when jina backend has no API key', () => {
      const service = new RerankService(
        createConfig({
          rerankerBackend: 'jina' as ConfigService['rerankerBackend'],
          jinaApiKey: '',
        }),
      );
      service.onModuleInit();
      expect((service as unknown as { backend: string }).backend).toBe('none');
    });

    it('falls back to ollama when tei backend has no URL', () => {
      const service = new RerankService(
        createConfig({
          rerankerBackend: 'tei' as ConfigService['rerankerBackend'],
          rerankerUrl: '',
        }),
      );
      service.onModuleInit();
      expect((service as unknown as { backend: string }).backend).toBe('ollama');
    });

    it('keeps tei backend when URL is set', () => {
      const service = new RerankService(
        createConfig({
          rerankerBackend: 'tei' as ConfigService['rerankerBackend'],
          rerankerUrl: 'http://localhost:8081',
        }),
      );
      service.onModuleInit();
      expect((service as unknown as { backend: string }).backend).toBe('tei');
    });

    it('keeps jina backend when API key is set', () => {
      const service = new RerankService(
        createConfig({
          rerankerBackend: 'jina' as ConfigService['rerankerBackend'],
          jinaApiKey: 'test-key',
        }),
      );
      service.onModuleInit();
      expect((service as unknown as { backend: string }).backend).toBe('jina');
    });
  });

  describe('rerank', () => {
    it('returns empty array for empty documents', async () => {
      const service = new RerankService(createConfig());
      const result = await service.rerank('query', []);
      expect(result).toEqual([]);
    });

    it('returns zeros for none backend', async () => {
      const service = new RerankService(
        createConfig({ rerankerBackend: 'none' as ConfigService['rerankerBackend'] }),
      );
      const result = await service.rerank('query', ['doc1', 'doc2']);
      expect(result).toEqual([0, 0]);
    });

    it('returns zeros on error', async () => {
      const service = new RerankService(
        createConfig({
          rerankerBackend: 'tei' as ConfigService['rerankerBackend'],
          rerankerUrl: 'http://localhost:8081',
        }),
      );
      service.onModuleInit();
      fetchSpy.mockRejectedValue(new Error('network error'));

      const result = await service.rerank('query', ['doc1']);
      expect(result).toEqual([0]);
    });
  });

  describe('tei backend', () => {
    let service: RerankService;

    beforeEach(() => {
      service = new RerankService(
        createConfig({
          rerankerBackend: 'tei' as ConfigService['rerankerBackend'],
          rerankerUrl: 'http://localhost:8081',
        }),
      );
      service.onModuleInit();
    });

    it('calls TEI endpoint and maps scores by index', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            { index: 1, score: 0.3 },
            { index: 0, score: 0.9 },
          ]),
      });

      const scores = await service.rerank('query', ['doc1', 'doc2']);

      expect(scores).toEqual([0.9, 0.3]);
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:8081/rerank',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('throws on non-ok response', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal error'),
      });

      // Error gets caught by rerank() outer try-catch, returns zeros
      const scores = await service.rerank('query', ['doc1']);
      expect(scores).toEqual([0]);
    });
  });

  describe('ollama backend', () => {
    let service: RerankService;

    beforeEach(() => {
      service = new RerankService(
        createConfig({ rerankerBackend: 'ollama' as ConfigService['rerankerBackend'] }),
      );
      service.onModuleInit();
    });

    it('parses JSON array from response', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            message: { content: '[0.9, 0.3, 0.5]' },
          }),
      });

      const scores = await service.rerank('query', ['doc1', 'doc2', 'doc3']);
      expect(scores).toEqual([0.9, 0.3, 0.5]);
    });

    it('strips think tags from response', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            message: { content: '<think>hmm</think>[0.8, 0.2]' },
          }),
      });

      const scores = await service.rerank('query', ['doc1', 'doc2']);
      expect(scores).toEqual([0.8, 0.2]);
    });

    it('falls back to regex when JSON.parse fails', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            message: { content: 'Here are scores: [0.7, 0.4] done' },
          }),
      });

      const scores = await service.rerank('query', ['doc1', 'doc2']);
      expect(scores).toEqual([0.7, 0.4]);
    });

    it('throws when no array found in response', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            message: { content: 'I cannot score these documents.' },
          }),
      });

      // Gets caught by outer try-catch
      const scores = await service.rerank('query', ['doc1']);
      expect(scores).toEqual([0]);
    });

    it('pads scores when fewer than documents', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            message: { content: '[0.9]' },
          }),
      });

      const scores = await service.rerank('query', ['doc1', 'doc2', 'doc3']);
      expect(scores).toEqual([0.9, 0, 0]);
    });

    it('truncates scores when more than documents', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            message: { content: '[0.9, 0.8, 0.7, 0.6]' },
          }),
      });

      const scores = await service.rerank('query', ['doc1', 'doc2']);
      expect(scores).toEqual([0.9, 0.8]);
    });

    it('normalises scores above 1 (0-10 range)', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            message: { content: '[8, 4, 10]' },
          }),
      });

      const scores = await service.rerank('query', ['doc1', 'doc2', 'doc3']);
      expect(scores).toEqual([0.8, 0.4, 1.0]);
    });

    it('throws on HTTP error', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 503,
      });

      const scores = await service.rerank('query', ['doc1']);
      expect(scores).toEqual([0]);
    });

    it('handles empty message content', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            message: { content: '' },
          }),
      });

      const scores = await service.rerank('query', ['doc1']);
      expect(scores).toEqual([0]);
    });
  });

  describe('jina backend', () => {
    let service: RerankService;

    beforeEach(() => {
      service = new RerankService(
        createConfig({
          rerankerBackend: 'jina' as ConfigService['rerankerBackend'],
          jinaApiKey: 'test-key',
        }),
      );
      service.onModuleInit();
    });

    it('calls Jina API and maps scores by index', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            results: [
              { index: 0, relevance_score: 0.95 },
              { index: 1, relevance_score: 0.42 },
            ],
          }),
      });

      const scores = await service.rerank('query', ['doc1', 'doc2']);

      expect(scores).toEqual([0.95, 0.42]);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.jina.ai/v1/rerank',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-key',
          }),
        }),
      );
    });

    it('handles missing results gracefully', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const scores = await service.rerank('query', ['doc1']);
      expect(scores).toEqual([0]);
    });

    it('returns zeros on HTTP error', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      });

      const scores = await service.rerank('query', ['doc1']);
      expect(scores).toEqual([0]);
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AiService } from '../ai.service';
import { ConfigService } from '../../config/config.service';
import { OllamaService } from '../ollama.service';
import { OpenRouterService } from '../openrouter.service';
import { GeminiEmbedService } from '../gemini-embed.service';
import { AiCacheService } from '../ai-cache.service';
import { RerankService } from '../rerank.service';

function createMockConfig(overrides: Partial<ConfigService> = {}): ConfigService {
  return {
    aiBackend: 'ollama',
    embedBackend: 'ollama',
    ollamaEmbedModel: 'mxbai-embed-large',
    ollamaTextModel: 'qwen3:8b',
    ollamaVlModel: 'qwen3-vl:4b',
    openrouterEmbedModel: 'google/gemini-embedding-001',
    openrouterTextModel: 'mistralai/mistral-nemo',
    openrouterVlModel: 'google/gemma-3-4b-it',
    geminiEmbedModel: 'gemini-embedding-2-preview',
    ...overrides,
  } as ConfigService;
}

function createMockOllama(): OllamaService {
  return {
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    generate: vi.fn().mockResolvedValue('ollama-result'),
  } as unknown as OllamaService;
}

function createMockOpenRouter(): OpenRouterService {
  return {
    embed: vi.fn().mockResolvedValue([0.4, 0.5, 0.6]),
    generate: vi.fn().mockResolvedValue('openrouter-result'),
  } as unknown as OpenRouterService;
}

function createMockGemini(): GeminiEmbedService {
  return {
    embed: vi.fn().mockResolvedValue([0.7, 0.8, 0.9]),
    embedMultimodal: vi.fn().mockResolvedValue([0.7, 0.8, 0.9]),
  } as unknown as GeminiEmbedService;
}

function createMockCache(): AiCacheService {
  return {
    get: vi.fn().mockResolvedValue({ hit: false }),
    set: vi.fn().mockResolvedValue(undefined),
  } as unknown as AiCacheService;
}

function createMockReranker(): RerankService {
  return {
    rerank: vi.fn().mockResolvedValue([0.9, 0.5]),
  } as unknown as RerankService;
}

describe('AiService', () => {
  let service: AiService;
  let config: ConfigService;
  let ollama: OllamaService;
  let openrouter: OpenRouterService;
  let gemini: GeminiEmbedService;
  let cache: AiCacheService;
  let reranker: RerankService;

  beforeEach(() => {
    config = createMockConfig();
    ollama = createMockOllama();
    openrouter = createMockOpenRouter();
    gemini = createMockGemini();
    cache = createMockCache();
    reranker = createMockReranker();
    service = new AiService(config, ollama, openrouter, gemini, cache, reranker);
  });

  describe('embed', () => {
    it('routes to ollama when embedBackend is ollama', async () => {
      const result = await service.embed('hello');

      expect(ollama.embed).toHaveBeenCalledWith('hello', undefined);
      expect(result).toEqual([0.1, 0.2, 0.3]);
    });

    it('routes to openrouter when embedBackend is openrouter', async () => {
      (config as Record<string, unknown>).embedBackend = 'openrouter';
      service = new AiService(config, ollama, openrouter, gemini, cache, reranker);

      const result = await service.embed('hello');

      expect(openrouter.embed).toHaveBeenCalledWith('hello', undefined);
      expect(result).toEqual([0.4, 0.5, 0.6]);
    });

    it('routes to gemini when embedBackend is gemini', async () => {
      (config as Record<string, unknown>).embedBackend = 'gemini';
      service = new AiService(config, ollama, openrouter, gemini, cache, reranker);

      const result = await service.embed('hello');

      expect(gemini.embed).toHaveBeenCalledWith('hello', undefined);
      expect(result).toEqual([0.7, 0.8, 0.9]);
    });

    it('returns cached embedding on cache hit', async () => {
      (cache.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        hit: true,
        output: JSON.stringify([1, 2, 3]),
      });

      const result = await service.embed('hello');

      expect(result).toEqual([1, 2, 3]);
      expect(ollama.embed).not.toHaveBeenCalled();
    });

    it('stores result in cache after embedding', async () => {
      await service.embed('hello');

      expect(cache.set).toHaveBeenCalledWith(
        'mxbai-embed-large',
        'ollama',
        'embed',
        'hello',
        JSON.stringify([0.1, 0.2, 0.3]),
        expect.objectContaining({ latencyMs: expect.any(Number) }),
      );
    });

    it('propagates errors from embed service', async () => {
      (ollama.embed as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('embed failed'));

      await expect(service.embed('hello')).rejects.toThrow('embed failed');
    });

    it('does not fail if cache set throws', async () => {
      (cache.set as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('cache write fail'));

      // Should still return the result without throwing
      const result = await service.embed('hello');
      expect(result).toEqual([0.1, 0.2, 0.3]);
    });
  });

  describe('embedQuery', () => {
    it('returns embedding for a query', async () => {
      const result = await service.embedQuery('search query');

      expect(result).toEqual([0.1, 0.2, 0.3]);
    });

    it('caches and returns same result for identical queries', async () => {
      await service.embedQuery('search query');
      const result = await service.embedQuery('search query');

      // embed should only be called once (second call uses LRU cache)
      expect(ollama.embed).toHaveBeenCalledTimes(1);
      expect(result).toEqual([0.1, 0.2, 0.3]);
    });

    it('normalizes query key (lowercase + trim)', async () => {
      await service.embedQuery('  Hello World  ');
      const result = await service.embedQuery('hello world');

      // Same normalized key, so embed called only once
      expect(ollama.embed).toHaveBeenCalledTimes(1);
      expect(result).toEqual([0.1, 0.2, 0.3]);
    });
  });

  describe('embedMultimodal', () => {
    it('delegates to gemini when embedBackend is gemini', async () => {
      (config as Record<string, unknown>).embedBackend = 'gemini';
      service = new AiService(config, ollama, openrouter, gemini, cache, reranker);

      const parts = [{ type: 'text' as const, text: 'hello' }];
      const result = await service.embedMultimodal(parts);

      expect(gemini.embedMultimodal).toHaveBeenCalledWith(parts, undefined);
      expect(result).toEqual([0.7, 0.8, 0.9]);
    });

    it('throws when embedBackend is not gemini', async () => {
      const parts = [{ type: 'text' as const, text: 'hello' }];

      await expect(service.embedMultimodal(parts)).rejects.toThrow(
        'embedMultimodal requires EMBED_BACKEND=gemini',
      );
    });
  });

  describe('generate', () => {
    it('routes to ollama when aiBackend is ollama', async () => {
      const result = await service.generate('prompt');

      expect(ollama.generate).toHaveBeenCalledWith('prompt', undefined, undefined, undefined);
      expect(result).toBe('ollama-result');
    });

    it('routes to openrouter when aiBackend is openrouter', async () => {
      (config as Record<string, unknown>).aiBackend = 'openrouter';
      service = new AiService(config, ollama, openrouter, gemini, cache, reranker);

      const result = await service.generate('prompt');

      expect(openrouter.generate).toHaveBeenCalledWith('prompt', undefined, undefined, undefined);
      expect(result).toBe('openrouter-result');
    });

    it('returns cached result on cache hit', async () => {
      (cache.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        hit: true,
        output: 'cached-result',
      });

      const result = await service.generate('prompt');

      expect(result).toBe('cached-result');
      expect(ollama.generate).not.toHaveBeenCalled();
    });

    it('uses VL model name in cache key when images provided', async () => {
      await service.generate('describe', ['base64img']);

      expect(cache.get).toHaveBeenCalledWith(
        'qwen3-vl:4b',
        expect.stringContaining('::img::'),
        'generate_vl',
      );
    });

    it('uses text model name when no images', async () => {
      await service.generate('explain this');

      expect(cache.get).toHaveBeenCalledWith('qwen3:8b', 'explain this', 'generate');
    });

    it('stores result in cache after generation', async () => {
      await service.generate('prompt');

      expect(cache.set).toHaveBeenCalledWith(
        'qwen3:8b',
        'ollama',
        'generate',
        'prompt',
        'ollama-result',
        expect.objectContaining({ latencyMs: expect.any(Number) }),
      );
    });

    it('propagates errors from backend', async () => {
      (ollama.generate as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('generation failed'),
      );

      await expect(service.generate('prompt')).rejects.toThrow('generation failed');
    });
  });

  describe('rerank', () => {
    it('delegates to reranker service', async () => {
      const result = await service.rerank('query', ['doc1', 'doc2']);

      expect(reranker.rerank).toHaveBeenCalledWith('query', ['doc1', 'doc2']);
      expect(result).toEqual([0.9, 0.5]);
    });
  });
});

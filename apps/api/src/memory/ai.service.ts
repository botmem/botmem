import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { OllamaService } from './ollama.service';
import { OpenRouterService } from './openrouter.service';
import { GeminiEmbedService, EmbedPart } from './gemini-embed.service';
import { AiCacheService } from './ai-cache.service';
import { RerankService } from './rerank.service';
import { Traced } from '../tracing/traced.decorator';

/** In-memory LRU cache for query embeddings (avoids re-embedding identical/recent queries) */
class EmbedLruCache {
  private cache = new Map<string, { vector: number[]; ts: number }>();
  constructor(
    private maxSize: number,
    private ttlMs: number,
  ) {}

  get(key: string): number[] | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.vector;
  }

  set(key: string, vector: number[]) {
    if (this.cache.size >= this.maxSize) {
      // Evict oldest (first entry)
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { vector, ts: Date.now() });
  }
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly queryEmbedCache = new EmbedLruCache(1000, 5 * 60 * 1000); // 1000 entries, 5min TTL

  constructor(
    private readonly config: ConfigService,
    private readonly ollama: OllamaService,
    private readonly openrouter: OpenRouterService,
    private readonly gemini: GeminiEmbedService,
    private readonly cache: AiCacheService,
    private readonly reranker: RerankService,
  ) {}

  /** Generation backend (text/VL) — always follows AI_BACKEND */
  private get backend() {
    return this.config.aiBackend === 'openrouter' ? this.openrouter : this.ollama;
  }

  /** Embedding backend — follows EMBED_BACKEND (decoupled from generation) */
  private get embedService(): { embed(text: string, retries?: number): Promise<number[]> } {
    switch (this.config.embedBackend) {
      case 'gemini':
        return this.gemini;
      case 'openrouter':
        return this.openrouter;
      default:
        return this.ollama;
    }
  }

  private get embedModelName(): string {
    switch (this.config.embedBackend) {
      case 'gemini':
        return this.config.geminiEmbedModel;
      case 'openrouter':
        return this.config.openrouterEmbedModel;
      default:
        return this.config.ollamaEmbedModel;
    }
  }

  @Traced('ai.embed')
  async embed(text: string, retries?: number): Promise<number[]> {
    const model = this.embedModelName;

    const cached = await this.cache.get(model, text, 'embed');
    if (cached.hit) return JSON.parse(cached.output);

    const t0 = Date.now();
    const result = await this.embedService.embed(text, retries);

    this.cache
      .set(model, this.config.embedBackend, 'embed', text, JSON.stringify(result), {
        latencyMs: Date.now() - t0,
      })
      .catch(() => {});

    return result;
  }

  /**
   * Embed a search query with in-memory LRU caching.
   * Same/similar queries within 5min skip the embedding call entirely.
   */
  async embedQuery(text: string): Promise<number[]> {
    const key = text.toLowerCase().trim();
    const cached = this.queryEmbedCache.get(key);
    if (cached) return cached;

    const vector = await this.embed(text);
    this.queryEmbedCache.set(key, vector);
    return vector;
  }

  async embedMultimodal(parts: EmbedPart[], retries?: number): Promise<number[]> {
    if (this.config.embedBackend !== 'gemini') {
      throw new Error(
        `embedMultimodal requires EMBED_BACKEND=gemini (current: ${this.config.embedBackend})`,
      );
    }
    return this.gemini.embedMultimodal(parts, retries);
  }

  @Traced('ai.generate')
  async generate(
    prompt: string,
    images?: string[],
    retries?: number,
    format?: Record<string, unknown>,
  ): Promise<string> {
    const model = images?.length
      ? this.config.aiBackend === 'openrouter'
        ? this.config.openrouterVlModel
        : this.config.ollamaVlModel
      : this.config.aiBackend === 'openrouter'
        ? this.config.openrouterTextModel
        : this.config.ollamaTextModel;

    const op = images?.length ? 'generate_vl' : 'generate';

    const cacheInput = images?.length
      ? prompt + '::img::' + images.map((i) => i.slice(0, 64)).join(',')
      : prompt;

    const cached = await this.cache.get(model, cacheInput, op);
    if (cached.hit) return cached.output;

    const t0 = Date.now();
    const { text, inputTokens, outputTokens } = await this.backend.generate(
      prompt,
      images,
      retries,
      format,
    );

    this.cache
      .set(model, this.config.aiBackend, op, cacheInput, text, {
        inputTokens,
        outputTokens,
        latencyMs: Date.now() - t0,
      })
      .catch(() => {});

    return text;
  }

  async rerank(query: string, documents: string[]): Promise<number[]> {
    return this.reranker.rerank(query, documents);
  }
}

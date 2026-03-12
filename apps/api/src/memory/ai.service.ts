import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { OllamaService } from './ollama.service';
import { OpenRouterService } from './openrouter.service';
import { GeminiEmbedService, EmbedPart } from './gemini-embed.service';
import { AiCacheService } from './ai-cache.service';
import { RerankService } from './rerank.service';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

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

  async embedMultimodal(parts: EmbedPart[], retries?: number): Promise<number[]> {
    if (this.config.embedBackend !== 'gemini') {
      throw new Error(
        `embedMultimodal requires EMBED_BACKEND=gemini (current: ${this.config.embedBackend})`,
      );
    }
    return this.gemini.embedMultimodal(parts, retries);
  }

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
    const result = await this.backend.generate(prompt, images, retries, format);

    this.cache
      .set(model, this.config.aiBackend, op, cacheInput, result, {
        latencyMs: Date.now() - t0,
      })
      .catch(() => {});

    return result;
  }

  async rerank(query: string, documents: string[]): Promise<number[]> {
    return this.reranker.rerank(query, documents);
  }
}

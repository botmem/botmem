import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { OllamaService } from './ollama.service';
import { OpenRouterService } from './openrouter.service';
import { AiCacheService } from './ai-cache.service';
import { RerankService } from './rerank.service';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly ollama: OllamaService,
    private readonly openrouter: OpenRouterService,
    private readonly cache: AiCacheService,
    private readonly reranker: RerankService,
  ) {}

  private get backend() {
    return this.config.aiBackend === 'openrouter' ? this.openrouter : this.ollama;
  }

  async embed(text: string, retries?: number): Promise<number[]> {
    const model =
      this.config.aiBackend === 'openrouter'
        ? this.config.openrouterEmbedModel
        : this.config.ollamaEmbedModel;

    const cached = await this.cache.get(model, text, 'embed');
    if (cached.hit) return JSON.parse(cached.output);

    const t0 = Date.now();
    const result = await this.backend.embed(text, retries);

    // Fire and forget cache write
    this.cache
      .set(model, this.config.aiBackend, 'embed', text, JSON.stringify(result), {
        latencyMs: Date.now() - t0,
      })
      .catch(() => {});

    return result;
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

    // For VL, include a truncated image hash in cache key (don't store full images)
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

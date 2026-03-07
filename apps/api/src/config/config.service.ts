import { Injectable } from '@nestjs/common';

@Injectable()
export class ConfigService {
  get port(): number {
    return parseInt(process.env.PORT || '12412', 10);
  }

  get redisUrl(): string {
    return process.env.REDIS_URL || 'redis://localhost:6379';
  }

  get dbPath(): string {
    return process.env.DB_PATH || './data/botmem.db';
  }

  get pluginsDir(): string {
    return process.env.PLUGINS_DIR || './plugins';
  }

  get frontendUrl(): string {
    return process.env.FRONTEND_URL || 'http://localhost:12412';
  }

  get ollamaBaseUrl(): string {
    return process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  }

  get ollamaEmbedModel(): string {
    return process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
  }

  get ollamaTextModel(): string {
    return process.env.OLLAMA_TEXT_MODEL || 'qwen3:0.6b';
  }

  get ollamaVlModel(): string {
    return process.env.OLLAMA_VL_MODEL || 'qwen3-vl:2b';
  }

  get ollamaRerankerModel(): string {
    return process.env.OLLAMA_RERANKER_MODEL || 'sam860/qwen3-reranker:0.6b-Q8_0';
  }

  get qdrantUrl(): string {
    return process.env.QDRANT_URL || 'http://localhost:6333';
  }

  get syncDebugLimit(): number {
    return parseInt(process.env.SYNC_DEBUG_LIMIT || '2000', 10);
  }
}

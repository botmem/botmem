import { Injectable } from '@nestjs/common';

@Injectable()
export class ConfigService {
  get port(): number {
    return parseInt(process.env.PORT || '3001', 10);
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
    return process.env.FRONTEND_URL || 'http://localhost:5173';
  }

  get ollamaBaseUrl(): string {
    return process.env.OLLAMA_BASE_URL || 'http://192.168.10.250:11434';
  }

  get ollamaEmbedModel(): string {
    return process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
  }

  get ollamaTextModel(): string {
    return process.env.OLLAMA_TEXT_MODEL || 'qwen3:4b';
  }

  get ollamaVlModel(): string {
    return process.env.OLLAMA_VL_MODEL || 'qwen3-vl:4b';
  }

  get qdrantUrl(): string {
    return process.env.QDRANT_URL || 'http://localhost:6333';
  }
}

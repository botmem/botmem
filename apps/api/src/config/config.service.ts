import { Injectable } from '@nestjs/common';

@Injectable()
export class ConfigService {
  get port(): number {
    return Number.parseInt(process.env.PORT || '12412', 10);
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
    return Number.parseInt(process.env.SYNC_DEBUG_LIMIT || '500', 10);
  }

  get posthogApiKey(): string {
    return process.env.POSTHOG_API_KEY || '';
  }

  get posthogHost(): string {
    return process.env.POSTHOG_HOST || 'https://us.i.posthog.com';
  }

  get decayCron(): string {
    return process.env.DECAY_CRON || '0 3 * * *';
  }

  // --- SMTP config ---

  get smtpHost(): string {
    return process.env.SMTP_HOST || '';
  }

  get smtpPort(): number {
    return Number.parseInt(process.env.SMTP_PORT || '587', 10);
  }

  get smtpUser(): string {
    return process.env.SMTP_USER || '';
  }

  get smtpPass(): string {
    return process.env.SMTP_PASS || '';
  }

  get smtpFrom(): string {
    return process.env.SMTP_FROM || this.smtpUser || 'noreply@botmem.xyz';
  }

  get smtpConfigured(): boolean {
    return this.smtpHost !== '';
  }

  // --- JWT config ---

  get jwtSecret(): string {
    return process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production';
  }

  get jwtAccessExpiresIn(): string {
    return process.env.JWT_ACCESS_EXPIRES_IN || '15m';
  }

  get jwtRefreshExpiresIn(): string {
    return process.env.JWT_REFRESH_EXPIRES_IN || '7d';
  }
}

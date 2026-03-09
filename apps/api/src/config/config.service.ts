import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

@Injectable()
export class ConfigService implements OnModuleInit {
  private readonly logger = new Logger(ConfigService.name);

  onModuleInit() {
    if (!process.env.DATABASE_URL) {
      throw new Error('FATAL: DATABASE_URL environment variable is required');
    }
    this.validateProductionSecrets();

    // Warn in dev mode if APP_SECRET is using the default value
    if (this.appSecret === 'dev-app-secret-change-in-production') {
      this.logger.warn('APP_SECRET is using default value. Set a secure value for production.');
    }
  }

  validateProductionSecrets(): void {
    if (process.env.NODE_ENV !== 'production') return;

    const defaults = [
      { name: 'APP_SECRET', value: this.appSecret, default: 'dev-app-secret-change-in-production' },
      {
        name: 'JWT_ACCESS_SECRET',
        value: this.jwtAccessSecret,
        default: 'dev-access-secret-change-in-production',
      },
      {
        name: 'JWT_REFRESH_SECRET',
        value: this.jwtRefreshSecret,
        default: 'dev-refresh-secret-change-in-production',
      },
    ];

    for (const { name, value, default: def } of defaults) {
      if (value === def) {
        throw new Error(`FATAL: ${name} is using default value in production. Set a secure value.`);
      }
    }

    this.logger.log('Production secret validation passed');
  }

  get port(): number {
    return Number.parseInt(process.env.PORT || '12412', 10);
  }

  get redisUrl(): string {
    return process.env.REDIS_URL || 'redis://localhost:6379';
  }

  get databaseUrl(): string {
    return process.env.DATABASE_URL!;
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

  get ollamaUsername(): string {
    return process.env.OLLAMA_USERNAME || '';
  }

  get ollamaPassword(): string {
    return process.env.OLLAMA_PASSWORD || '';
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

  // --- Encryption ---

  get appSecret(): string {
    return process.env.APP_SECRET || 'dev-app-secret-change-in-production';
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

  get jwtAccessSecret(): string {
    return process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-in-production';
  }

  get jwtRefreshSecret(): string {
    return process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-in-production';
  }

  get jwtAccessExpiresIn(): string {
    return process.env.JWT_ACCESS_EXPIRES_IN || '15m';
  }

  get jwtRefreshExpiresIn(): string {
    return process.env.JWT_REFRESH_EXPIRES_IN || '7d';
  }

  get logsPath(): string {
    return process.env.LOGS_PATH || './data/logs.ndjson';
  }

  // --- Auth provider ---

  get authProvider(): 'local' | 'firebase' {
    const val = process.env.AUTH_PROVIDER || 'local';
    return val === 'firebase' ? 'firebase' : 'local';
  }

  get firebaseProjectId(): string {
    return process.env.FIREBASE_PROJECT_ID || 'botmem-app';
  }
}

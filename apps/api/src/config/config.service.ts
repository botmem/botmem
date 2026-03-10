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
      {
        name: 'OAUTH_JWT_SECRET',
        value: this.oauthJwtSecret,
        default: 'dev-oauth-jwt-secret-change-in-production',
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
    return process.env.OLLAMA_EMBED_MODEL || 'mxbai-embed-large';
  }

  get ollamaTextModel(): string {
    return process.env.OLLAMA_TEXT_MODEL || 'qwen3:8b';
  }

  get ollamaVlModel(): string {
    return process.env.OLLAMA_VL_MODEL || 'qwen3-vl:4b';
  }

  get ollamaRerankerModel(): string {
    return process.env.OLLAMA_RERANKER_MODEL || 'sam860/qwen3-reranker:0.6b-Q8_0';
  }

  /** URL of a HuggingFace TEI /rerank endpoint (e.g. http://192.168.10.250:8081).
   *  When set, reranking is active. When empty, reranking is skipped (scores = 0). */
  get rerankerUrl(): string {
    return process.env.RERANKER_URL || '';
  }

  /** Reranker backend: tei (auto if RERANKER_URL set) | ollama | jina | none */
  get rerankerBackend(): 'ollama' | 'jina' | 'tei' | 'none' {
    const val = process.env.RERANKER_BACKEND || (this.rerankerUrl ? 'tei' : 'ollama');
    if (val === 'jina' || val === 'none' || val === 'tei') return val;
    return 'ollama';
  }

  get jinaApiKey(): string {
    return process.env.JINA_API_KEY || '';
  }

  get ollamaUsername(): string {
    return process.env.OLLAMA_USERNAME || '';
  }

  get ollamaPassword(): string {
    return process.env.OLLAMA_PASSWORD || '';
  }

  get ollamaEmbedDimension(): number {
    return parseInt(process.env.OLLAMA_EMBED_DIMENSION || '1024', 10);
  }

  get qdrantUrl(): string {
    return process.env.QDRANT_URL || 'http://localhost:6333';
  }

  get syncDebugLimit(): number {
    return Number.parseInt(process.env.SYNC_DEBUG_LIMIT || '2000', 10);
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

  /** Service account JSON string for Firebase Admin (required on non-GCP servers) */
  get firebaseServiceAccount(): string {
    return process.env.FIREBASE_SERVICE_ACCOUNT || '';
  }

  // --- Gmail OAuth (server-side creds for Firebase mode) ---

  get gmailClientId(): string {
    return process.env.GMAIL_CLIENT_ID || '';
  }

  get gmailClientSecret(): string {
    return process.env.GMAIL_CLIENT_SECRET || '';
  }

  // --- AI Backend ---

  get aiBackend(): 'ollama' | 'openrouter' {
    const val = process.env.AI_BACKEND || 'ollama';
    return val === 'openrouter' ? 'openrouter' : 'ollama';
  }

  // --- OpenRouter ---

  get openrouterApiKey(): string {
    return process.env.OPENROUTER_API_KEY || '';
  }

  get openrouterEmbedModel(): string {
    return process.env.OPENROUTER_EMBED_MODEL || 'google/gemini-embedding-001';
  }

  get openrouterTextModel(): string {
    return process.env.OPENROUTER_TEXT_MODEL || 'mistralai/mistral-nemo';
  }

  get openrouterVlModel(): string {
    return process.env.OPENROUTER_VL_MODEL || 'google/gemma-3-4b-it';
  }

  // --- Stripe Billing ---

  get stripeSecretKey(): string {
    return process.env.STRIPE_SECRET_KEY || '';
  }

  get stripeWebhookSecret(): string {
    return process.env.STRIPE_WEBHOOK_SECRET || '';
  }

  get stripePriceId(): string {
    return process.env.STRIPE_PRO_PRICE_ID || '';
  }

  get isSelfHosted(): boolean {
    return !this.stripeSecretKey;
  }

  // --- OAuth ---

  get oauthJwtSecret(): string {
    return process.env.OAUTH_JWT_SECRET || 'dev-oauth-jwt-secret-change-in-production';
  }

  get baseUrl(): string {
    return process.env.BASE_URL || this.frontendUrl;
  }

  get embedDimension(): number {
    return parseInt(process.env.EMBED_DIMENSION || '1024', 10);
  }

  /** Sensible concurrency defaults based on AI backend (local GPU vs cloud API) */
  get aiConcurrency(): { embed: number; enrich: number; memory: number; backfill: number } {
    if (this.aiBackend === 'openrouter') {
      return { embed: 64, enrich: 64, memory: 64, backfill: 16 };
    }
    // Ollama: conservative — single GPU, one inference at a time is fastest
    return { embed: 8, enrich: 8, memory: 16, backfill: 2 };
  }
}

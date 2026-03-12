import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';
import { sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { CryptoService } from '../crypto/crypto.service';

/** Max age for cache entries before eviction */
const CACHE_TTL_DAYS = 30;
/** Max number of cache entries to keep */
const CACHE_MAX_ENTRIES = 100_000;
/** How often to run eviction (ms) */
const EVICTION_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

@Injectable()
export class AiCacheService implements OnModuleInit {
  private readonly logger = new Logger(AiCacheService.name);
  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: DbService,
    private readonly crypto: CryptoService,
  ) {}

  onModuleInit() {
    // Run eviction on startup (delayed) and then periodically
    setTimeout(() => this.evictStaleEntries().catch(() => {}), 60_000);
    this.evictionTimer = setInterval(
      () => this.evictStaleEntries().catch(() => {}),
      EVICTION_INTERVAL_MS,
    );
  }

  private computeId(model: string, inputText: string): string {
    const inputHash = createHash('sha256').update(inputText).digest('hex');
    return createHash('sha256').update(`${model}:${inputHash}`).digest('hex');
  }

  async get(
    model: string,
    inputText: string,
    _operation: string,
  ): Promise<{ output: string; hit: true } | { hit: false }> {
    try {
      const id = this.computeId(model, inputText);
      const rows = await this.db.db.execute(
        sql`SELECT output FROM llm_cache WHERE id = ${id} LIMIT 1`,
      );

      if (!rows.rows?.length) return { hit: false };

      const rawOutput = rows.rows[0].output;
      if (!rawOutput) return { hit: false };
      const decrypted = this.crypto.decrypt(rawOutput as string);
      if (!decrypted) return { hit: false };
      return { output: decrypted, hit: true };
    } catch (err) {
      this.logger.debug(`Cache get error: ${err}`);
      return { hit: false };
    }
  }

  async set(
    model: string,
    backend: string,
    operation: string,
    inputText: string,
    output: string,
    meta?: { inputTokens?: number; outputTokens?: number; latencyMs?: number },
  ): Promise<void> {
    try {
      const id = this.computeId(model, inputText);
      const inputHash = createHash('sha256').update(inputText).digest('hex');
      // eslint-disable-next-line no-control-regex
      const encryptedInput = this.crypto.encrypt(inputText.replace(/\x00/g, ''));
      // eslint-disable-next-line no-control-regex
      const encryptedOutput = this.crypto.encrypt(output.replace(/\x00/g, ''));

      await this.db.db.execute(sql`
        INSERT INTO llm_cache (id, input_hash, model, backend, operation, input, output, input_tokens, output_tokens, latency_ms)
        VALUES (${id}, ${inputHash}, ${model}, ${backend}, ${operation}, ${encryptedInput}, ${encryptedOutput}, ${meta?.inputTokens ?? null}, ${meta?.outputTokens ?? null}, ${meta?.latencyMs ?? null})
        ON CONFLICT (id) DO UPDATE SET
          output = ${encryptedOutput},
          input_tokens = ${meta?.inputTokens ?? null},
          output_tokens = ${meta?.outputTokens ?? null},
          latency_ms = ${meta?.latencyMs ?? null}
      `);
    } catch (err) {
      this.logger.warn(`Cache set error: ${err}`);
    }
  }

  /**
   * Evict stale cache entries: remove entries older than CACHE_TTL_DAYS,
   * and if still over CACHE_MAX_ENTRIES, remove oldest entries.
   */
  private async evictStaleEntries(): Promise<void> {
    try {
      // Delete entries older than TTL
      const cutoff = new Date(Date.now() - CACHE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const ttlResult = await this.db.db.execute(
        sql`DELETE FROM llm_cache WHERE created_at < ${cutoff}`,
      );
      const ttlDeleted = (ttlResult as { rowCount?: number }).rowCount ?? 0;

      // Check total count
      const countResult = await this.db.db.execute(sql`SELECT COUNT(*)::int AS cnt FROM llm_cache`);
      const totalCount = (countResult.rows[0] as { cnt: number })?.cnt ?? 0;

      if (totalCount > CACHE_MAX_ENTRIES) {
        // Delete oldest entries beyond the max
        const excess = totalCount - CACHE_MAX_ENTRIES;
        await this.db.db.execute(
          sql`DELETE FROM llm_cache WHERE id IN (
            SELECT id FROM llm_cache ORDER BY created_at ASC LIMIT ${excess}
          )`,
        );
        this.logger.log(
          `[LLM Cache] Evicted ${ttlDeleted} stale + ${excess} excess entries (total was ${totalCount})`,
        );
      } else if (ttlDeleted > 0) {
        this.logger.log(
          `[LLM Cache] Evicted ${ttlDeleted} stale entries (${totalCount} remaining)`,
        );
      }
    } catch (err) {
      this.logger.warn(`[LLM Cache] Eviction failed: ${err}`);
    }
  }
}

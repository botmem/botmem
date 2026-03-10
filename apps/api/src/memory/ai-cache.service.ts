import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { CryptoService } from '../crypto/crypto.service';

@Injectable()
export class AiCacheService {
  private readonly logger = new Logger(AiCacheService.name);

  constructor(
    private readonly db: DbService,
    private readonly crypto: CryptoService,
  ) {}

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
}

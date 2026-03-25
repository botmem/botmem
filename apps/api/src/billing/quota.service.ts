import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { BillingService } from './billing.service';
import { ConfigService } from '../config/config.service';
import { FREE_MEMORY_LIMIT, type QuotaInfo } from '@botmem/shared';

interface CacheEntry {
  count: number;
  ts: number;
}

const CACHE_TTL_MS = 30_000;

@Injectable()
export class QuotaService {
  private readonly logger = new Logger(QuotaService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private db: DbService,
    private billing: BillingService,
    private config: ConfigService,
  ) {}

  async canCreateMemory(ownerUserId: string): Promise<{
    allowed: boolean;
    used: number;
    limit: number | null;
  }> {
    if (this.config.isSelfHosted) {
      return { allowed: true, used: 0, limit: null };
    }

    const isPro = await this.billing.isProUser(ownerUserId);
    if (isPro) {
      return { allowed: true, used: 0, limit: null };
    }

    const used = await this.getTotalMemoryCount(ownerUserId);
    return {
      allowed: used < FREE_MEMORY_LIMIT,
      used,
      limit: FREE_MEMORY_LIMIT,
    };
  }

  async getUserQuota(userId: string): Promise<QuotaInfo> {
    if (this.config.isSelfHosted) {
      return { used: 0, limit: null, remaining: null };
    }

    const isPro = await this.billing.isProUser(userId);
    const used = await this.getTotalMemoryCount(userId);

    if (isPro) {
      return { used, limit: null, remaining: null };
    }

    return {
      used,
      limit: FREE_MEMORY_LIMIT,
      remaining: Math.max(0, FREE_MEMORY_LIMIT - used),
    };
  }

  async getTotalMemoryCount(userId: string): Promise<number> {
    const cached = this.cache.get(userId);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return cached.count;
    }

    const result = await this.db.db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::int AS count FROM memories m WHERE m.account_id IN (SELECT id FROM accounts WHERE user_id = ${userId})`,
    );
    const count = Number(result.rows[0]?.count ?? 0);

    this.cache.set(userId, { count, ts: Date.now() });
    return count;
  }

  incrementCachedCount(userId: string): void {
    const cached = this.cache.get(userId);
    if (cached) {
      cached.count++;
    }
  }
}

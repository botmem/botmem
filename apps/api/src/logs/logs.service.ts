import { Injectable } from '@nestjs/common';
import { desc, eq, and, type SQL } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { logs } from '../db/schema';

@Injectable()
export class LogsService {
  constructor(private dbService: DbService) {}

  private get db() {
    return this.dbService.db;
  }

  async add(data: { jobId?: string; connectorType: string; accountId?: string; stage?: string; level: string; message: string }) {
    const id = crypto.randomUUID();
    try {
      await this.db.insert(logs).values({
        id,
        jobId: data.jobId || null,
        connectorType: data.connectorType,
        accountId: data.accountId || null,
        stage: data.stage || null,
        level: data.level,
        message: data.message,
        timestamp: new Date(),
      });
    } catch (error) {
      // Log to console as fallback if database is unavailable
      const timestamp = new Date().toISOString();
      console.warn(`[LogsService:${timestamp}] Failed to persist log: ${data.message}`, error instanceof Error ? error.message : String(error));
      // Don't rethrow - allow the API to continue functioning
    }
  }

  async query(filters?: { jobId?: string; accountId?: string; level?: string; limit?: number; offset?: number }) {
    const limit = filters?.limit || 50;
    const conditions: SQL[] = [];
    if (filters?.jobId) conditions.push(eq(logs.jobId, filters.jobId));
    if (filters?.accountId) conditions.push(eq(logs.accountId, filters.accountId));
    if (filters?.level) conditions.push(eq(logs.level, filters.level));

    try {
      const query = this.db
        .select()
        .from(logs)
        .orderBy(desc(logs.timestamp))
        .limit(limit);

      const results = conditions.length > 0
        ? await query.where(and(...conditions))
        : await query;

      return { logs: results, total: results.length };
    } catch (error) {
      console.error('[LogsService] Failed to query logs:', error instanceof Error ? error.message : String(error));
      // Return empty result instead of crashing
      return { logs: [], total: 0 };
    }
  }
}

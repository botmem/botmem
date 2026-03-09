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
  }

  async query(filters?: { jobId?: string; accountId?: string; level?: string; limit?: number; offset?: number }) {
    const limit = filters?.limit || 50;
    const conditions: SQL[] = [];
    if (filters?.jobId) conditions.push(eq(logs.jobId, filters.jobId));
    if (filters?.accountId) conditions.push(eq(logs.accountId, filters.accountId));
    if (filters?.level) conditions.push(eq(logs.level, filters.level));

    const query = this.db
      .select()
      .from(logs)
      .orderBy(desc(logs.timestamp))
      .limit(limit);

    const results = conditions.length > 0
      ? await query.where(and(...conditions))
      : await query;

    return { logs: results, total: results.length };
  }
}

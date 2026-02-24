import { Injectable } from '@nestjs/common';
import { desc } from 'drizzle-orm';
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
      timestamp: new Date().toISOString(),
    });
  }

  async query(filters?: { jobId?: string; accountId?: string; level?: string; limit?: number; offset?: number }) {
    const limit = filters?.limit || 50;
    const results = await this.db
      .select()
      .from(logs)
      .orderBy(desc(logs.timestamp))
      .limit(limit);

    let filtered = results;
    if (filters?.jobId) filtered = filtered.filter((l) => l.jobId === filters.jobId);
    if (filters?.accountId) filtered = filtered.filter((l) => l.accountId === filters.accountId);
    if (filters?.level) filtered = filtered.filter((l) => l.level === filters.level);

    return { logs: filtered, total: filtered.length };
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { eq, sql, inArray } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { accounts, jobs, logs, rawEvents, memories, memoryLinks, memoryContacts } from '../db/schema';
import type { SyncSchedule } from '@botmem/shared';

@Injectable()
export class AccountsService {
  constructor(private dbService: DbService) {}

  private get db() {
    return this.dbService.db;
  }

  async create(data: {
    connectorType: string;
    identifier: string;
    authContext?: string;
    userId?: string;
  }) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db.insert(accounts).values({
      id,
      userId: data.userId || null,
      connectorType: data.connectorType,
      identifier: data.identifier,
      status: 'connected',
      schedule: 'manual',
      authContext: data.authContext || null,
      itemsSynced: 0,
      createdAt: now,
      updatedAt: now,
    });
    return this.getById(id);
  }

  async getAll(userId?: string) {
    if (userId) {
      return this.db.select().from(accounts).where(eq(accounts.userId, userId));
    }
    return this.db.select().from(accounts);
  }

  async getById(id: string) {
    const [account] = await this.db.select().from(accounts).where(eq(accounts.id, id));
    if (!account) throw new NotFoundException(`Account ${id} not found`);
    return account;
  }

  async update(id: string, data: Partial<{ schedule: SyncSchedule; status: string; authContext: string; lastCursor: string; lastSyncAt: string; itemsSynced: number; lastError: string | null }>) {
    await this.getById(id); // throws if not found
    await this.db
      .update(accounts)
      .set({ ...data, updatedAt: new Date().toISOString() })
      .where(eq(accounts.id, id));
    return this.getById(id);
  }

  async findByTypeAndIdentifier(connectorType: string, identifier: string) {
    const [account] = await this.db
      .select()
      .from(accounts)
      .where(
        sql`${accounts.connectorType} = ${connectorType} AND ${accounts.identifier} = ${identifier}`,
      );
    return account || null;
  }

  async remove(id: string) {
    await this.getById(id);

    // Delete related rows to satisfy foreign key constraints
    // 1. Get memory IDs for this account to clean up memory links & contacts
    const accountMemories = this.db
      .select({ id: memories.id })
      .from(memories)
      .where(eq(memories.accountId, id))
      .all();
    const memoryIds = accountMemories.map((m) => m.id);

    if (memoryIds.length > 0) {
      // Delete in batches to avoid SQLite variable limits
      for (let i = 0; i < memoryIds.length; i += 500) {
        const batch = memoryIds.slice(i, i + 500);
        this.db.delete(memoryContacts).where(inArray(memoryContacts.memoryId, batch)).run();
        this.db.delete(memoryLinks).where(inArray(memoryLinks.srcMemoryId, batch)).run();
        this.db.delete(memoryLinks).where(inArray(memoryLinks.dstMemoryId, batch)).run();
      }
    }

    // 2. Delete memories, raw events, logs, jobs for this account
    this.db.delete(memories).where(eq(memories.accountId, id)).run();
    this.db.delete(rawEvents).where(eq(rawEvents.accountId, id)).run();
    this.db.delete(logs).where(eq(logs.accountId, id)).run();
    this.db.delete(jobs).where(eq(jobs.accountId, id)).run();

    // 3. Finally delete the account itself
    this.db.delete(accounts).where(eq(accounts.id, id)).run();
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { eq, sql, inArray } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { CryptoService } from '../crypto/crypto.service';
import {
  accounts,
  jobs,
  logs,
  rawEvents,
  memories,
  memoryLinks,
  memoryContacts,
} from '../db/schema';
import type { SyncSchedule } from '@botmem/shared';

@Injectable()
export class AccountsService {
  constructor(
    private dbService: DbService,
    private crypto: CryptoService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  /** Decrypt authContext on an account row */
  private decryptAccount<T extends { authContext: string | null }>(row: T): T {
    return { ...row, authContext: this.crypto.decrypt(row.authContext) };
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
      authContext: this.crypto.encrypt(data.authContext || null),
      itemsSynced: 0,
      createdAt: now,
      updatedAt: now,
    });
    return this.getById(id);
  }

  async getAll(userId?: string) {
    const rows = userId
      ? await this.db.select().from(accounts).where(eq(accounts.userId, userId))
      : await this.db.select().from(accounts);
    return rows.map((r) => this.decryptAccount(r));
  }

  async getById(id: string) {
    const [account] = await this.db.select().from(accounts).where(eq(accounts.id, id));
    if (!account) throw new NotFoundException(`Account ${id} not found`);
    return this.decryptAccount(account);
  }

  async update(
    id: string,
    data: Partial<{
      schedule: SyncSchedule;
      status: string;
      authContext: string;
      lastCursor: string;
      lastSyncAt: string;
      itemsSynced: number;
      lastError: string | null;
    }>,
  ) {
    await this.getById(id); // throws if not found
    const toSet = { ...data, updatedAt: new Date().toISOString() };
    // Encrypt authContext if being updated
    if ('authContext' in toSet && toSet.authContext != null) {
      toSet.authContext = this.crypto.encrypt(toSet.authContext)!;
    }
    await this.db.update(accounts).set(toSet).where(eq(accounts.id, id));
    return this.getById(id);
  }

  async findByTypeAndIdentifier(connectorType: string, identifier: string, userId?: string) {
    const conditions = [
      sql`${accounts.connectorType} = ${connectorType}`,
      sql`${accounts.identifier} = ${identifier}`,
    ];
    if (userId) conditions.push(sql`${accounts.userId} = ${userId}`);
    const [account] = await this.db
      .select()
      .from(accounts)
      .where(sql`${sql.join(conditions, sql` AND `)}`);
    return account ? this.decryptAccount(account) : null;
  }

  async remove(id: string) {
    await this.getById(id); // throws if not found

    // Wrap all deletes in a transaction for atomicity
    this.db.transaction((tx) => {
      const accountMemories = tx
        .select({ id: memories.id })
        .from(memories)
        .where(eq(memories.accountId, id))
        .all();
      const memoryIds = accountMemories.map((m) => m.id);

      if (memoryIds.length > 0) {
        for (let i = 0; i < memoryIds.length; i += 500) {
          const batch = memoryIds.slice(i, i + 500);
          tx.delete(memoryContacts).where(inArray(memoryContacts.memoryId, batch)).run();
          tx.delete(memoryLinks).where(inArray(memoryLinks.srcMemoryId, batch)).run();
          tx.delete(memoryLinks).where(inArray(memoryLinks.dstMemoryId, batch)).run();
        }
      }

      tx.delete(memories).where(eq(memories.accountId, id)).run();
      tx.delete(rawEvents).where(eq(rawEvents.accountId, id)).run();
      tx.delete(logs).where(eq(logs.accountId, id)).run();
      tx.delete(jobs).where(eq(jobs.accountId, id)).run();
      tx.delete(accounts).where(eq(accounts.id, id)).run();
    });
  }
}

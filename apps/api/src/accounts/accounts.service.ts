import { Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { accounts } from '../db/schema';
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
  }) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db.insert(accounts).values({
      id,
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

  async getAll() {
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

  async remove(id: string) {
    await this.getById(id);
    await this.db.delete(accounts).where(eq(accounts.id, id));
  }
}

import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { eq, and, sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { memoryBanks, memories, memoryLinks, memoryContacts } from '../db/schema';
import { QdrantService } from '../memory/qdrant.service';

@Injectable()
export class MemoryBanksService {
  constructor(
    private dbService: DbService,
    private qdrant: QdrantService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  async create(userId: string, name: string): Promise<typeof memoryBanks.$inferSelect> {
    const existing = await this.db
      .select()
      .from(memoryBanks)
      .where(and(eq(memoryBanks.userId, userId), eq(memoryBanks.name, name)));
    if (existing.length) {
      throw new BadRequestException(`Memory bank "${name}" already exists`);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db.insert(memoryBanks).values({
      id,
      userId,
      name,
      isDefault: 0,
      createdAt: now,
      updatedAt: now,
    });
    return this.getById(userId, id);
  }

  async list(userId: string) {
    return this.db.select().from(memoryBanks).where(eq(memoryBanks.userId, userId));
  }

  async getById(userId: string, memoryBankId: string) {
    const [bank] = await this.db
      .select()
      .from(memoryBanks)
      .where(and(eq(memoryBanks.id, memoryBankId), eq(memoryBanks.userId, userId)));
    if (!bank) throw new NotFoundException(`Memory bank ${memoryBankId} not found`);
    return bank;
  }

  async rename(userId: string, memoryBankId: string, name: string) {
    const bank = await this.getById(userId, memoryBankId);

    // Check name uniqueness
    const existing = await this.db
      .select()
      .from(memoryBanks)
      .where(and(eq(memoryBanks.userId, userId), eq(memoryBanks.name, name)));
    if (existing.length && existing[0].id !== memoryBankId) {
      throw new BadRequestException(`Memory bank "${name}" already exists`);
    }

    await this.db
      .update(memoryBanks)
      .set({ name, updatedAt: new Date().toISOString() })
      .where(eq(memoryBanks.id, memoryBankId));
    return { ...bank, name };
  }

  async remove(userId: string, memoryBankId: string) {
    const bank = await this.getById(userId, memoryBankId);
    if (bank.isDefault) {
      throw new BadRequestException('Cannot delete the default memory bank');
    }

    // Get memory IDs in this memory bank for cascade cleanup
    const bankMemories = this.dbService.sqlite
      .prepare('SELECT id FROM memories WHERE memory_bank_id = ?')
      .all(memoryBankId) as { id: string }[];
    const memoryIds = bankMemories.map((m) => m.id);

    if (memoryIds.length > 0) {
      // Delete in batches
      for (let i = 0; i < memoryIds.length; i += 500) {
        const batch = memoryIds.slice(i, i + 500);
        const placeholders = batch.map(() => '?').join(',');
        this.dbService.sqlite.prepare(`DELETE FROM memory_contacts WHERE memory_id IN (${placeholders})`).run(...batch);
        this.dbService.sqlite.prepare(`DELETE FROM memory_links WHERE src_memory_id IN (${placeholders}) OR dst_memory_id IN (${placeholders})`).run(...batch, ...batch);
        this.dbService.sqlite.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...batch);
        // Remove from Qdrant
        for (const id of batch) {
          try { await this.qdrant.remove(id); } catch { /* best-effort */ }
        }
      }
    }

    // Delete the memory bank itself
    await this.db.delete(memoryBanks).where(eq(memoryBanks.id, memoryBankId));
    return { deleted: true, memoriesDeleted: memoryIds.length };
  }

  /** Get or create the default memory bank for a user */
  async getOrCreateDefault(userId: string): Promise<typeof memoryBanks.$inferSelect> {
    const [existing] = await this.db
      .select()
      .from(memoryBanks)
      .where(and(eq(memoryBanks.userId, userId), eq(memoryBanks.isDefault, 1)));
    if (existing) return existing;

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db.insert(memoryBanks).values({
      id,
      userId,
      name: 'Default',
      isDefault: 1,
      createdAt: now,
      updatedAt: now,
    });
    return this.getById(userId, id);
  }

  /** Get memory count per memory bank */
  async getMemoryCounts(userId: string): Promise<Record<string, number>> {
    const rows = this.dbService.sqlite
      .prepare(`
        SELECT b.id, COUNT(m.id) as count
        FROM memory_banks b
        LEFT JOIN memories m ON m.memory_bank_id = b.id
        WHERE b.user_id = ?
        GROUP BY b.id
      `)
      .all(userId) as { id: string; count: number }[];
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.id] = row.count;
    return counts;
  }
}

import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { eq, and, sql, inArray } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { CryptoService } from '../crypto/crypto.service';
import { memoryBanks, memories, memoryContacts, memoryLinks } from '../db/schema';
import { TypesenseService } from '../memory/typesense.service';

@Injectable()
export class MemoryBanksService {
  constructor(
    private dbService: DbService,
    private crypto: CryptoService,
    private typesense: TypesenseService,
  ) {}

  /** Decrypt memory bank name */
  private decryptBank<T extends { name: string }>(row: T): T {
    return { ...row, name: this.crypto.decrypt(row.name) ?? row.name };
  }

  private get db() {
    return this.dbService.db;
  }

  async create(userId: string, name: string): Promise<typeof memoryBanks.$inferSelect> {
    // Check uniqueness via HMAC hash
    const nameHash = this.crypto.hmac(name.toLowerCase());
    const existing = await this.db
      .select()
      .from(memoryBanks)
      .where(and(eq(memoryBanks.userId, userId), eq(memoryBanks.nameHash, nameHash)));
    if (existing.length) {
      throw new BadRequestException(`Memory bank "${name}" already exists`);
    }

    const id = crypto.randomUUID();
    const now = new Date();
    await this.db.insert(memoryBanks).values({
      id,
      userId,
      name: this.crypto.encrypt(name)!,
      nameHash,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    });
    return this.getById(userId, id);
  }

  async list(userId: string) {
    const rows = await this.db.select().from(memoryBanks).where(eq(memoryBanks.userId, userId));
    return rows.map((r) => this.decryptBank(r));
  }

  async getById(userId: string, memoryBankId: string) {
    const [bank] = await this.db
      .select()
      .from(memoryBanks)
      .where(and(eq(memoryBanks.id, memoryBankId), eq(memoryBanks.userId, userId)));
    if (!bank) throw new NotFoundException(`Memory bank ${memoryBankId} not found`);
    return this.decryptBank(bank);
  }

  async rename(userId: string, memoryBankId: string, name: string) {
    const bank = await this.getById(userId, memoryBankId);

    // Check name uniqueness via HMAC hash
    const nameHash = this.crypto.hmac(name.toLowerCase());
    const existing = await this.db
      .select()
      .from(memoryBanks)
      .where(and(eq(memoryBanks.userId, userId), eq(memoryBanks.nameHash, nameHash)));
    if (existing.length && existing[0].id !== memoryBankId) {
      throw new BadRequestException(`Memory bank "${name}" already exists`);
    }

    await this.db
      .update(memoryBanks)
      .set({ name: this.crypto.encrypt(name)!, nameHash, updatedAt: new Date() })
      .where(eq(memoryBanks.id, memoryBankId));
    return { ...bank, name };
  }

  async remove(userId: string, memoryBankId: string) {
    const bank = await this.getById(userId, memoryBankId);
    if (bank.isDefault) {
      throw new BadRequestException('Cannot delete the default memory bank');
    }

    // Get memory IDs in this memory bank for cascade cleanup
    const bankMemoryRows = await this.db
      .select({ id: memories.id })
      .from(memories)
      .where(eq(memories.memoryBankId, memoryBankId));
    const memoryIds = bankMemoryRows.map((m) => m.id);

    if (memoryIds.length > 0) {
      // Delete in batches
      for (let i = 0; i < memoryIds.length; i += 500) {
        const batch = memoryIds.slice(i, i + 500);
        await this.db.delete(memoryContacts).where(inArray(memoryContacts.memoryId, batch));
        await this.db.delete(memoryLinks).where(
          sql`${memoryLinks.srcMemoryId} IN (${sql.join(
            batch.map((id) => sql`${id}`),
            sql`, `,
          )}) OR ${memoryLinks.dstMemoryId} IN (${sql.join(
            batch.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        );
        await this.db.delete(memories).where(inArray(memories.id, batch));
        // Remove from Qdrant
        for (const id of batch) {
          try {
            await this.typesense.remove(id);
          } catch {
            /* best-effort */
          }
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
      .where(and(eq(memoryBanks.userId, userId), eq(memoryBanks.isDefault, true)));
    if (existing) return this.decryptBank(existing);

    const id = crypto.randomUUID();
    const now = new Date();
    await this.db.insert(memoryBanks).values({
      id,
      userId,
      name: this.crypto.encrypt('Default')!,
      nameHash: this.crypto.hmac('default'),
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
    return this.getById(userId, id);
  }

  /** Get memory count per memory bank */
  async getMemoryCounts(userId: string): Promise<Record<string, number>> {
    const result = await this.db.execute(
      sql`SELECT b.id, COUNT(m.id) as count
          FROM memory_banks b
          LEFT JOIN memories m ON m.memory_bank_id = b.id
          WHERE b.user_id = ${userId}
          GROUP BY b.id`,
    );
    const counts: Record<string, number> = {};
    for (const row of result.rows as { id: string; count: string }[]) {
      counts[row.id] = Number(row.count);
    }
    return counts;
  }
}

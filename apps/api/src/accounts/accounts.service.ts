import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { eq, sql, inArray } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { CryptoService } from '../crypto/crypto.service';
import { ConnectorsService } from '../connectors/connectors.service';
import { accounts, jobs, rawEvents, memories, memoryLinks, memoryContacts } from '../db/schema';
import type { SyncSchedule } from '@botmem/shared';

@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);

  constructor(
    private dbService: DbService,
    private crypto: CryptoService,
    private connectors: ConnectorsService,
  ) {}

  /** Decrypt authContext and identifier on an account row */
  private decryptAccount<T extends { authContext: string | null; identifier: string }>(row: T): T {
    return {
      ...row,
      authContext: this.crypto.decrypt(row.authContext),
      identifier: this.crypto.decrypt(row.identifier) ?? row.identifier,
    };
  }

  async create(data: {
    connectorType: string;
    identifier: string;
    authContext?: string;
    userId?: string;
  }) {
    const id = crypto.randomUUID();
    const now = new Date();
    await this.dbService.withCurrentUser(async (db) => {
      await db.insert(accounts).values({
        id,
        userId: data.userId || null,
        connectorType: data.connectorType,
        identifier: this.crypto.encrypt(data.identifier)!,
        identifierHash: this.crypto.hmac(data.identifier),
        status: 'connected',
        schedule: 'manual',
        authContext: this.crypto.encrypt(data.authContext || null),
        itemsSynced: 0,
        createdAt: now,
        updatedAt: now,
      });
    });
    return this.getById(id);
  }

  async getAll(userId?: string) {
    const rows = await this.dbService.withCurrentUser((db) => {
      if (userId) {
        return db.select().from(accounts).where(eq(accounts.userId, userId));
      }
      return db.select().from(accounts);
    });
    return rows.map((r) => this.decryptAccount(r));
  }

  async getById(id: string) {
    const [account] = await this.dbService.withCurrentUser((db) =>
      db.select().from(accounts).where(eq(accounts.id, id)),
    );
    if (!account) throw new NotFoundException(`Account ${id} not found`);
    return this.decryptAccount(account);
  }

  async update(
    id: string,
    data: Partial<{
      schedule: SyncSchedule;
      status: string;
      identifier: string;
      authContext: string;
      lastCursor: string;
      lastSyncAt: Date | string;
      itemsSynced: number;
      lastError: string | null;
    }>,
  ) {
    await this.getById(id); // throws if not found
    const { lastSyncAt, ...rest } = data;
    const toSet: Record<string, unknown> = { ...rest, updatedAt: new Date() };
    if (lastSyncAt) {
      toSet.lastSyncAt = new Date(lastSyncAt);
    }
    // Encrypt authContext if being updated
    if ('authContext' in toSet && toSet.authContext != null) {
      toSet.authContext = this.crypto.encrypt(toSet.authContext as string)!;
    }
    // Encrypt identifier if being updated
    if ('identifier' in toSet && toSet.identifier != null) {
      const plainIdentifier = toSet.identifier as string;
      toSet.identifier = this.crypto.encrypt(plainIdentifier)!;
      toSet.identifierHash = this.crypto.hmac(plainIdentifier);
    }
    await this.dbService.withCurrentUser((db) =>
      db.update(accounts).set(toSet).where(eq(accounts.id, id)),
    );
    return this.getById(id);
  }

  async findByTypeAndIdentifier(connectorType: string, identifier: string, userId?: string) {
    const conditions = [
      sql`${accounts.connectorType} = ${connectorType}`,
      sql`${accounts.identifierHash} = ${this.crypto.hmac(identifier)}`,
    ];
    if (userId) conditions.push(sql`${accounts.userId} = ${userId}`);
    const [account] = await this.dbService.withCurrentUser((db) =>
      db
        .select()
        .from(accounts)
        .where(sql`${sql.join(conditions, sql` AND `)}`),
    );
    return account ? this.decryptAccount(account) : null;
  }

  async remove(id: string) {
    const account = await this.getById(id); // throws if not found

    // Revoke connector auth (close sockets, delete session files, etc.)
    try {
      const connector = this.connectors.get(account.connectorType);
      if (connector) {
        const authContext = account.authContext ? JSON.parse(account.authContext) : {};
        await connector.revokeAuth(authContext);
      }
    } catch (err) {
      this.logger.warn(`Failed to revoke auth for account ${id} (${account.connectorType}):`, err);
    }

    // Wrap all deletes in a transaction for atomicity
    await this.dbService.withCurrentUser(async (db) => {
      const accountMemories = await db
        .select({ id: memories.id })
        .from(memories)
        .where(eq(memories.accountId, id));
      const memoryIds = accountMemories.map((m: { id: string }) => m.id);

      if (memoryIds.length > 0) {
        for (let i = 0; i < memoryIds.length; i += 500) {
          const batch = memoryIds.slice(i, i + 500);
          await db.delete(memoryContacts).where(inArray(memoryContacts.memoryId, batch));
          await db.delete(memoryLinks).where(inArray(memoryLinks.srcMemoryId, batch));
          await db.delete(memoryLinks).where(inArray(memoryLinks.dstMemoryId, batch));
        }
      }

      await db.delete(memories).where(eq(memories.accountId, id));
      await db.delete(rawEvents).where(eq(rawEvents.accountId, id));
      await db.delete(jobs).where(eq(jobs.accountId, id));
      await db.delete(accounts).where(eq(accounts.id, id));
    });
  }
}

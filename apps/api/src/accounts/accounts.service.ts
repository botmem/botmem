import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { CryptoService } from '../crypto/crypto.service';
import { ConnectorsService } from '../connectors/connectors.service';
import { TypesenseService } from '../memory/typesense.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { accounts, jobs } from '../db/schema';
import type { SyncSchedule } from '@botmem/shared';

@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);

  constructor(
    private dbService: DbService,
    private crypto: CryptoService,
    private connectors: ConnectorsService,
    private typesense: TypesenseService,
    private analytics: AnalyticsService,
    @InjectQueue('sync') private syncQueue: Queue,
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
    tunnelMode?: boolean;
    status?: string;
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
        status: data.status || 'connected',
        schedule: 'manual',
        authContext: this.crypto.encrypt(data.authContext || null),
        tunnelMode: data.tunnelMode ?? true,
        itemsSynced: 0,
        createdAt: now,
        updatedAt: now,
      });
    });
    this.analytics.capture(
      'account_created',
      {
        connector_type: data.connectorType,
      },
      data.userId,
    );
    return this.getById(id);
  }

  async getAll(userId?: string, options?: { includeArchived?: boolean }) {
    const rows = await this.dbService.withCurrentUser((db) => {
      const activeOnly = sql`${accounts.status} NOT IN ('archived', 'inactive')`;
      if (userId) {
        return db
          .select()
          .from(accounts)
          .where(
            options?.includeArchived
              ? eq(accounts.userId, userId)
              : sql`${accounts.userId} = ${userId} AND ${activeOnly}`,
          );
      }
      return options?.includeArchived
        ? db.select().from(accounts)
        : db.select().from(accounts).where(activeOnly);
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
      lastCursor: string | null;
      lastSyncAt: Date | string;
      itemsSynced: number;
      lastError: string | null;
      tunnelMode: boolean;
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

    await this.stopAccountJobs(id);

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

    // Remove BullMQ repeatable sync jobs for this account
    try {
      const repeatJobs = await this.syncQueue.getRepeatableJobs();
      for (const rj of repeatJobs) {
        if (rj.name === `scheduled:${id}`) {
          await this.syncQueue.removeRepeatableByKey(rj.key);
        }
      }
    } catch (err) {
      this.logger.warn(`Failed to clean BullMQ jobs for account ${id}:`, err);
    }

    // Delete means remove the connector connection, not the data it already imported.
    // Keep memories, raw events, contacts, credentials history, and job history.
    await this.dbService.withCurrentUser(async (db) => {
      await db
        .update(jobs)
        .set({
          status: 'cancelled',
          error: 'Cancelled because connector account was deleted',
          completedAt: new Date(),
        })
        .where(sql`${jobs.accountId} = ${id} AND ${jobs.status} IN ('queued', 'running')`);
      await db
        .update(accounts)
        .set({
          status: 'archived',
          schedule: 'manual',
          authContext: null,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, id));
    });

    this.analytics.capture(
      'account_deleted',
      {
        connector_type: account.connectorType,
        data_deleted: false,
      },
      account.userId ?? undefined,
    );
  }

  private async stopAccountJobs(accountId: string) {
    let jobRows: Array<{ id: string }> = [];
    try {
      jobRows = await this.dbService.withCurrentUser((db) =>
        db
          .select({ id: jobs.id })
          .from(jobs)
          .where(sql`${jobs.accountId} = ${accountId} AND ${jobs.status} IN ('queued', 'running')`),
      );
    } catch (err) {
      this.logger.warn(`Failed to list active jobs for account ${accountId}:`, err);
    }

    for (const job of jobRows) {
      try {
        if (typeof this.syncQueue.getJob !== 'function') return;
        const bullJob = await this.syncQueue.getJob(job.id);
        if (!bullJob) continue;
        const state = await bullJob.getState().catch(() => 'unknown');
        if (state === 'active') {
          try {
            bullJob.discard();
          } catch {
            // Best-effort cleanup before removing orphaned queue jobs.
          }
        }
        await bullJob.remove();
      } catch (err) {
        this.logger.warn(`Failed to remove BullMQ job ${job.id} for account ${accountId}:`, err);
      }
    }
  }

  async archive(id: string) {
    await this.getById(id);
    await this.dbService.withCurrentUser((db) =>
      db
        .update(accounts)
        .set({
          status: 'archived',
          schedule: 'manual',
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, id)),
    );
    return this.getById(id);
  }

  async restore(id: string) {
    await this.getById(id);
    await this.dbService.withCurrentUser((db) =>
      db
        .update(accounts)
        .set({ status: 'connected', lastError: null, updatedAt: new Date() })
        .where(eq(accounts.id, id)),
    );
    return this.getById(id);
  }
}

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  NotFoundException,
} from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { DbService } from '../db/db.service';
import { ImsgTunnelService } from '../imsg-tunnel/imsg-tunnel.service';
import { jobs, memorySearchIndex } from '../db/schema';
import { sql, inArray, desc, and } from 'drizzle-orm';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../user-auth/decorators/current-user.decorator';
import { RequiresJwt } from '../user-auth/decorators/requires-jwt.decorator';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import type { ConnectorAccount } from '@botmem/shared';

function normalizeAccountError(
  connectorType: string,
  accountId: string,
  error: string | null,
): string | null {
  if (!error) return null;
  if (connectorType === 'imessage' && error.includes('bridge')) {
    return `iMessage bridge not connected. Start the Botmem iMessage bridge from connector setup, then run \`botmem sync ${accountId}\`.`;
  }
  if (connectorType === 'imessage' && error.includes('botmem sync <account-id>')) {
    return error.replaceAll('<account-id>', accountId);
  }
  return error;
}

function toApiAccount(
  row: {
    id: string;
    connectorType: string;
    identifier: string;
    status: string;
    schedule: string | null;
    lastSyncAt: Date | string | null;
    itemsSynced: number | null;
    lastError: string | null;
  },
  memoryCount?: number,
  contactsCount?: number,
  groupsCount?: number,
  jobHealth?: {
    phase: string | null;
    lastActivityAt: string | null;
    activeJobId: string | null;
    queuedJobId: string | null;
    progress: number | null;
    total: number | null;
  },
): ConnectorAccount {
  const status = row.status as ConnectorAccount['status'];
  const lastError = normalizeAccountError(row.connectorType, row.id, row.lastError);
  const recoveryReason = lastError || null;
  const recoveryAction =
    status === 'reconnect_required'
      ? row.connectorType === 'whatsapp'
        ? 'rescan_qr'
        : 'reconnect'
      : status === 'failed' && row.connectorType === 'imessage'
        ? 'start_bridge'
        : status === 'failed'
          ? 'retry'
          : null;

  return {
    id: row.id,
    type: row.connectorType,
    identifier: row.identifier,
    status,
    schedule: row.schedule as ConnectorAccount['schedule'],
    lastSync: row.lastSyncAt ? String(row.lastSyncAt) : null,
    memoriesIngested: memoryCount ?? row.itemsSynced ?? 0,
    contactsCount: contactsCount ?? 0,
    groupsCount: groupsCount ?? 0,
    lastError,
    syncHealth: {
      phase: jobHealth?.phase ?? null,
      lastActivityAt: jobHealth?.lastActivityAt ?? null,
      activeJobId: jobHealth?.activeJobId ?? null,
      queuedJobId: jobHealth?.queuedJobId ?? null,
      progress: jobHealth?.progress ?? null,
      total: jobHealth?.total ?? null,
      recoveryAction,
      recoveryReason,
    },
  };
}

@ApiTags('Accounts')
@ApiBearerAuth()
@Controller('accounts')
export class AccountsController {
  constructor(
    private accountsService: AccountsService,
    private dbService: DbService,
    private imsgTunnel: ImsgTunnelService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: { id: string },
    @Query('includeArchived') includeArchived?: string,
  ) {
    const rows = await this.accountsService.getAll(user.id, {
      includeArchived: includeArchived === 'true',
    });

    return this.dbService.withCurrentUser(async (db) => {
      // Count searchable memories per account from the indexed projection. The memories table
      // carries encrypted payloads and is expensive to aggregate on dashboard load.
      const accountIds = rows.map((r) => r.id);
      const memoryCounts = accountIds.length
        ? await db
            .select({ accountId: memorySearchIndex.accountId, count: sql<number>`count(*)::int` })
            .from(memorySearchIndex)
            .where(inArray(memorySearchIndex.accountId, accountIds))
            .groupBy(memorySearchIndex.accountId)
        : [];
      const memoryCountMap = new Map(memoryCounts.map((c) => [c.accountId, c.count]));

      const latestJobs = accountIds.length
        ? await db
            .select({
              id: jobs.id,
              accountId: jobs.accountId,
              status: jobs.status,
              progress: jobs.progress,
              total: jobs.total,
              startedAt: jobs.startedAt,
              createdAt: jobs.createdAt,
            })
            .from(jobs)
            .where(
              and(inArray(jobs.accountId, accountIds), inArray(jobs.status, ['running', 'queued'])),
            )
            .orderBy(desc(jobs.createdAt))
        : [];
      const jobHealthMap = new Map<
        string,
        {
          phase: string | null;
          lastActivityAt: string | null;
          activeJobId: string | null;
          queuedJobId: string | null;
          progress: number | null;
          total: number | null;
        }
      >();
      for (const job of latestJobs) {
        if (jobHealthMap.has(job.accountId)) continue;
        const lastActivity = job.startedAt || job.createdAt;
        jobHealthMap.set(job.accountId, {
          phase: job.status === 'queued' ? 'Queued for sync' : 'Syncing connector data',
          lastActivityAt:
            lastActivity instanceof Date ? lastActivity.toISOString() : String(lastActivity),
          activeJobId: job.status === 'running' ? job.id : null,
          queuedJobId: job.status === 'queued' ? job.id : null,
          progress: job.progress,
          total: job.total,
        });
      }

      return {
        accounts: rows.map((r) =>
          toApiAccount(r, memoryCountMap.get(r.id) ?? 0, 0, 0, jobHealthMap.get(r.id)),
        ),
      };
    });
  }

  @Get(':id')
  async get(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    const account = await this.accountsService.getById(id);
    // IDOR fix: return 404 (not 403) to prevent enumeration
    if (account.userId !== user.id) {
      throw new NotFoundException('Account not found');
    }
    return toApiAccount(account);
  }

  @Get(':id/bridge-status')
  async bridgeStatus(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    const account = await this.accountsService.getById(id);
    if (account.userId !== user.id) {
      throw new NotFoundException('Account not found');
    }
    return { connected: this.imsgTunnel.isConnected(id) };
  }

  @RequiresJwt()
  @Post()
  async create(@CurrentUser() user: { id: string }, @Body() dto: CreateAccountDto) {
    // Dedup: return existing account if one already exists for this connector+identifier FOR THIS USER
    const existing = await this.accountsService.findByTypeAndIdentifier(
      dto.connectorType,
      dto.identifier,
      user.id,
    );
    if (existing) return toApiAccount(existing);
    const row = await this.accountsService.create({ ...dto, userId: user.id });
    return toApiAccount(row);
  }

  @RequiresJwt()
  @Patch(':id')
  async update(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: UpdateAccountDto,
  ) {
    // IDOR fix: verify account belongs to user
    const account = await this.accountsService.getById(id);
    if (account.userId !== user.id) {
      throw new NotFoundException('Account not found');
    }
    const row = await this.accountsService.update(id, dto);
    return toApiAccount(row);
  }

  @RequiresJwt()
  @Post(':id/archive')
  async archive(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    const account = await this.accountsService.getById(id);
    if (account.userId !== user.id) {
      throw new NotFoundException('Account not found');
    }
    const row = await this.accountsService.archive(id);
    return toApiAccount(row);
  }

  @RequiresJwt()
  @Post(':id/restore')
  async restore(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    const account = await this.accountsService.getById(id);
    if (account.userId !== user.id) {
      throw new NotFoundException('Account not found');
    }
    const row = await this.accountsService.restore(id);
    return toApiAccount(row);
  }

  @RequiresJwt()
  @Delete(':id')
  async remove(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    // IDOR fix: verify account belongs to user
    const account = await this.accountsService.getById(id);
    if (account.userId !== user.id) {
      throw new NotFoundException('Account not found');
    }
    await this.accountsService.remove(id);
    return { ok: true };
  }
}

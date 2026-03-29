import { Controller, Get, Post, Delete, Param, Query, Body, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { JobsService } from './jobs.service';
import { AccountsService } from '../accounts/accounts.service';
import { MemoryBanksService } from '../memory-banks/memory-banks.service';
import { DbService } from '../db/db.service';
import { accounts } from '../db/schema';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequiresJwt } from '../user-auth/decorators/requires-jwt.decorator';
import { CurrentUser } from '../user-auth/decorators/current-user.decorator';
import type { Job } from '@botmem/shared';

function toApiJob(row: {
  id: string;
  connectorType: string;
  accountId: string;
  accountIdentifier: string | null;
  memoryBankId: string | null;
  status: string;
  priority: number;
  progress: number;
  total: number;
  startedAt: Date | null;
  completedAt: Date | null;
  error: string | null;
}): Job & { memoryBankId?: string | null } {
  return {
    id: row.id,
    connector: row.connectorType,
    accountId: row.accountId,
    accountIdentifier: row.accountIdentifier || null,
    memoryBankId: row.memoryBankId || null,
    status: row.status as Job['status'],
    priority: row.priority,
    progress: row.progress,
    total: row.total,
    startedAt:
      row.startedAt instanceof Date
        ? row.startedAt.toISOString()
        : (row.startedAt as string | null),
    completedAt:
      row.completedAt instanceof Date
        ? row.completedAt.toISOString()
        : (row.completedAt as string | null),
    error: row.error,
  };
}

@ApiTags('Jobs')
@ApiBearerAuth()
@Controller('jobs')
export class JobsController {
  private readonly logger = new Logger(JobsController.name);
  constructor(
    private jobsService: JobsService,
    private accountsService: AccountsService,
    private memoryBanksService: MemoryBanksService,
    private dbService: DbService,
  ) {}

  @Get()
  async list(@CurrentUser() user: { id: string }, @Query('accountId') accountId?: string) {
    // User isolation: only show jobs for user's accounts (filtered at DB level)
    const rows = await this.jobsService.getAllForUser(user.id, { accountId });
    return { jobs: rows.map(toApiJob) };
  }

  @Get(':id')
  async get(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    const row = await this.jobsService.getById(id);
    if (!row) return { error: 'not found' };
    // IDOR fix: verify job belongs to user's account
    const userAccounts = await this.dbService.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.userId, user.id));
    const userAccountIds = new Set(userAccounts.map((a) => a.id));
    if (!userAccountIds.has(row.accountId)) return { error: 'not found' };
    return toApiJob(row);
  }

  @RequiresJwt()
  @Post('sync/:accountId')
  async triggerSync(
    @CurrentUser() user: { id: string },
    @Param('accountId') accountId: string,
    @Body() body?: { memoryBankId?: string },
  ) {
    const account = await this.accountsService.getById(accountId);
    // IDOR fix: verify account belongs to user
    if (account.userId !== user.id) return { error: 'not found' };

    // Validate memoryBankId belongs to the current user if provided
    if (body?.memoryBankId) {
      await this.memoryBanksService.getById(user.id, body.memoryBankId);
    }

    const row = await this.jobsService.triggerSync(
      accountId,
      account.connectorType,
      account.identifier,
      body?.memoryBankId,
    );
    return { job: toApiJob(row) };
  }

  @RequiresJwt()
  @Delete(':id')
  async cancel(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    // IDOR fix: verify job belongs to user's account
    const row = await this.jobsService.getById(id);
    if (!row) return { error: 'not found' };
    const userAccounts = await this.dbService.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.userId, user.id));
    if (!userAccounts.some((a) => a.id === row.accountId)) return { error: 'not found' };
    await this.jobsService.cancel(id);
    return { ok: true };
  }
}

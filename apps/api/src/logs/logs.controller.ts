import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { eq } from 'drizzle-orm';
import { LogsService } from './logs.service';
import { DbService } from '../db/db.service';
import { accounts } from '../db/schema';
import { CurrentUser } from '../user-auth/decorators/current-user.decorator';

@ApiTags('Logs')
@ApiBearerAuth()
@Controller('logs')
export class LogsController {
  constructor(
    private logsService: LogsService,
    private dbService: DbService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: { id: string },
    @Query('jobId') jobId?: string,
    @Query('accountId') accountId?: string,
    @Query('level') level?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    // IDOR fix: scope logs to user's accounts
    const userAccounts = await this.dbService.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.userId, user.id));
    const userAccountIds = new Set(userAccounts.map((a) => a.id));

    // If accountId filter is provided, verify it belongs to user
    if (accountId && !userAccountIds.has(accountId)) {
      return { logs: [], total: 0 };
    }

    const result = await this.logsService.query({
      jobId,
      accountId,
      level,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });

    // Filter logs to only those belonging to user's accounts
    const filteredLogs = result.logs.filter(
      (log) => !log.accountId || userAccountIds.has(log.accountId as string),
    );

    return { logs: filteredLogs, total: filteredLogs.length };
  }
}

import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { desc, eq, isNotNull, sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { accounts, jobs } from '../db/schema';
import { CurrentUser } from '../user-auth/decorators/current-user.decorator';
import { LogsService } from './logs.service';

@ApiTags('Logs')
@ApiBearerAuth()
@Controller('logs')
export class LogsController {
  constructor(
    private readonly logsService: LogsService,
    private readonly dbService: DbService,
  ) {}

  @Get()
  async query(
    @Query('jobId') jobId?: string,
    @Query('accountId') accountId?: string,
    @Query('level') level?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.logsService.query({
      jobId,
      accountId,
      level,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  @Get('summary')
  async summary(
    @CurrentUser() user: { id: string },
    @Query('limit') limitParam?: string,
    @Query('includeArchived') includeArchived?: string,
  ) {
    const limit = Math.min(parseInt(limitParam || '50', 10) || 50, 200);
    const logs = await this.logsService.query({ level: 'error', limit });
    const includeInactive = includeArchived === 'true';

    const [jobErrors, accountErrors] = await Promise.all([
      this.dbService.withCurrentUser((db) =>
        db
          .select({
            id: jobs.id,
            accountId: jobs.accountId,
            connectorType: jobs.connectorType,
            status: jobs.status,
            error: jobs.error,
            completedAt: jobs.completedAt,
            createdAt: jobs.createdAt,
          })
          .from(jobs)
          .innerJoin(accounts, eq(jobs.accountId, accounts.id))
          .where(
            sql`${accounts.userId} = ${user.id} AND ${jobs.error} IS NOT NULL${
              includeInactive ? sql`` : sql` AND ${accounts.status} NOT IN ('archived', 'inactive')`
            }`,
          )
          .orderBy(desc(jobs.createdAt))
          .limit(limit),
      ),
      this.dbService.withCurrentUser((db) =>
        db
          .select({
            id: accounts.id,
            connectorType: accounts.connectorType,
            status: accounts.status,
            lastError: accounts.lastError,
            updatedAt: accounts.updatedAt,
          })
          .from(accounts)
          .where(
            includeInactive
              ? sql`${accounts.userId} = ${user.id} AND ${isNotNull(accounts.lastError)}`
              : sql`${accounts.userId} = ${user.id} AND ${isNotNull(accounts.lastError)} AND ${accounts.status} NOT IN ('archived', 'inactive')`,
          )
          .orderBy(desc(accounts.updatedAt))
          .limit(limit),
      ),
    ]);

    return {
      logs: logs.logs,
      jobs: jobErrors,
      accounts: accountErrors,
      counts: {
        logs: logs.total,
        jobs: jobErrors.length,
        accounts: accountErrors.length,
      },
    };
  }
}

import { Controller, Get, Post, Delete, Param, Query } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { JobsService } from './jobs.service';
import { AccountsService } from '../accounts/accounts.service';
import type { Job } from '@botmem/shared';

function toApiJob(row: any): Job {
  return {
    id: row.id,
    connector: row.connectorType,
    accountId: row.accountId,
    accountIdentifier: row.accountIdentifier || null,
    status: row.status,
    priority: row.priority,
    progress: row.progress,
    total: row.total,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    error: row.error,
  };
}

@Controller('jobs')
export class JobsController {
  constructor(
    private jobsService: JobsService,
    private accountsService: AccountsService,
    @InjectQueue('sync') private syncQueue: Queue,
    @InjectQueue('embed') private embedQueue: Queue,
    @InjectQueue('enrich') private enrichQueue: Queue,
    @InjectQueue('backfill') private backfillQueue: Queue,
  ) {}

  @Get()
  async list(@Query('accountId') accountId?: string) {
    const rows = await this.jobsService.getAll({ accountId });
    return { jobs: rows.map(toApiJob) };
  }

  @Get('queues')
  async queues() {
    const getStats = async (queue: Queue) => {
      const [waiting, active, completed, failed, delayed] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getCompletedCount(),
        queue.getFailedCount(),
        queue.getDelayedCount(),
      ]);
      return { waiting, active, completed, failed, delayed };
    };
    const [sync, embed, enrich, backfill] = await Promise.all([
      getStats(this.syncQueue),
      getStats(this.embedQueue),
      getStats(this.enrichQueue),
      getStats(this.backfillQueue),
    ]);
    return { sync, embed, enrich, backfill };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const row = await this.jobsService.getById(id);
    if (!row) return { error: 'not found' };
    return toApiJob(row);
  }

  @Post('sync/:accountId')
  async triggerSync(@Param('accountId') accountId: string) {
    const account = await this.accountsService.getById(accountId);
    const row = await this.jobsService.triggerSync(accountId, account.connectorType, account.identifier);
    return { job: toApiJob(row) };
  }

  @Delete(':id')
  async cancel(@Param('id') id: string) {
    await this.jobsService.cancel(id);
    return { ok: true };
  }
}

import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AccountsService } from '../accounts/accounts.service';
import { ConfigService } from '../config/config.service';

const SCHEDULE_CRON: Record<string, string> = {
  '15min': '*/15 * * * *',
  hourly: '0 * * * *',
  daily: '0 0 * * *',
};

@Injectable()
export class SchedulerService implements OnModuleInit {
  constructor(
    @InjectQueue('sync') private syncQueue: Queue,
    @InjectQueue('maintenance') private maintenanceQueue: Queue,
    private accountsService: AccountsService,
    private config: ConfigService,
  ) {}

  async onModuleInit() {
    await this.syncAllSchedules();
    await this.scheduleDecay();
  }

  private async scheduleDecay() {
    await this.maintenanceQueue.upsertJobScheduler(
      'nightly-decay',
      { pattern: this.config.decayCron },
      { name: 'decay', data: {}, opts: { attempts: 2, backoff: { type: 'fixed', delay: 60000 } } },
    );
  }

  async syncAllSchedules() {
    const accounts = await this.accountsService.getAll();
    for (const account of accounts) {
      await this.setSchedule(account.id, account.connectorType, account.schedule);
    }
  }

  async setSchedule(accountId: string, connectorType: string, schedule: string) {
    const repeatKey = `scheduled:${accountId}`;

    // Remove existing repeatable job
    const repeatableJobs = await this.syncQueue.getRepeatableJobs();
    for (const rj of repeatableJobs) {
      if (rj.name === repeatKey) {
        await this.syncQueue.removeRepeatableByKey(rj.key);
      }
    }

    const cron = SCHEDULE_CRON[schedule];
    if (!cron) return; // 'manual' has no cron

    await this.syncQueue.add(
      repeatKey,
      { accountId, connectorType, jobId: crypto.randomUUID() },
      { repeat: { pattern: cron } },
    );
  }
}

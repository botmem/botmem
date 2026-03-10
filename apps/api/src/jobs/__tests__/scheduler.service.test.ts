import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SchedulerService } from '../scheduler.service';

describe('SchedulerService', () => {
  let service: SchedulerService;
  let syncQueue: any;
  let maintenanceQueue: any;
  let accountsService: any;
  let configService: any;

  beforeEach(() => {
    syncQueue = {
      add: vi.fn().mockResolvedValue(undefined),
      getRepeatableJobs: vi.fn().mockResolvedValue([]),
      removeRepeatableByKey: vi.fn().mockResolvedValue(undefined),
    };

    maintenanceQueue = {
      upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
    };

    accountsService = {
      getAll: vi.fn().mockResolvedValue([]),
    };

    configService = {
      decayCron: '0 3 * * *',
    };

    service = new SchedulerService(syncQueue, maintenanceQueue, accountsService, configService as any);
  });

  describe('onModuleInit', () => {
    it('syncs all schedules and schedules decay', async () => {
      await service.onModuleInit();
      expect(accountsService.getAll).toHaveBeenCalled();
      expect(maintenanceQueue.upsertJobScheduler).toHaveBeenCalledWith(
        'nightly-decay',
        { pattern: '0 3 * * *' },
        expect.objectContaining({ name: 'decay' }),
      );
    });
  });

  describe('setSchedule', () => {
    it('adds hourly cron job', async () => {
      await service.setSchedule('acc-1', 'gmail', 'hourly');
      expect(syncQueue.add).toHaveBeenCalledWith(
        'scheduled:acc-1',
        expect.objectContaining({ accountId: 'acc-1', connectorType: 'gmail' }),
        { repeat: { pattern: '0 * * * *' } },
      );
    });

    it('adds daily cron job', async () => {
      await service.setSchedule('acc-1', 'gmail', 'daily');
      expect(syncQueue.add).toHaveBeenCalledWith(
        'scheduled:acc-1',
        expect.anything(),
        { repeat: { pattern: '0 0 * * *' } },
      );
    });

    it('adds every-6h cron job', async () => {
      await service.setSchedule('acc-1', 'gmail', 'every-6h');
      expect(syncQueue.add).toHaveBeenCalledWith(
        'scheduled:acc-1',
        expect.anything(),
        { repeat: { pattern: '0 */6 * * *' } },
      );
    });

    it('does not add job for manual schedule', async () => {
      await service.setSchedule('acc-1', 'gmail', 'manual');
      expect(syncQueue.add).not.toHaveBeenCalled();
    });

    it('removes existing repeatable job before adding new one', async () => {
      syncQueue.getRepeatableJobs.mockResolvedValueOnce([
        { name: 'scheduled:acc-1', key: 'old-key' },
        { name: 'scheduled:acc-2', key: 'other-key' },
      ]);

      await service.setSchedule('acc-1', 'gmail', 'hourly');
      expect(syncQueue.removeRepeatableByKey).toHaveBeenCalledWith('old-key');
      expect(syncQueue.removeRepeatableByKey).toHaveBeenCalledTimes(1);
    });
  });

  describe('syncAllSchedules', () => {
    it('sets schedule for each account', async () => {
      accountsService.getAll.mockResolvedValueOnce([
        { id: 'acc-1', connectorType: 'gmail', schedule: 'hourly' },
        { id: 'acc-2', connectorType: 'slack', schedule: 'daily' },
      ]);

      await service.syncAllSchedules();
      expect(syncQueue.add).toHaveBeenCalledTimes(2);
    });
  });
});

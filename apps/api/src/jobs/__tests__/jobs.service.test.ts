import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JobsService } from '../jobs.service';
import type { DbService } from '../../db/db.service';

describe('JobsService', () => {
  let service: JobsService;
  let mockDb: Record<string, ReturnType<typeof vi.fn>>;
  let syncQueue: {
    add: ReturnType<typeof vi.fn>;
    getJob: ReturnType<typeof vi.fn>;
    getRepeatableJobs: ReturnType<typeof vi.fn>;
  };

  const fakeJob = {
    id: 'job-1',
    accountId: 'acc-1',
    connectorType: 'gmail',
    accountIdentifier: 'test@gmail.com',
    status: 'queued',
    priority: 0,
    progress: 0,
    total: 10,
    error: null,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    memoryBankId: null,
  };

  beforeEach(() => {
    mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
    };

    syncQueue = {
      add: vi.fn().mockResolvedValue(undefined),
      getJob: vi.fn().mockResolvedValue(null),
      getRepeatableJobs: vi.fn().mockResolvedValue([]),
    };

    const traceContext = { current: vi.fn().mockReturnValue(undefined) } as unknown as {
      current: ReturnType<typeof vi.fn>;
    };

    service = new JobsService(
      {
        db: mockDb,
        withCurrentUser: vi
          .fn()
          .mockImplementation((fn: (db: typeof mockDb) => unknown) => fn(mockDb)),
      } as unknown as DbService,
      syncQueue,
      traceContext,
    );
  });

  describe('triggerSync', () => {
    it('creates job and queues sync', async () => {
      mockDb.where.mockResolvedValueOnce([fakeJob]); // select after insert
      const result = await service.triggerSync('acc-1', 'gmail', 'test@gmail.com');
      expect(result).toEqual(fakeJob);
      expect(syncQueue.add).toHaveBeenCalledWith(
        'sync',
        expect.objectContaining({ accountId: 'acc-1', connectorType: 'gmail' }),
        expect.any(Object),
      );
    });
  });

  describe('getAll', () => {
    it('returns all jobs', async () => {
      mockDb.orderBy.mockResolvedValueOnce([fakeJob]);
      const result = await service.getAll();
      expect(result).toEqual([fakeJob]);
    });

    it('filters by accountId', async () => {
      mockDb.orderBy.mockResolvedValueOnce([
        fakeJob,
        { ...fakeJob, id: 'job-2', accountId: 'acc-2' },
      ]);
      const result = await service.getAll({ accountId: 'acc-1' });
      expect(result).toHaveLength(1);
      expect(result[0].accountId).toBe('acc-1');
    });

    it('filters by connectorType', async () => {
      mockDb.orderBy.mockResolvedValueOnce([fakeJob]);
      const result = await service.getAll({ connectorType: 'gmail' });
      expect(result).toHaveLength(1);
    });
  });

  describe('getActive', () => {
    it('returns only running and queued jobs', async () => {
      mockDb.orderBy.mockResolvedValueOnce([
        fakeJob,
        { ...fakeJob, id: 'job-2', status: 'running' },
        { ...fakeJob, id: 'job-3', status: 'done' },
      ]);
      const result = await service.getActive();
      expect(result).toHaveLength(2);
    });
  });

  describe('getById', () => {
    it('returns job when found', async () => {
      mockDb.where.mockResolvedValueOnce([fakeJob]);
      const result = await service.getById('job-1');
      expect(result).toEqual(fakeJob);
    });

    it('returns null when not found', async () => {
      mockDb.where.mockResolvedValueOnce([]);
      const result = await service.getById('bad');
      expect(result).toBeNull();
    });
  });

  describe('updateJob', () => {
    it('updates job fields', async () => {
      await service.updateJob('job-1', { status: 'running', progress: 5 });
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('converts string dates to Date objects', async () => {
      await service.updateJob('job-1', { startedAt: '2025-01-01T00:00:00Z' });
      expect(mockDb.set).toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    it('marks job as cancelled and removes BullMQ job', async () => {
      const bullJob = { remove: vi.fn() };
      syncQueue.getJob.mockResolvedValueOnce(bullJob);

      await service.cancel('job-1');
      expect(mockDb.update).toHaveBeenCalled();
      expect(bullJob.remove).toHaveBeenCalled();
    });

    it('handles missing BullMQ job gracefully', async () => {
      syncQueue.getJob.mockResolvedValueOnce(null);
      await service.cancel('job-1');
      expect(mockDb.update).toHaveBeenCalled();
    });
  });

  describe('incrementProgress', () => {
    it('increments and returns updated state', async () => {
      // incrementProgress uses this.dbService.db directly (not withCurrentUser)
      // First call: update().set().where() — returns void
      // Second call: select...from...where — returns [job]
      mockDb.where
        .mockResolvedValueOnce(undefined) // update set where
        .mockResolvedValueOnce([{ progress: 6, total: 10, status: 'running' }]); // select
      const result = await service.incrementProgress('job-1');
      expect(result.progress).toBe(6);
      expect(result.total).toBe(10);
    });
  });

  describe('tryCompleteJob', () => {
    it('marks job done when progress >= total', async () => {
      mockDb.where.mockResolvedValueOnce([{ progress: 10, total: 10, status: 'running' }]);
      const result = await service.tryCompleteJob('job-1');
      expect(result).toBe(true);
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('returns false when progress < total', async () => {
      mockDb.where.mockResolvedValueOnce([{ progress: 5, total: 10, status: 'running' }]);
      const result = await service.tryCompleteJob('job-1');
      expect(result).toBe(false);
    });

    it('returns false for non-running job', async () => {
      mockDb.where.mockResolvedValueOnce([{ progress: 10, total: 10, status: 'done' }]);
      const result = await service.tryCompleteJob('job-1');
      expect(result).toBe(false);
    });

    it('returns false for missing job', async () => {
      mockDb.where.mockResolvedValueOnce([]);
      const result = await service.tryCompleteJob('bad');
      expect(result).toBe(false);
    });
  });

  describe('deleteJob', () => {
    it('deletes a job', async () => {
      await service.deleteJob('job-1');
      expect(mockDb.delete).toHaveBeenCalled();
    });
  });

  describe('cleanupDone', () => {
    it('deletes completed and cancelled jobs', async () => {
      mockDb.where.mockResolvedValueOnce([{ id: 'job-1' }, { id: 'job-2' }]);
      const result = await service.cleanupDone();
      expect(result).toBe(2);
    });

    it('returns 0 when no done jobs', async () => {
      mockDb.where.mockResolvedValueOnce([]);
      const result = await service.cleanupDone();
      expect(result).toBe(0);
    });
  });
});

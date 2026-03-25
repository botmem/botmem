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
    mockDb = {} as Record<string, ReturnType<typeof vi.fn>>;
    mockDb.select = vi.fn(() => mockDb);
    mockDb.from = vi.fn(() => mockDb);
    mockDb.where = vi.fn(() => mockDb);
    mockDb.limit = vi.fn().mockResolvedValue([]);
    mockDb.orderBy = vi.fn(() => mockDb);
    mockDb.insert = vi.fn(() => mockDb);
    mockDb.values = vi.fn().mockResolvedValue(undefined);
    mockDb.update = vi.fn(() => mockDb);
    mockDb.set = vi.fn(() => mockDb);
    mockDb.delete = vi.fn(() => mockDb);

    syncQueue = {
      add: vi.fn().mockResolvedValue(undefined),
      getJob: vi.fn().mockResolvedValue(null),
      getRepeatableJobs: vi.fn().mockResolvedValue([]),
    };

    const cryptoService = {
      encrypt: vi.fn((v: string | null) => (v ? `enc:${v}` : null)),
      decrypt: vi.fn((v: string | null) => (v ? v.replace('enc:', '') : v)),
      hmac: vi.fn((v: string) => `hmac:${v}`),
    };

    const traceContext = { current: vi.fn().mockReturnValue(undefined) } as unknown as {
      current: ReturnType<typeof vi.fn>;
    };

    const eventsService = {
      emitToChannel: vi.fn(),
    };

    const quotaService = {
      canCreateMemory: vi.fn().mockResolvedValue({ allowed: true, used: 0, limit: null }),
    };

    service = new JobsService(
      {
        db: mockDb,
        withCurrentUser: vi
          .fn()
          .mockImplementation((fn: (db: typeof mockDb) => unknown) => fn(mockDb)),
      } as unknown as DbService,
      cryptoService as unknown as import('../../crypto/crypto.service').CryptoService,
      syncQueue,
      traceContext,
      eventsService as unknown as import('../../events/events.service').EventsService,
      quotaService as unknown as import('../../billing/quota.service').QuotaService,
    );
  });

  describe('triggerSync', () => {
    it('creates job and queues sync', async () => {
      // where calls: 1=dedup(chain), 2=quota(chain), 3=select-after-insert(resolve)
      // limit calls: 1=dedup(no job), 2=quota(uses default [])
      mockDb.where
        .mockReturnValueOnce(mockDb) // dedup where → chain to .limit()
        .mockReturnValueOnce(mockDb) // quota where → chain to .limit()
        .mockResolvedValueOnce([fakeJob]); // select-after-insert → resolve
      mockDb.limit.mockResolvedValueOnce([]); // dedup limit → no existing job
      const result = await service.triggerSync('acc-1', 'gmail', 'test@gmail.com');
      expect(result).toEqual(fakeJob);
      expect(syncQueue.add).toHaveBeenCalledWith(
        'sync',
        expect.objectContaining({ accountId: 'acc-1', connectorType: 'gmail' }),
        expect.any(Object),
      );
    });

    it('skips sync when job already queued/running for account', async () => {
      const existingJob = { ...fakeJob, id: 'existing-job', status: 'running' };
      // where calls: 1=dedup(chain), 2=select-existing(resolve)
      mockDb.where
        .mockReturnValueOnce(mockDb) // dedup where → chain to .limit()
        .mockResolvedValueOnce([existingJob]); // select existing → resolve
      mockDb.limit.mockResolvedValueOnce([existingJob]); // dedup limit → found existing
      const result = await service.triggerSync('acc-1', 'gmail', 'test@gmail.com');
      expect(result).toEqual(existingJob);
      // Should NOT have enqueued a new job
      expect(syncQueue.add).not.toHaveBeenCalled();
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

  describe('onApplicationBootstrap', () => {
    it('resets stale syncing accounts to connected', async () => {
      mockDb.returning = vi.fn().mockResolvedValueOnce([{ id: 'acc-1' }]);
      mockDb.where.mockReturnValueOnce(mockDb); // syncing accounts update
      mockDb.set.mockReturnValueOnce(mockDb); // chain

      // Mock remaining calls for jobs reset (running + queued) + orphan cleanup
      mockDb.returning
        .mockResolvedValueOnce([]) // running jobs
        .mockResolvedValueOnce([]); // queued jobs
      mockDb.where
        .mockReturnValueOnce(mockDb) // running jobs update
        .mockReturnValueOnce(mockDb); // queued jobs update
      mockDb.set
        .mockReturnValueOnce(mockDb) // running jobs
        .mockReturnValueOnce(mockDb); // queued jobs

      syncQueue.getRepeatableJobs.mockResolvedValueOnce([]);

      await service.onApplicationBootstrap();
      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.set).toHaveBeenCalled();
    });

    it('resets stale running jobs to failed', async () => {
      mockDb.returning = vi
        .fn()
        .mockResolvedValueOnce([]) // syncing accounts
        .mockResolvedValueOnce([{ id: 'job-1' }]) // running jobs
        .mockResolvedValueOnce([]); // queued jobs
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb);
      mockDb.set
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb);

      syncQueue.getRepeatableJobs.mockResolvedValueOnce([]);

      await service.onApplicationBootstrap();
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('removes orphaned repeat jobs for deleted accounts', async () => {
      mockDb.returning = vi
        .fn()
        .mockResolvedValueOnce([]) // syncing accounts
        .mockResolvedValueOnce([]) // running jobs
        .mockResolvedValueOnce([]); // queued jobs
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb);
      mockDb.set
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb);

      const removeByKey = vi.fn().mockResolvedValue(undefined);
      syncQueue.getRepeatableJobs.mockResolvedValueOnce([
        { name: 'scheduled:deleted-acc', key: 'repeat:abc' },
        { name: 'scheduled:existing-acc', key: 'repeat:def' },
      ]);
      (syncQueue as Record<string, unknown>).removeRepeatableByKey = removeByKey;

      // Account lookup: deleted-acc not found, existing-acc found
      mockDb.limit
        .mockResolvedValueOnce([]) // deleted-acc → not found
        .mockResolvedValueOnce([{ id: 'existing-acc' }]); // existing-acc → found

      await service.onApplicationBootstrap();
      expect(removeByKey).toHaveBeenCalledWith('repeat:abc');
      expect(removeByKey).not.toHaveBeenCalledWith('repeat:def');
    });
  });

  describe('removeRepeatableJobsForAccount', () => {
    it('removes matching repeatable jobs', async () => {
      const removeByKey = vi.fn().mockResolvedValue(undefined);
      (syncQueue as Record<string, unknown>).removeRepeatableByKey = removeByKey;
      syncQueue.getRepeatableJobs.mockResolvedValueOnce([
        { name: 'scheduled:acc-1', key: 'repeat:k1' },
        { name: 'scheduled:acc-2', key: 'repeat:k2' },
      ]);

      const result = await service.removeRepeatableJobsForAccount('acc-1');
      expect(result).toBe(1);
      expect(removeByKey).toHaveBeenCalledWith('repeat:k1');
      expect(removeByKey).not.toHaveBeenCalledWith('repeat:k2');
    });

    it('returns 0 when no matching jobs', async () => {
      syncQueue.getRepeatableJobs.mockResolvedValueOnce([]);
      const result = await service.removeRepeatableJobsForAccount('acc-1');
      expect(result).toBe(0);
    });
  });
});

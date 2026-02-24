import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JobsService } from '../jobs.service';
import { DbService } from '../../db/db.service';
import { createTestDb } from '../../__tests__/helpers/db.helper';
import { accounts } from '../../db/schema';

function createService() {
  const db = createTestDb();
  const dbService = { db } as unknown as DbService;

  const mockQueue = {
    add: vi.fn().mockResolvedValue({}),
    getJob: vi.fn().mockResolvedValue(null),
  };

  const service = new JobsService(dbService, mockQueue as any);
  return { service, db, mockQueue };
}

async function seedAccount(db: any) {
  const now = new Date().toISOString();
  await db.insert(accounts).values({
    id: 'acc-1', connectorType: 'gmail', identifier: 'test@gmail.com',
    status: 'connected', schedule: 'manual', itemsSynced: 0,
    createdAt: now, updatedAt: now,
  });
}

describe('JobsService', () => {
  describe('triggerSync', () => {
    it('creates job in db and adds to queue', async () => {
      const { service, db, mockQueue } = createService();
      await seedAccount(db);

      const job = await service.triggerSync('acc-1', 'gmail');
      expect(job.accountId).toBe('acc-1');
      expect(job.connectorType).toBe('gmail');
      expect(job.status).toBe('queued');
      expect(mockQueue.add).toHaveBeenCalledWith(
        'sync',
        expect.objectContaining({ accountId: 'acc-1', connectorType: 'gmail' }),
        expect.any(Object),
      );
    });
  });

  describe('getAll', () => {
    it('returns empty array when no jobs', async () => {
      const { service } = createService();
      const jobs = await service.getAll();
      expect(jobs).toEqual([]);
    });

    it('returns all jobs', async () => {
      const { service, db } = createService();
      await seedAccount(db);
      await service.triggerSync('acc-1', 'gmail');
      await service.triggerSync('acc-1', 'gmail');

      const jobs = await service.getAll();
      expect(jobs).toHaveLength(2);
    });

    it('filters by accountId', async () => {
      const { service, db } = createService();
      await seedAccount(db);
      await service.triggerSync('acc-1', 'gmail');

      const jobs = await service.getAll({ accountId: 'acc-1' });
      expect(jobs).toHaveLength(1);

      const noJobs = await service.getAll({ accountId: 'nonexistent' });
      expect(noJobs).toHaveLength(0);
    });

    it('filters by connectorType', async () => {
      const { service, db } = createService();
      await seedAccount(db);
      await service.triggerSync('acc-1', 'gmail');

      const jobs = await service.getAll({ connectorType: 'gmail' });
      expect(jobs).toHaveLength(1);

      const noJobs = await service.getAll({ connectorType: 'slack' });
      expect(noJobs).toHaveLength(0);
    });
  });

  describe('getById', () => {
    it('returns job by id', async () => {
      const { service, db } = createService();
      await seedAccount(db);
      const created = await service.triggerSync('acc-1', 'gmail');
      const job = await service.getById(created.id);
      expect(job!.id).toBe(created.id);
    });

    it('returns null for non-existent', async () => {
      const { service } = createService();
      const job = await service.getById('nonexistent');
      expect(job).toBeNull();
    });
  });

  describe('updateJob', () => {
    it('updates job status and progress', async () => {
      const { service, db } = createService();
      await seedAccount(db);
      const created = await service.triggerSync('acc-1', 'gmail');

      await service.updateJob(created.id, { status: 'running', progress: 5, total: 10 });
      const updated = await service.getById(created.id);
      expect(updated!.status).toBe('running');
      expect(updated!.progress).toBe(5);
      expect(updated!.total).toBe(10);
    });
  });

  describe('cancel', () => {
    it('marks job as cancelled', async () => {
      const { service, db } = createService();
      await seedAccount(db);
      const created = await service.triggerSync('acc-1', 'gmail');

      await service.cancel(created.id);
      const cancelled = await service.getById(created.id);
      expect(cancelled!.status).toBe('cancelled');
      expect(cancelled!.completedAt).toBeTruthy();
    });

    it('removes bull job if exists', async () => {
      const { service, db, mockQueue } = createService();
      await seedAccount(db);
      const mockBullJob = { remove: vi.fn() };
      mockQueue.getJob.mockResolvedValue(mockBullJob);

      const created = await service.triggerSync('acc-1', 'gmail');
      await service.cancel(created.id);
      expect(mockBullJob.remove).toHaveBeenCalled();
    });

    it('handles missing bull job gracefully', async () => {
      const { service, db, mockQueue } = createService();
      await seedAccount(db);
      mockQueue.getJob.mockResolvedValue(null);

      const created = await service.triggerSync('acc-1', 'gmail');
      await expect(service.cancel(created.id)).resolves.toBeUndefined();
    });
  });
});

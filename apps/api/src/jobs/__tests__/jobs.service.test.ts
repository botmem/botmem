import { describe, it, expect, vi } from 'vitest';
import { JobsService } from '../jobs.service';
import { DbService } from '../../db/db.service';

function createService() {
  // Mock DB that simulates Drizzle query chains
  const jobsStore: any[] = [];

  const mockDb = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockImplementation(() => jobsStore),
    orderBy: vi.fn().mockImplementation(() => jobsStore),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockImplementation((vals: any) => {
      jobsStore.push(vals);
      return Promise.resolve();
    }),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
  } as any;

  const dbService = { db: mockDb } as unknown as DbService;

  const mockQueue = {
    add: vi.fn().mockResolvedValue({}),
    getJob: vi.fn().mockResolvedValue(null),
  };

  const service = new JobsService(dbService, mockQueue as any);
  return { service, db: mockDb, mockQueue };
}

describe('JobsService', () => {
  it('creates JobsService with mock dependencies', () => {
    const { service } = createService();
    expect(service).toBeDefined();
  });
});

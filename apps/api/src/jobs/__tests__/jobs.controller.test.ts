import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { JobsController } from '../jobs.controller';
import { JobsService } from '../jobs.service';
import { AccountsService } from '../../accounts/accounts.service';
import { MemoryBanksService } from '../../memory-banks/memory-banks.service';
import type { DbService } from '../../db/db.service';
import type { Queue } from 'bullmq';

function createMocks() {
  const jobsService = {
    getAll: vi.fn(),
    getAllForUser: vi.fn(),
    getById: vi.fn(),
    getQueueStats: vi.fn(),
    triggerSync: vi.fn(),
    cancel: vi.fn(),
  } as unknown as JobsService;

  const accountsService = {
    getById: vi.fn(),
  } as unknown as AccountsService;

  const memoryBanksService = {
    getById: vi.fn(),
  } as unknown as MemoryBanksService;

  const rawDb = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: 'a1' }]),
      }),
    }),
  };
  const dbService = {
    db: rawDb,
    userDb: vi.fn((_userId: string, fn) => fn(rawDb)),
  } as unknown as DbService;

  const syncQueue = {} as unknown as Queue;
  const memoryQueue = {} as unknown as Queue;
  const maintenanceQueue = {} as unknown as Queue;
  const embedQueue = {} as unknown as Queue;
  const enrichQueue = {} as unknown as Queue;
  return {
    jobsService,
    accountsService,
    memoryBanksService,
    dbService,
    syncQueue,
    memoryQueue,
    maintenanceQueue,
    embedQueue,
    enrichQueue,
  };
}

const fakeJobRow = {
  id: 'j1',
  connectorType: 'gmail',
  accountId: 'a1',
  status: 'running',
  priority: 0,
  progress: 5,
  total: 10,
  startedAt: '2026-01-01T00:00:00Z',
  completedAt: null,
  error: null,
};

describe('JobsController', () => {
  it('list returns mapped jobs', async () => {
    const {
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      syncQueue,
      memoryQueue,
      maintenanceQueue,
      embedQueue,
      enrichQueue,
    } = createMocks();
    vi.mocked(jobsService.getAllForUser).mockResolvedValue([fakeJobRow]);

    const controller = new JobsController(
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      syncQueue,
      memoryQueue,
      maintenanceQueue,
      embedQueue,
      enrichQueue,
    );
    const result = await controller.list({ id: 'u1' });

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].connector).toBe('gmail');
    expect(result.jobs[0].progress).toBe(5);
  });

  it('list passes accountId filter', async () => {
    const {
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      syncQueue,
      memoryQueue,
      maintenanceQueue,
      embedQueue,
      enrichQueue,
    } = createMocks();
    vi.mocked(jobsService.getAllForUser).mockResolvedValue([]);

    const controller = new JobsController(
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      syncQueue,
      memoryQueue,
      maintenanceQueue,
      embedQueue,
      enrichQueue,
    );
    await controller.list({ id: 'u1' }, 'a1');

    expect(jobsService.getAllForUser).toHaveBeenCalledWith('u1', { accountId: 'a1' });
  });

  it('queues returns queue stats from service', async () => {
    const {
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      syncQueue,
      memoryQueue,
      maintenanceQueue,
      embedQueue,
      enrichQueue,
    } = createMocks();
    vi.mocked(jobsService.getQueueStats).mockResolvedValue({
      sync: { waiting: 0, active: 1, completed: 2, failed: 0, delayed: 3 },
    });

    const controller = new JobsController(
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      syncQueue,
      memoryQueue,
      maintenanceQueue,
      embedQueue,
      enrichQueue,
    );

    const result = await controller.queues();
    expect(result.sync.active).toBe(1);
    expect(jobsService.getQueueStats).toHaveBeenCalledWith({
      sync: syncQueue,
      memory: memoryQueue,
      embed: embedQueue,
      enrich: enrichQueue,
      maintenance: maintenanceQueue,
    });
  });

  it('get returns mapped job', async () => {
    const {
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      syncQueue,
      memoryQueue,
      maintenanceQueue,
      embedQueue,
      enrichQueue,
    } = createMocks();
    vi.mocked(jobsService.getById).mockResolvedValue(fakeJobRow);

    const controller = new JobsController(
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      syncQueue,
      memoryQueue,
      maintenanceQueue,
      embedQueue,
      enrichQueue,
    );
    const result = await controller.get({ id: 'u1' }, 'j1');

    expect(result.id).toBe('j1');
  });

  it('get throws 404 for not found', async () => {
    const {
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      syncQueue,
      memoryQueue,
      maintenanceQueue,
      embedQueue,
      enrichQueue,
    } = createMocks();
    vi.mocked(jobsService.getById).mockResolvedValue(null);

    const controller = new JobsController(
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      syncQueue,
      memoryQueue,
      maintenanceQueue,
      embedQueue,
      enrichQueue,
    );
    await expect(controller.get({ id: 'u1' }, 'nonexistent')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('triggerSync fetches account and triggers', async () => {
    const {
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      syncQueue,
      memoryQueue,
      maintenanceQueue,
      embedQueue,
      enrichQueue,
    } = createMocks();
    vi.mocked(accountsService.getById).mockResolvedValue({
      id: 'a1',
      connectorType: 'gmail',
      identifier: 'test@gmail.com',
      userId: 'u1',
    });
    vi.mocked(jobsService.triggerSync).mockResolvedValue(fakeJobRow);

    const controller = new JobsController(
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      syncQueue,
      memoryQueue,
      maintenanceQueue,
      embedQueue,
      enrichQueue,
    );
    const result = await controller.triggerSync({ id: 'u1' }, 'a1');

    expect(accountsService.getById).toHaveBeenCalledWith('a1');
    expect(jobsService.triggerSync).toHaveBeenCalledWith(
      'a1',
      'gmail',
      'test@gmail.com',
      undefined,
    );
    expect(result.job.id).toBe('j1');
  });

  it('triggerSync skips Apple (live-bridge only) without creating a job', async () => {
    const {
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      syncQueue,
      memoryQueue,
      maintenanceQueue,
      embedQueue,
      enrichQueue,
    } = createMocks();
    vi.mocked(accountsService.getById).mockResolvedValue({
      id: 'a1',
      connectorType: 'apple',
      identifier: 'me@icloud.com',
      userId: 'u1',
    });

    const controller = new JobsController(
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      syncQueue,
      memoryQueue,
      maintenanceQueue,
      embedQueue,
      enrichQueue,
    );
    const result = await controller.triggerSync({ id: 'u1' }, 'a1');

    expect(jobsService.triggerSync).not.toHaveBeenCalled();
    expect(result).toEqual({
      skipped: true,
      reason: 'Apple is live-bridge only; no sync needed.',
    });
  });

  it('triggerSync skips iMessage (live-bridge only) without creating a job', async () => {
    const {
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      syncQueue,
      memoryQueue,
      maintenanceQueue,
      embedQueue,
      enrichQueue,
    } = createMocks();
    vi.mocked(accountsService.getById).mockResolvedValue({
      id: 'a1',
      connectorType: 'imessage',
      identifier: 'me@icloud.com',
      userId: 'u1',
    });

    const controller = new JobsController(
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      syncQueue,
      memoryQueue,
      maintenanceQueue,
      embedQueue,
      enrichQueue,
    );
    const result = await controller.triggerSync({ id: 'u1' }, 'a1');

    expect(jobsService.triggerSync).not.toHaveBeenCalled();
    expect(result).toEqual({
      skipped: true,
      reason: 'Apple is live-bridge only; no sync needed.',
    });
  });

  it('retryFailed skips Apple accounts but retries others', async () => {
    const {
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      syncQueue,
      memoryQueue,
      maintenanceQueue,
      embedQueue,
      enrichQueue,
    } = createMocks();
    vi.mocked(jobsService.getAllForUser).mockResolvedValue([
      { ...fakeJobRow, id: 'j-apple', accountId: 'a-apple', status: 'failed' },
      { ...fakeJobRow, id: 'j-gmail', accountId: 'a-gmail', status: 'failed' },
    ]);
    vi.mocked(accountsService.getById).mockImplementation(async (id: string) =>
      id === 'a-apple'
        ? { id: 'a-apple', connectorType: 'apple', identifier: 'me@icloud.com', userId: 'u1' }
        : { id: 'a-gmail', connectorType: 'gmail', identifier: 'me@gmail.com', userId: 'u1' },
    );
    vi.mocked(jobsService.triggerSync).mockResolvedValue(fakeJobRow);

    const controller = new JobsController(
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      syncQueue,
      memoryQueue,
      maintenanceQueue,
      embedQueue,
      enrichQueue,
    );
    const result = await controller.retryFailed({ id: 'u1' });

    expect(jobsService.triggerSync).toHaveBeenCalledTimes(1);
    expect(jobsService.triggerSync).toHaveBeenCalledWith(
      'a-gmail',
      'gmail',
      'me@gmail.com',
      undefined,
    );
    expect(result).toEqual({ ok: true, retried: 1 });
  });

  it('cancel calls service and returns ok', async () => {
    const {
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      syncQueue,
      memoryQueue,
      maintenanceQueue,
      embedQueue,
      enrichQueue,
    } = createMocks();
    vi.mocked(jobsService.getById).mockResolvedValue(fakeJobRow);
    vi.mocked(jobsService.cancel).mockResolvedValue(undefined);

    const controller = new JobsController(
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      syncQueue,
      memoryQueue,
      maintenanceQueue,
      embedQueue,
      enrichQueue,
    );
    const result = await controller.cancel({ id: 'u1' }, 'j1');

    expect(jobsService.cancel).toHaveBeenCalledWith('j1');
    expect(result).toEqual({ ok: true });
  });
});

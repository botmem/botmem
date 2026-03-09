import { describe, it, expect, vi } from 'vitest';
import { JobsController } from '../jobs.controller';
import { JobsService } from '../jobs.service';
import { AccountsService } from '../../accounts/accounts.service';
import { MemoryBanksService } from '../../memory-banks/memory-banks.service';

function createMocks() {
  const jobsService = {
    getAll: vi.fn(),
    getById: vi.fn(),
    triggerSync: vi.fn(),
    cancel: vi.fn(),
    markStaleRunning: vi.fn().mockResolvedValue(undefined),
  } as unknown as JobsService;

  const accountsService = {
    getById: vi.fn(),
  } as unknown as AccountsService;

  const memoryBanksService = {
    getById: vi.fn(),
  } as unknown as MemoryBanksService;

  const dbService = {
    db: {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: 'a1' }]),
        }),
      }),
    },
  } as any;
  const syncQueue = {} as any;
  const cleanQueue = {} as any;
  const embedQueue = {} as any;
  const enrichQueue = {} as any;
  const backfillQueue = {} as any;

  return {
    jobsService,
    accountsService,
    memoryBanksService,
    dbService,
    syncQueue,
    cleanQueue,
    embedQueue,
    enrichQueue,
    backfillQueue,
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
      cleanQueue,
      embedQueue,
      enrichQueue,
      backfillQueue,
    } = createMocks();
    (jobsService.getAll as any).mockResolvedValue([fakeJobRow]);

    const controller = new JobsController(
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      syncQueue,
      cleanQueue,
      embedQueue,
      enrichQueue,
      backfillQueue,
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
      cleanQueue,
      embedQueue,
      enrichQueue,
      backfillQueue,
    } = createMocks();
    (jobsService.getAll as any).mockResolvedValue([]);

    const controller = new JobsController(
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      syncQueue,
      cleanQueue,
      embedQueue,
      enrichQueue,
      backfillQueue,
    );
    await controller.list({ id: 'u1' }, 'a1');

    expect(jobsService.getAll).toHaveBeenCalledWith({ accountId: 'a1' });
  });

  it('get returns mapped job', async () => {
    const {
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      syncQueue,
      cleanQueue,
      embedQueue,
      enrichQueue,
      backfillQueue,
    } = createMocks();
    (jobsService.getById as any).mockResolvedValue(fakeJobRow);

    const controller = new JobsController(
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      syncQueue,
      cleanQueue,
      embedQueue,
      enrichQueue,
      backfillQueue,
    );
    const result = await controller.get('j1');

    expect(result.id).toBe('j1');
  });

  it('get returns error for not found', async () => {
    const {
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      syncQueue,
      cleanQueue,
      embedQueue,
      enrichQueue,
      backfillQueue,
    } = createMocks();
    (jobsService.getById as any).mockResolvedValue(null);

    const controller = new JobsController(
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      syncQueue,
      cleanQueue,
      embedQueue,
      enrichQueue,
      backfillQueue,
    );
    const result = await controller.get('nonexistent');
    expect(result).toEqual({ error: 'not found' });
  });

  it('triggerSync fetches account and triggers', async () => {
    const {
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      syncQueue,
      cleanQueue,
      embedQueue,
      enrichQueue,
      backfillQueue,
    } = createMocks();
    (accountsService.getById as any).mockResolvedValue({
      id: 'a1',
      connectorType: 'gmail',
      identifier: 'test@gmail.com',
    });
    (jobsService.triggerSync as any).mockResolvedValue(fakeJobRow);

    const controller = new JobsController(
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      syncQueue,
      cleanQueue,
      embedQueue,
      enrichQueue,
      backfillQueue,
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

  it('cancel calls service and returns ok', async () => {
    const {
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      syncQueue,
      cleanQueue,
      embedQueue,
      enrichQueue,
      backfillQueue,
    } = createMocks();
    (jobsService.cancel as any).mockResolvedValue(undefined);

    const controller = new JobsController(
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      syncQueue,
      cleanQueue,
      embedQueue,
      enrichQueue,
      backfillQueue,
    );
    const result = await controller.cancel('j1');

    expect(jobsService.cancel).toHaveBeenCalledWith('j1');
    expect(result).toEqual({ ok: true });
  });
});

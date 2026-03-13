import { describe, it, expect, vi } from 'vitest';
import { JobsController } from '../jobs.controller';
import { JobsService } from '../jobs.service';
import { AccountsService } from '../../accounts/accounts.service';
import { MemoryBanksService } from '../../memory-banks/memory-banks.service';
import type { DbService } from '../../db/db.service';
import type { EventsService } from '../../events/events.service';
import type { Queue } from 'bullmq';

function createMocks() {
  const jobsService = {
    getAll: vi.fn(),
    getById: vi.fn(),
    triggerSync: vi.fn(),
    cancel: vi.fn(),
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
  } as unknown as DbService;

  const events = {
    emitToChannel: vi.fn(),
  } as unknown as EventsService;

  const syncQueue = {} as unknown as Queue;
  const cleanQueue = {} as unknown as Queue;
  const embedQueue = {} as unknown as Queue;
  const enrichQueue = {} as unknown as Queue;
  return {
    jobsService,
    accountsService,
    memoryBanksService,
    dbService,
    events,
    syncQueue,
    cleanQueue,
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
      events,
      syncQueue,
      cleanQueue,
      embedQueue,
      enrichQueue,
    } = createMocks();
    vi.mocked(jobsService.getAll).mockResolvedValue([fakeJobRow]);

    const controller = new JobsController(
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      events,
      syncQueue,
      cleanQueue,
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
      events,
      syncQueue,
      cleanQueue,
      embedQueue,
      enrichQueue,
    } = createMocks();
    vi.mocked(jobsService.getAll).mockResolvedValue([]);

    const controller = new JobsController(
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      events,
      syncQueue,
      cleanQueue,
      embedQueue,
      enrichQueue,
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
      events,
      syncQueue,
      cleanQueue,
      embedQueue,
      enrichQueue,
    } = createMocks();
    vi.mocked(jobsService.getById).mockResolvedValue(fakeJobRow);

    const controller = new JobsController(
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      events,
      syncQueue,
      cleanQueue,
      embedQueue,
      enrichQueue,
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
      events,
      syncQueue,
      cleanQueue,
      embedQueue,
      enrichQueue,
    } = createMocks();
    vi.mocked(jobsService.getById).mockResolvedValue(null);

    const controller = new JobsController(
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      events,
      syncQueue,
      cleanQueue,
      embedQueue,
      enrichQueue,
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
      events,
      syncQueue,
      cleanQueue,
      embedQueue,
      enrichQueue,
    } = createMocks();
    vi.mocked(accountsService.getById).mockResolvedValue({
      id: 'a1',
      connectorType: 'gmail',
      identifier: 'test@gmail.com',
    });
    vi.mocked(jobsService.triggerSync).mockResolvedValue(fakeJobRow);

    const controller = new JobsController(
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      events,
      syncQueue,
      cleanQueue,
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

  it('cancel calls service and returns ok', async () => {
    const {
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      events,
      syncQueue,
      cleanQueue,
      embedQueue,
      enrichQueue,
    } = createMocks();
    vi.mocked(jobsService.cancel).mockResolvedValue(undefined);

    const controller = new JobsController(
      jobsService,
      accountsService,
      memoryBanksService,
      dbService,
      events,
      syncQueue,
      cleanQueue,
      embedQueue,
      enrichQueue,
    );
    const result = await controller.cancel('j1');

    expect(jobsService.cancel).toHaveBeenCalledWith('j1');
    expect(result).toEqual({ ok: true });
  });
});

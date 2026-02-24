import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JobsController } from '../jobs.controller';
import { JobsService } from '../jobs.service';
import { AccountsService } from '../../accounts/accounts.service';

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

  return { jobsService, accountsService };
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
    const { jobsService, accountsService } = createMocks();
    (jobsService.getAll as any).mockResolvedValue([fakeJobRow]);

    const controller = new JobsController(jobsService, accountsService);
    const result = await controller.list();

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].connector).toBe('gmail');
    expect(result.jobs[0].progress).toBe(5);
  });

  it('list passes accountId filter', async () => {
    const { jobsService, accountsService } = createMocks();
    (jobsService.getAll as any).mockResolvedValue([]);

    const controller = new JobsController(jobsService, accountsService);
    await controller.list('a1');

    expect(jobsService.getAll).toHaveBeenCalledWith({ accountId: 'a1' });
  });

  it('get returns mapped job', async () => {
    const { jobsService, accountsService } = createMocks();
    (jobsService.getById as any).mockResolvedValue(fakeJobRow);

    const controller = new JobsController(jobsService, accountsService);
    const result = await controller.get('j1');

    expect(result.id).toBe('j1');
  });

  it('get returns error for not found', async () => {
    const { jobsService, accountsService } = createMocks();
    (jobsService.getById as any).mockResolvedValue(null);

    const controller = new JobsController(jobsService, accountsService);
    const result = await controller.get('nonexistent');
    expect(result).toEqual({ error: 'not found' });
  });

  it('triggerSync fetches account and triggers', async () => {
    const { jobsService, accountsService } = createMocks();
    (accountsService.getById as any).mockResolvedValue({ id: 'a1', connectorType: 'gmail', identifier: 'test@gmail.com' });
    (jobsService.triggerSync as any).mockResolvedValue(fakeJobRow);

    const controller = new JobsController(jobsService, accountsService);
    const result = await controller.triggerSync('a1');

    expect(accountsService.getById).toHaveBeenCalledWith('a1');
    expect(jobsService.triggerSync).toHaveBeenCalledWith('a1', 'gmail', 'test@gmail.com');
    expect(result.job.id).toBe('j1');
  });

  it('cancel calls service and returns ok', async () => {
    const { jobsService, accountsService } = createMocks();
    (jobsService.cancel as any).mockResolvedValue(undefined);

    const controller = new JobsController(jobsService, accountsService);
    const result = await controller.cancel('j1');

    expect(jobsService.cancel).toHaveBeenCalledWith('j1');
    expect(result).toEqual({ ok: true });
  });
});

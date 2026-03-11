import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AccountsController } from '../accounts.controller';
import { AccountsService } from '../accounts.service';
import { DbService } from '../../db/db.service';

function mockAccountsService() {
  return {
    getAll: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    findByTypeAndIdentifier: vi.fn().mockResolvedValue(null),
  } as unknown as AccountsService;
}

function mockDbService() {
  const dbChain = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        groupBy: vi.fn().mockResolvedValue([]),
        where: vi.fn().mockResolvedValue([]),
        innerJoin: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
    }),
  };
  return {
    db: dbChain,
    withCurrentUser: vi
      .fn()
      .mockImplementation((fn: (db: typeof dbChain) => unknown) => fn(dbChain)),
  } as unknown as DbService;
}

const fakeRow = {
  id: 'a1',
  connectorType: 'gmail',
  identifier: 'test@gmail.com',
  status: 'connected',
  schedule: 'manual',
  lastSyncAt: null,
  itemsSynced: 10,
};

describe('AccountsController', () => {
  let controller: AccountsController;
  let service: ReturnType<typeof mockAccountsService>;

  beforeEach(() => {
    service = mockAccountsService();
    controller = new AccountsController(
      service as unknown as AccountsService,
      mockDbService() as unknown as DbService,
    );
  });

  it('list returns mapped accounts', async () => {
    vi.mocked(service.getAll).mockResolvedValue([fakeRow]);
    const result = await controller.list({ id: 'user-1' });
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0].type).toBe('gmail');
    expect(result.accounts[0].memoriesIngested).toBe(0);
    expect(service.getAll).toHaveBeenCalledWith('user-1');
  });

  it('get returns single mapped account', async () => {
    vi.mocked(service.getById).mockResolvedValue({ ...fakeRow, userId: 'user-1' });
    const result = await controller.get({ id: 'user-1' }, 'a1');
    expect(result.id).toBe('a1');
    expect(result.type).toBe('gmail');
  });

  it('create calls service and maps result', async () => {
    vi.mocked(service.create).mockResolvedValue(fakeRow);
    const result = await controller.create(
      { id: 'user-1' },
      { connectorType: 'gmail', identifier: 'test@gmail.com' },
    );
    expect(service.create).toHaveBeenCalledWith({
      connectorType: 'gmail',
      identifier: 'test@gmail.com',
      userId: 'user-1',
    });
    expect(result.id).toBe('a1');
  });

  it('update calls service with schedule', async () => {
    vi.mocked(service.update).mockResolvedValue({ ...fakeRow, schedule: 'hourly' });
    const result = await controller.update('a1', { schedule: 'hourly' });
    expect(service.update).toHaveBeenCalledWith('a1', { schedule: 'hourly' });
    expect(result.schedule).toBe('hourly');
  });

  it('remove calls service and returns ok', async () => {
    vi.mocked(service.remove).mockResolvedValue(undefined);
    const result = await controller.remove('a1');
    expect(service.remove).toHaveBeenCalledWith('a1');
    expect(result).toEqual({ ok: true });
  });
});

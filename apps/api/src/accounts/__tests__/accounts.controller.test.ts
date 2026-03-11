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
    withCurrentUser: vi.fn().mockImplementation((fn: (db: any) => any) => fn(dbChain)),
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
    controller = new AccountsController(service as any, mockDbService() as any);
  });

  it('list returns mapped accounts', async () => {
    (service.getAll as any).mockResolvedValue([fakeRow]);
    const result = await controller.list({ id: 'user-1' });
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0].type).toBe('gmail');
    expect(result.accounts[0].memoriesIngested).toBe(0);
    expect(service.getAll).toHaveBeenCalledWith('user-1');
  });

  it('get returns single mapped account', async () => {
    (service.getById as any).mockResolvedValue({ ...fakeRow, userId: 'user-1' });
    const result = await controller.get({ id: 'user-1' }, 'a1');
    expect(result.id).toBe('a1');
    expect(result.type).toBe('gmail');
  });

  it('create calls service and maps result', async () => {
    (service.create as any).mockResolvedValue(fakeRow);
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
    (service.update as any).mockResolvedValue({ ...fakeRow, schedule: 'hourly' });
    const result = await controller.update('a1', { schedule: 'hourly' });
    expect(service.update).toHaveBeenCalledWith('a1', { schedule: 'hourly' });
    expect(result.schedule).toBe('hourly');
  });

  it('remove calls service and returns ok', async () => {
    (service.remove as any).mockResolvedValue(undefined);
    const result = await controller.remove('a1');
    expect(service.remove).toHaveBeenCalledWith('a1');
    expect(result).toEqual({ ok: true });
  });
});

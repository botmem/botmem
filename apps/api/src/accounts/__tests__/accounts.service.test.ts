import { describe, it, expect, beforeEach } from 'vitest';
import { AccountsService } from '../accounts.service';
import { DbService } from '../../db/db.service';
import { createTestDb } from '../../__tests__/helpers/db.helper';

function createService() {
  const dbService = { db: createTestDb() } as unknown as DbService;
  return new AccountsService(dbService);
}

describe('AccountsService', () => {
  let service: AccountsService;

  beforeEach(() => {
    service = createService();
  });

  describe('create', () => {
    it('creates an account and returns it', async () => {
      const account = await service.create({
        connectorType: 'gmail',
        identifier: 'test@gmail.com',
      });
      expect(account.connectorType).toBe('gmail');
      expect(account.identifier).toBe('test@gmail.com');
      expect(account.status).toBe('connected');
      expect(account.schedule).toBe('manual');
      expect(account.id).toBeTruthy();
    });

    it('creates account with auth context', async () => {
      const account = await service.create({
        connectorType: 'slack',
        identifier: 'workspace',
        authContext: '{"accessToken":"tok"}',
      });
      expect(account.authContext).toBe('{"accessToken":"tok"}');
    });

    it('sets null auth context when not provided', async () => {
      const account = await service.create({
        connectorType: 'gmail',
        identifier: 'test',
      });
      expect(account.authContext).toBeNull();
    });
  });

  describe('getAll', () => {
    it('returns empty array when no accounts', async () => {
      const accounts = await service.getAll();
      expect(accounts).toEqual([]);
    });

    it('returns all accounts', async () => {
      await service.create({ connectorType: 'gmail', identifier: 'a' });
      await service.create({ connectorType: 'slack', identifier: 'b' });
      const accounts = await service.getAll();
      expect(accounts).toHaveLength(2);
    });
  });

  describe('getById', () => {
    it('returns account by id', async () => {
      const created = await service.create({ connectorType: 'gmail', identifier: 'test' });
      const found = await service.getById(created.id);
      expect(found.id).toBe(created.id);
    });

    it('throws for non-existent id', async () => {
      await expect(service.getById('nonexistent')).rejects.toThrow('not found');
    });
  });

  describe('update', () => {
    it('updates schedule', async () => {
      const created = await service.create({ connectorType: 'gmail', identifier: 'test' });
      const updated = await service.update(created.id, { schedule: 'hourly' });
      expect(updated.schedule).toBe('hourly');
    });

    it('updates status', async () => {
      const created = await service.create({ connectorType: 'gmail', identifier: 'test' });
      const updated = await service.update(created.id, { status: 'syncing' });
      expect(updated.status).toBe('syncing');
    });

    it('throws for non-existent id', async () => {
      await expect(service.update('nonexistent', { status: 'connected' })).rejects.toThrow('not found');
    });

    it('updates updatedAt timestamp', async () => {
      const created = await service.create({ connectorType: 'gmail', identifier: 'test' });
      const originalUpdatedAt = created.updatedAt;
      // Small delay to ensure different timestamp
      await new Promise((r) => setTimeout(r, 10));
      const updated = await service.update(created.id, { status: 'syncing' });
      expect(updated.updatedAt).not.toBe(originalUpdatedAt);
    });
  });

  describe('remove', () => {
    it('removes an account', async () => {
      const created = await service.create({ connectorType: 'gmail', identifier: 'test' });
      await service.remove(created.id);
      const accounts = await service.getAll();
      expect(accounts).toHaveLength(0);
    });

    it('throws for non-existent id', async () => {
      await expect(service.remove('nonexistent')).rejects.toThrow('not found');
    });
  });
});

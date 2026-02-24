import { describe, it, expect, beforeEach } from 'vitest';
import { LogsService } from '../logs.service';
import { DbService } from '../../db/db.service';
import { createTestDb } from '../../__tests__/helpers/db.helper';

function createService() {
  const dbService = { db: createTestDb() } as unknown as DbService;
  return new LogsService(dbService);
}

describe('LogsService', () => {
  let service: LogsService;

  beforeEach(() => {
    service = createService();
  });

  describe('add', () => {
    it('adds a log entry', async () => {
      await service.add({
        jobId: 'j1',
        connectorType: 'gmail',
        accountId: 'a1',
        level: 'info',
        message: 'Sync started',
      });

      const { logs } = await service.query();
      expect(logs).toHaveLength(1);
      expect(logs[0].message).toBe('Sync started');
      expect(logs[0].level).toBe('info');
    });

    it('adds log without optional fields', async () => {
      await service.add({
        connectorType: 'slack',
        level: 'warn',
        message: 'Rate limited',
      });

      const { logs } = await service.query();
      expect(logs).toHaveLength(1);
      expect(logs[0].jobId).toBeNull();
      expect(logs[0].accountId).toBeNull();
    });
  });

  describe('query', () => {
    it('returns empty when no logs', async () => {
      const { logs, total } = await service.query();
      expect(logs).toEqual([]);
      expect(total).toBe(0);
    });

    it('returns logs ordered by timestamp desc', async () => {
      await service.add({ connectorType: 'gmail', level: 'info', message: 'first' });
      await new Promise((r) => setTimeout(r, 10));
      await service.add({ connectorType: 'gmail', level: 'info', message: 'second' });

      const { logs } = await service.query();
      expect(logs[0].message).toBe('second');
      expect(logs[1].message).toBe('first');
    });

    it('filters by jobId', async () => {
      await service.add({ jobId: 'j1', connectorType: 'gmail', level: 'info', message: 'a' });
      await service.add({ jobId: 'j2', connectorType: 'gmail', level: 'info', message: 'b' });

      const { logs } = await service.query({ jobId: 'j1' });
      expect(logs).toHaveLength(1);
      expect(logs[0].message).toBe('a');
    });

    it('filters by accountId', async () => {
      await service.add({ accountId: 'a1', connectorType: 'gmail', level: 'info', message: 'x' });
      await service.add({ accountId: 'a2', connectorType: 'slack', level: 'info', message: 'y' });

      const { logs } = await service.query({ accountId: 'a1' });
      expect(logs).toHaveLength(1);
    });

    it('filters by level', async () => {
      await service.add({ connectorType: 'gmail', level: 'info', message: 'ok' });
      await service.add({ connectorType: 'gmail', level: 'error', message: 'fail' });

      const { logs } = await service.query({ level: 'error' });
      expect(logs).toHaveLength(1);
      expect(logs[0].message).toBe('fail');
    });

    it('respects limit', async () => {
      for (let i = 0; i < 5; i++) {
        await service.add({ connectorType: 'gmail', level: 'info', message: `log${i}` });
      }

      const { logs } = await service.query({ limit: 3 });
      expect(logs.length).toBeLessThanOrEqual(3);
    });
  });
});

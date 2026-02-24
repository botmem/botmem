import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../__tests__/helpers/db.helper';
import { accounts, jobs, logs, rawEvents } from '../schema';

describe('DbService (in-memory)', () => {
  it('creates all tables', () => {
    const db = createTestDb();
    // Verify we can query each table without error
    const accts = db.select().from(accounts).all();
    const jobsList = db.select().from(jobs).all();
    const logsList = db.select().from(logs).all();
    const eventsList = db.select().from(rawEvents).all();

    expect(accts).toEqual([]);
    expect(jobsList).toEqual([]);
    expect(logsList).toEqual([]);
    expect(eventsList).toEqual([]);
  });

  it('inserts and reads accounts', async () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    await db.insert(accounts).values({
      id: 'a1',
      connectorType: 'gmail',
      identifier: 'test@gmail.com',
      status: 'connected',
      schedule: 'manual',
      itemsSynced: 0,
      createdAt: now,
      updatedAt: now,
    });

    const rows = await db.select().from(accounts);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('a1');
    expect(rows[0].connectorType).toBe('gmail');
  });

  it('inserts and reads jobs', async () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    // First create an account (foreign key)
    await db.insert(accounts).values({
      id: 'a1', connectorType: 'gmail', identifier: 'test',
      status: 'connected', schedule: 'manual', itemsSynced: 0,
      createdAt: now, updatedAt: now,
    });
    await db.insert(jobs).values({
      id: 'j1', accountId: 'a1', connectorType: 'gmail',
      status: 'queued', priority: 0, progress: 0, total: 0, createdAt: now,
    });

    const rows = await db.select().from(jobs);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('j1');
  });
});

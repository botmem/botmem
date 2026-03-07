import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EnrichProcessor } from '../enrich.processor';
import { createTestDb } from '../../__tests__/helpers/db.helper';
import { accounts, memories, rawEvents } from '../../db/schema';
import { eq } from 'drizzle-orm';

function makeDbService(db: any) {
  return { db } as any;
}

describe('EnrichProcessor', () => {
  let processor: EnrichProcessor;
  let db: ReturnType<typeof createTestDb>;
  let enrichService: any;
  let eventsService: any;
  let logsService: any;
  let jobsService: any;
  let settingsService: any;
  let pluginRegistry: any;

  beforeEach(async () => {
    db = createTestDb();

    enrichService = {
      enrich: vi.fn().mockResolvedValue(undefined),
    };

    eventsService = {
      emitToChannel: vi.fn(),
    };

    logsService = {
      add: vi.fn(),
    };

    jobsService = {
      incrementProgress: vi.fn().mockResolvedValue({ progress: 1, total: 10 }),
      tryCompleteJob: vi.fn().mockResolvedValue(false),
    };

    settingsService = {
      get: vi.fn().mockReturnValue(''),
      onChange: vi.fn(),
    };

    pluginRegistry = {
      fireHook: vi.fn().mockResolvedValue(undefined),
    };

    processor = new EnrichProcessor(
      makeDbService(db),
      enrichService,
      eventsService,
      logsService,
      jobsService,
      settingsService,
      pluginRegistry,
    );

    await db.insert(accounts).values({
      id: 'acc-1',
      connectorType: 'gmail',
      identifier: 'test@example.com',
      status: 'connected',
      createdAt: '2025-01-01',
      updatedAt: '2025-01-01',
    });

    const now = new Date().toISOString();
    await db.insert(rawEvents).values({
      id: 'raw-1',
      accountId: 'acc-1',
      connectorType: 'gmail',
      sourceId: 'src-1',
      sourceType: 'email',
      payload: '{}',
      timestamp: now,
      jobId: 'j1',
      createdAt: now,
    });

    await db.insert(memories).values({
      id: 'mem-1',
      accountId: 'acc-1',
      connectorType: 'gmail',
      sourceType: 'email',
      sourceId: 'src-1',
      text: 'Meeting with Dr. Khalil at Cairo Hospital on January 15th about the $500 invoice.',
      eventTime: '2025-01-15T10:00:00Z',
      ingestTime: now,
      embeddingStatus: 'pending',
      createdAt: now,
    });
  });

  it('calls enrichService.enrich and marks memory as done', async () => {
    await processor.process({ data: { rawEventId: 'raw-1', memoryId: 'mem-1' } } as any);

    expect(enrichService.enrich).toHaveBeenCalledWith('mem-1');

    // Memory should be marked as done
    const rows = await db.select().from(memories).where(eq(memories.id, 'mem-1'));
    expect(rows[0].embeddingStatus).toBe('done');
  });

  it('emits memory:updated event after enrichment', async () => {
    await processor.process({ data: { rawEventId: 'raw-1', memoryId: 'mem-1' } } as any);

    expect(eventsService.emitToChannel).toHaveBeenCalledWith(
      'memories',
      'memory:updated',
      expect.objectContaining({ memoryId: 'mem-1', connectorType: 'gmail' }),
    );
  });

  it('advances parent job progress', async () => {
    await processor.process({ data: { rawEventId: 'raw-1', memoryId: 'mem-1' } } as any);

    expect(jobsService.incrementProgress).toHaveBeenCalledWith('j1');
  });

  it('emits job:complete when job finishes', async () => {
    jobsService.tryCompleteJob.mockResolvedValue(true);

    await processor.process({ data: { rawEventId: 'raw-1', memoryId: 'mem-1' } } as any);

    expect(eventsService.emitToChannel).toHaveBeenCalledWith(
      'job:j1',
      'job:complete',
      { jobId: 'j1', status: 'done' },
    );
  });

  it('skips non-existent memory gracefully', async () => {
    await processor.process({ data: { rawEventId: 'raw-1', memoryId: 'non-existent' } } as any);

    expect(enrichService.enrich).toHaveBeenCalledWith('non-existent');
  });
});

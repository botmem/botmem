import { describe, it, expect, vi } from 'vitest';
import { BackfillProcessor } from '../backfill.processor';
import type { Job } from 'bullmq';

// ---- mock factories ----

function mockDbService() {
  const chainResult: any[] = [];
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    all: vi.fn(() => chainResult),
    then: vi.fn((resolve: any) => resolve(chainResult)),
  };
  const updateChain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    run: vi.fn(),
  };
  return {
    db: {
      select: vi.fn(() => chain),
      update: vi.fn(() => updateChain),
      delete: vi.fn().mockReturnThis(),
    },
    _chain: chain,
    _chainResult: chainResult,
    _updateChain: updateChain,
  };
}

function createProcessor(overrides: Record<string, any> = {}) {
  const dbService = mockDbService();
  const contactsService = { resolveContact: vi.fn(), linkMemory: vi.fn() };
  const enrichService = { enrich: vi.fn().mockResolvedValue(undefined) };
  const crypto = {
    isEncrypted: vi.fn().mockReturnValue(false),
    decryptMemoryFields: vi.fn((m: any) => m),
    encryptMemoryFields: vi.fn((m: any) => ({
      text: `enc:${m.text}`,
      entities: `enc:${m.entities}`,
      claims: `enc:${m.claims}`,
      metadata: `enc:${m.metadata}`,
    })),
  };
  const jobsService = {
    incrementProgress: vi.fn().mockResolvedValue({ progress: 1, total: 5, done: false }),
    tryCompleteJob: vi.fn().mockResolvedValue(false),
  };
  const events = { emitToChannel: vi.fn() };
  const settingsService = {
    get: vi.fn().mockReturnValue('2'),
    onChange: vi.fn(),
  };

  const userKeyService = {
    deriveAndStore: vi.fn().mockResolvedValue(undefined),
    removeKey: vi.fn(),
    getKey: vi.fn().mockReturnValue(null),
  };

  const deps = {
    dbService,
    contactsService,
    enrichService,
    crypto,
    userKeyService,
    jobsService,
    events,
    settingsService,
    ...overrides,
  };

  const processor = new BackfillProcessor(
    deps.dbService as any,
    deps.contactsService as any,
    deps.enrichService as any,
    deps.crypto as any,
    deps.userKeyService as any,
    deps.events as any,
    deps.jobsService as any,
    deps.settingsService as any,
  );

  // WorkerHost has a getter-only `worker` property. Use defineProperty to override.
  Object.defineProperty(processor, 'worker', {
    value: {
      on: vi.fn(),
      concurrency: 1,
      opts: { lockDuration: 60_000 },
    },
    writable: true,
    configurable: true,
  });

  return { processor, ...deps };
}

function fakeJob(name: string, data: any): Job<any> {
  return { name, data } as unknown as Job<any>;
}

// ---- tests ----

describe('BackfillProcessor', () => {
  it('routes backfill-enrich jobs to processEnrich and calls enrichService.enrich', async () => {
    const { processor, dbService, enrichService } = createProcessor();
    dbService._chainResult.length = 0;
    dbService._chainResult.push({
      id: 'mem-1',
      text: 'hello',
      entities: '[]',
      claims: '[]',
      metadata: '{}',
      enrichedAt: null,
    });

    const job = fakeJob('backfill-enrich', { memoryId: 'mem-1', jobId: 'job-1' });
    await processor.process(job);

    expect(enrichService.enrich).toHaveBeenCalledWith('mem-1');
  });

  it('skips memory that already has enrichedAt set but still increments progress', async () => {
    const { processor, dbService, enrichService, jobsService } = createProcessor();
    dbService._chainResult.length = 0;
    dbService._chainResult.push({
      id: 'mem-2',
      text: 'hello',
      entities: '[]',
      claims: '[]',
      metadata: '{}',
      enrichedAt: '2026-01-01T00:00:00.000Z',
    });

    const job = fakeJob('backfill-enrich', { memoryId: 'mem-2', jobId: 'job-2' });
    const result = await processor.process(job);

    expect(enrichService.enrich).not.toHaveBeenCalled();
    expect(jobsService.incrementProgress).toHaveBeenCalledWith('job-2');
    expect(result).toEqual({ skipped: true });
  });

  it('decrypts memory fields before enrich if encrypted, re-encrypts after', async () => {
    const { processor, dbService, crypto, enrichService } = createProcessor();
    dbService._chainResult.length = 0;
    dbService._chainResult.push({
      id: 'mem-3',
      text: 'enc:hello',
      entities: 'enc:[]',
      claims: 'enc:[]',
      metadata: 'enc:{}',
      enrichedAt: null,
    });
    crypto.isEncrypted.mockReturnValue(true);
    crypto.decryptMemoryFields.mockReturnValue({
      text: 'hello',
      entities: '[]',
      claims: '[]',
      metadata: '{}',
    });

    const job = fakeJob('backfill-enrich', { memoryId: 'mem-3', jobId: 'job-3' });
    await processor.process(job);

    expect(crypto.isEncrypted).toHaveBeenCalledWith('enc:hello');
    expect(crypto.decryptMemoryFields).toHaveBeenCalled();
    expect(enrichService.enrich).toHaveBeenCalledWith('mem-3');
    // Re-encrypt is called via encryptMemoryAtRest pattern -- update is called
    expect(dbService.db.update).toHaveBeenCalled();
  });

  it('calls advanceAndComplete after each memory (incrementProgress + emitToChannel)', async () => {
    const { processor, dbService, jobsService, events } = createProcessor();
    dbService._chainResult.length = 0;
    dbService._chainResult.push({
      id: 'mem-4',
      text: 'hello',
      entities: '[]',
      claims: '[]',
      metadata: '{}',
      enrichedAt: null,
    });

    const job = fakeJob('backfill-enrich', { memoryId: 'mem-4', jobId: 'job-4' });
    await processor.process(job);

    expect(jobsService.incrementProgress).toHaveBeenCalledWith('job-4');
    expect(events.emitToChannel).toHaveBeenCalledWith(
      'job:job-4',
      'job:progress',
      expect.objectContaining({ jobId: 'job-4' }),
    );
  });

  it('emits job:complete via events when tryCompleteJob returns true', async () => {
    const { processor, dbService, jobsService, events } = createProcessor();
    dbService._chainResult.length = 0;
    dbService._chainResult.push({
      id: 'mem-5',
      text: 'hello',
      entities: '[]',
      claims: '[]',
      metadata: '{}',
      enrichedAt: null,
    });
    jobsService.tryCompleteJob.mockResolvedValue(true);

    const job = fakeJob('backfill-enrich', { memoryId: 'mem-5', jobId: 'job-5' });
    await processor.process(job);

    expect(events.emitToChannel).toHaveBeenCalledWith(
      'job:job-5',
      'job:complete',
      expect.objectContaining({ jobId: 'job-5', status: 'done' }),
    );
  });

  it('existing contact backfill (backfill-contact job name) still works unchanged', async () => {
    const { processor, dbService, contactsService, enrichService } = createProcessor();
    // For contact backfill, the chain returns different data per call
    const callCount = { n: 0 };
    dbService.db.select = vi.fn(() => {
      callCount.n++;
      const chain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        then: vi.fn((resolve: any) => {
          if (callCount.n === 1)
            resolve([{ accountId: null }]); // bootstrap: memory accountId (no account → skip user lookup)
          else if (callCount.n === 2)
            resolve([]); // no existing contacts
          else if (callCount.n === 3)
            resolve([
              {
                id: 'mem-c',
                connectorType: 'gmail',
                sourceId: 'src-1',
                text: 'hi',
                entities: '[]',
                claims: '[]',
                metadata: '{}',
                enrichedAt: null,
              },
            ]);
          else
            resolve([
              {
                id: 're-1',
                payload: JSON.stringify({
                  content: { metadata: { from: 'a@b.com' }, participants: [] },
                }),
              },
            ]);
          return undefined;
        }),
      };
      return chain as any;
    });

    contactsService.resolveContact.mockResolvedValue({ id: 'contact-1' });
    contactsService.linkMemory.mockResolvedValue(undefined);

    const job = fakeJob('backfill-contact', { memoryId: 'mem-c' });
    await processor.process(job);

    // enrichService should NOT be called for contact backfill
    expect(enrichService.enrich).not.toHaveBeenCalled();
    // Contact resolution should have been called
    expect(contactsService.resolveContact).toHaveBeenCalled();
  });
});

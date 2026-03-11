import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EnrichProcessor } from '../enrich.processor';

function makeDbService(db: any) {
  return { db } as any;
}

describe('EnrichProcessor', () => {
  let processor: EnrichProcessor;
  let enrichService: any;
  let eventsService: any;
  let logsService: any;
  let jobsService: any;
  let settingsService: any;
  let pluginRegistry: any;
  let mockDb: any;

  beforeEach(() => {
    // Mock DB with select/from/where chain returning memory row
    const memoryRow = {
      id: 'mem-1',
      accountId: 'acc-1',
      connectorType: 'gmail',
      sourceType: 'email',
      sourceId: 'src-1',
      text: 'Meeting with Dr. Khalil at Cairo Hospital on January 15th about the $500 invoice.',
      eventTime: new Date('2025-01-15T10:00:00Z'),
      ingestTime: new Date(),
      embeddingStatus: 'pending',
      createdAt: new Date(),
    };

    mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => [memoryRow]),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    } as any;

    enrichService = {
      enrich: vi.fn().mockResolvedValue(undefined),
    };

    eventsService = {
      emitToChannel: vi.fn(),
      emitDebounced: vi.fn(),
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

    const memoryService = {
      getStats: vi.fn().mockResolvedValue({ total: 0 }),
      buildGraphDelta: vi.fn().mockResolvedValue(null),
    };

    const cryptoService = {
      isEncrypted: vi.fn().mockReturnValue(false),
      encrypt: vi.fn().mockImplementation((v: string) => v),
      decrypt: vi.fn().mockImplementation((v: string) => v),
      encryptMemoryFields: vi.fn().mockImplementation((f: any) => f),
      decryptMemoryFields: vi.fn().mockImplementation((m: any) => m),
      encryptMemoryFieldsWithKey: vi.fn().mockImplementation((f: any) => f),
      decryptMemoryFieldsWithKey: vi.fn().mockImplementation((m: any) => m),
    };

    const userKeyService = {
      deriveAndStore: vi.fn().mockResolvedValue(undefined),
      removeKey: vi.fn(),
      getKey: vi.fn().mockReturnValue(null),
      getDek: vi.fn().mockResolvedValue(null),
    };

    const configService = {
      aiConcurrency: { enrich: 2 },
    };

    const traceContext = {
      current: vi.fn().mockReturnValue({ traceId: 'aaaa', spanId: 'bbbb' }),
      run: vi.fn().mockImplementation((_ctx: any, fn: () => any) => fn()),
    } as any;

    processor = new EnrichProcessor(
      makeDbService(mockDb),
      enrichService,
      memoryService as any,
      cryptoService as any,
      userKeyService as any,
      eventsService,
      logsService,
      jobsService,
      settingsService,
      pluginRegistry,
      configService as any,
      traceContext,
    );
  });

  it('creates EnrichProcessor with mock services', () => {
    expect(processor).toBeDefined();
  });

  it('calls enrichService.enrich with correct memoryId', async () => {
    await processor.process({ data: { rawEventId: 'raw-1', memoryId: 'mem-1' } } as any);
    expect(enrichService.enrich).toHaveBeenCalledWith('mem-1');
  });
});

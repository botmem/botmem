import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EnrichProcessor } from '../enrich.processor';
import type { DbService } from '../../db/db.service';

function makeDbService(db: Record<string, ReturnType<typeof vi.fn>>) {
  return { db } as unknown as DbService;
}

describe('EnrichProcessor', () => {
  let processor: EnrichProcessor;
  let enrichService: { enrich: ReturnType<typeof vi.fn> };
  let eventsService: {
    emitToChannel: ReturnType<typeof vi.fn>;
    emitDebounced: ReturnType<typeof vi.fn>;
  };
  let logsService: { add: ReturnType<typeof vi.fn> };
  let jobsService: {
    incrementProgress: ReturnType<typeof vi.fn>;
    tryCompleteJob: ReturnType<typeof vi.fn>;
  };
  let settingsService: { get: ReturnType<typeof vi.fn>; onChange: ReturnType<typeof vi.fn> };
  let pluginRegistry: { fireHook: ReturnType<typeof vi.fn> };
  let mockDb: Record<string, ReturnType<typeof vi.fn>>;

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
    } as Record<string, ReturnType<typeof vi.fn>>;

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
      encryptMemoryFields: vi.fn().mockImplementation((f: Record<string, string | null>) => f),
      decryptMemoryFields: vi.fn().mockImplementation((m: Record<string, string | null>) => m),
      encryptMemoryFieldsWithKey: vi
        .fn()
        .mockImplementation((f: Record<string, string | null>) => f),
      decryptMemoryFieldsWithKey: vi
        .fn()
        .mockImplementation((m: Record<string, string | null>) => m),
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
      run: vi.fn().mockImplementation((_ctx: unknown, fn: () => unknown) => fn()),
    } as unknown as { current: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn> };

    processor = new EnrichProcessor(
      makeDbService(mockDb),
      enrichService,
      memoryService as unknown as import('../memory.service').MemoryService,
      cryptoService as unknown as import('../../crypto/crypto.service').CryptoService,
      userKeyService as unknown as import('../../crypto/user-key.service').UserKeyService,
      eventsService,
      logsService,
      jobsService,
      settingsService,
      pluginRegistry,
      configService as unknown as import('../../config/config.service').ConfigService,
      traceContext,
    );
  });

  it('creates EnrichProcessor with mock services', () => {
    expect(processor).toBeDefined();
  });

  it('calls enrichService.enrich with correct memoryId', async () => {
    await processor.process({
      data: { rawEventId: 'raw-1', memoryId: 'mem-1' },
    } as unknown as import('bullmq').Job);
    expect(enrichService.enrich).toHaveBeenCalledWith('mem-1');
  });
});

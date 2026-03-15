import { describe, it, expect, vi } from 'vitest';
import { EmbedProcessor } from '../embed.processor';

// Type imports for casting
import type { DbService } from '../../db/db.service';
import type { AiService } from '../ai.service';
import type { TypesenseService } from '../typesense.service';
import type { MemoryService } from '../memory.service';
import type { ConnectorsService } from '../../connectors/connectors.service';
import type { AccountsService } from '../../accounts/accounts.service';
import type { PeopleService } from '../../people/people.service';
import type { EventsService } from '../../events/events.service';
import type { LogsService } from '../../logs/logs.service';
import type { JobsService } from '../../jobs/jobs.service';
import type { SettingsService } from '../../settings/settings.service';
import type { PluginRegistry } from '../../plugins/plugin-registry';
import type { AnalyticsService } from '../../analytics/analytics.service';
import type { ConfigService } from '../../config/config.service';
import type { CryptoService } from '../../crypto/crypto.service';
import type { UserKeyService } from '../../crypto/user-key.service';
import type { TraceContext } from '../../tracing/trace.context';
import type { Queue } from 'bullmq';

function createMockAi() {
  return {
    embed: vi.fn().mockResolvedValue(new Array(1024).fill(0.1)),
    embedMultimodal: vi.fn().mockResolvedValue(new Array(1024).fill(0.1)),
    generate: vi.fn().mockResolvedValue('{}'),
  } as unknown as AiService;
}

function createMockTypesense(): TypesenseService {
  return {
    ensureCollection: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    remove: vi.fn().mockResolvedValue(undefined),
  } as unknown as TypesenseService;
}

function createMockContactsService() {
  return {
    resolvePerson: vi.fn().mockResolvedValue({ id: 'contact-1', name: 'Test' }),
    linkMemoryContact: vi.fn().mockResolvedValue(undefined),
    linkMemory: vi.fn().mockResolvedValue(undefined),
    updateAvatar: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockQueue() {
  return { add: vi.fn().mockResolvedValue({}) };
}

function createMockEvents() {
  return { emitToChannel: vi.fn(), emitDebounced: vi.fn() };
}

function createMockLogsService() {
  return { add: vi.fn() };
}

function createMockConnectorsService(manifestOverrides: Record<string, unknown> = {}) {
  return {
    get: vi.fn().mockReturnValue({
      manifest: { id: 'gmail', trustScore: 0.8, ...manifestOverrides },
      embed: vi.fn().mockResolvedValue({
        text: null,
        metadata: {},
        entities: [],
      }),
    }),
  };
}

function createMockAccountsService() {
  return {
    getById: vi
      .fn()
      .mockResolvedValue({ id: 'acc-1', connectorType: 'gmail', identifier: 'test@gmail.com' }),
  };
}

function createMockJobsService() {
  return {
    updateJob: vi.fn().mockResolvedValue(undefined),
    getByAccountId: vi.fn().mockResolvedValue(null),
    incrementProgress: vi.fn().mockResolvedValue({ progress: 1, total: 1 }),
    tryCompleteJob: vi.fn().mockResolvedValue(false),
  };
}

function createMockSettingsService() {
  return {
    get: vi.fn().mockReturnValue(''),
    onChange: vi.fn(),
  };
}

function createMockPluginRegistry() {
  return {
    getPhotoDescriber: vi.fn().mockReturnValue(null),
    getTextCleaner: vi.fn().mockReturnValue(null),
    fireHook: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockCrypto() {
  return {
    // decrypt returns null to signal "not encrypted", so processor uses raw payload
    decrypt: vi.fn().mockReturnValue(null),
    encryptMemoryFieldsWithKey: vi
      .fn()
      .mockImplementation((fields: Record<string, string>) => fields),
  } as unknown as CryptoService;
}

function createMockUserKeyService() {
  return {
    getDek: vi.fn().mockResolvedValue(Buffer.alloc(32)),
  } as unknown as UserKeyService;
}

function createMockTraceContext() {
  const ctx = { traceId: 'trace-1', spanId: 'span-1' };
  return {
    current: vi.fn().mockReturnValue(ctx),
    run: vi.fn().mockImplementation((_ctx: unknown, fn: () => unknown) => fn()),
  } as unknown as TraceContext;
}

/**
 * Create a chainable mock DB that returns appropriate data for the
 * embed processor's query chains. The `rawEventPayload` parameter
 * controls what the processor sees as the raw event.
 */
function createChainableDbMock(rawEventPayload: string) {
  const now = new Date();
  const rawEvent = {
    id: 'raw-1',
    accountId: 'acc-1',
    connectorType: 'gmail',
    sourceId: 'email-123',
    sourceType: 'email',
    payload: rawEventPayload,
    cleanedText: null,
    timestamp: '2026-02-20T10:00:00Z',
    jobId: 'j1',
    createdAt: now,
  };

  // Track update().set() calls so tests can inspect them
  const setCalls: Array<Record<string, unknown>> = [];

  // Build a chainable mock where terminal methods (then/limit/execute) resolve data
  function buildChain(resolveValue: unknown) {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    const returnChain = () => chain;
    chain.from = vi.fn(returnChain);
    chain.where = vi.fn(returnChain);
    chain.limit = vi.fn().mockImplementation(() => resolveValue);
    chain.values = vi.fn().mockResolvedValue(undefined);
    chain.onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    // Make the chain thenable so `await db.select().from().where()` resolves
    chain.then = vi.fn().mockImplementation((resolve: (v: unknown) => void) => {
      return Promise.resolve(resolveValue).then(resolve);
    });
    return chain;
  }

  // Track which query is being built based on `from()` calls
  let selectCallCount = 0;
  const db = {
    _setCalls: setCalls,
    select: vi.fn().mockImplementation(() => {
      selectCallCount++;
      // 1st select: rawEvents lookup → returns the raw event
      // 2nd select: jobs lookup for memoryBankId → empty
      // 3rd select: accounts lookup for userId → returns account with userId
      // 4th select: memoryBanks default bank → empty
      // 5th select: settings selfContactId → empty
      // 6th select: users.keyVersion lookup → returns keyVersion 1
      if (selectCallCount === 1) return buildChain([rawEvent]);
      if (selectCallCount === 3) return buildChain([{ userId: 'user-1' }]);
      if (selectCallCount === 6) return buildChain([{ keyVersion: 1 }]);
      return buildChain([]);
    }),
    insert: vi.fn().mockImplementation(() => {
      const insertChain: Record<string, ReturnType<typeof vi.fn>> = {};
      insertChain.values = vi.fn().mockImplementation(() => {
        const valuesChain: Record<string, ReturnType<typeof vi.fn>> = {};
        valuesChain.onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
        valuesChain.then = vi
          .fn()
          .mockImplementation((resolve: (v: unknown) => void) =>
            Promise.resolve(undefined).then(resolve),
          );
        return valuesChain;
      });
      return insertChain;
    }),
    update: vi.fn().mockImplementation(() => {
      const updateChain: Record<string, ReturnType<typeof vi.fn>> = {};
      updateChain.set = vi.fn().mockImplementation((setArg: Record<string, unknown>) => {
        setCalls.push(setArg);
        const setChain: Record<string, ReturnType<typeof vi.fn>> = {};
        setChain.where = vi.fn().mockResolvedValue(undefined);
        setChain.then = vi
          .fn()
          .mockImplementation((resolve: (v: unknown) => void) =>
            Promise.resolve(undefined).then(resolve),
          );
        return setChain;
      });
      return updateChain;
    }),
  };

  return db;
}

function createProcessor(
  overrides: {
    connectorManifest?: Record<string, unknown>;
    rawEventPayload?: string;
  } = {},
) {
  const payload =
    overrides.rawEventPayload ??
    JSON.stringify({
      sourceType: 'email',
      sourceId: 'email-123',
      timestamp: '2026-02-20T10:00:00Z',
      content: {
        text: 'Meeting with Dr. Khalil tomorrow at 3pm',
        participants: ['khalil@university.edu', 'me@gmail.com'],
        metadata: { subject: 'Meeting Reminder', from: 'khalil@university.edu' },
      },
    });

  const db = createChainableDbMock(payload);
  const enrichQueue = createMockQueue();
  const events = createMockEvents();
  const connectorsService = createMockConnectorsService(overrides.connectorManifest || {});

  const dbService = {
    db,
    withUserId: vi
      .fn()
      .mockImplementation((_userId: string, fn: (db: unknown) => unknown) => fn(db)),
  } as unknown as DbService;

  const processor = new EmbedProcessor(
    dbService,
    createMockCrypto(),
    createMockUserKeyService(),
    createMockAi(),
    createMockTypesense(),
    {
      getStats: vi.fn(),
      buildGraphDelta: vi.fn().mockResolvedValue(null),
    } as unknown as MemoryService,
    connectorsService as unknown as ConnectorsService,
    createMockAccountsService() as unknown as AccountsService,
    createMockContactsService() as unknown as PeopleService,
    events as unknown as EventsService,
    createMockLogsService() as unknown as LogsService,
    createMockJobsService() as unknown as JobsService,
    createMockSettingsService() as unknown as SettingsService,
    createMockPluginRegistry() as unknown as PluginRegistry,
    { capture: vi.fn() } as unknown as AnalyticsService,
    { aiConcurrency: { embed: 2 }, embedBackend: 'ollama' } as unknown as ConfigService,
    enrichQueue as unknown as Queue,
    createMockTraceContext(),
  );

  return { processor, db, enrichQueue, events, connectorsService };
}

describe('EmbedProcessor', () => {
  it('creates EmbedProcessor with mock services', () => {
    const { processor } = createProcessor();
    expect(processor).toBeDefined();
  });

  describe('pipeline_complete when enrich is false', () => {
    it('sets pipelineComplete=true when connector manifest has enrich=false', async () => {
      const { processor, db, enrichQueue } = createProcessor({
        connectorManifest: { pipeline: { enrich: false } },
      });

      const mockJob = {
        data: { rawEventId: 'raw-1' },
        id: 'job-1',
        updateProgress: vi.fn(),
      };

      await processor.process(mockJob as any);

      // The enrich queue should NOT have been called
      expect(enrichQueue.add).not.toHaveBeenCalled();

      // The DB update should have set both embeddingStatus and pipelineComplete
      expect(db._setCalls.length).toBeGreaterThanOrEqual(1);
      const doneCall = db._setCalls.find(
        (call: Record<string, unknown>) => call.pipelineComplete === true,
      );
      expect(doneCall).toBeDefined();
      expect(doneCall!.embeddingStatus).toBe('done');
      expect(doneCall!.pipelineComplete).toBe(true);
    });

    it('enqueues enrich job when connector manifest has enrich=true', async () => {
      const { processor, db, enrichQueue } = createProcessor({
        connectorManifest: { pipeline: { enrich: true } },
      });

      const mockJob = {
        data: { rawEventId: 'raw-1' },
        id: 'job-2',
        updateProgress: vi.fn(),
      };

      await processor.process(mockJob as any);

      // The enrich queue SHOULD have been called
      expect(enrichQueue.add).toHaveBeenCalledWith(
        'enrich',
        expect.objectContaining({ rawEventId: 'raw-1' }),
        expect.any(Object),
      );

      // pipelineComplete should NOT have been set directly
      const doneCall = db._setCalls.find(
        (call: Record<string, unknown>) => call.pipelineComplete === true,
      );
      expect(doneCall).toBeUndefined();
    });

    it('enqueues enrich job when connector manifest has no pipeline config', async () => {
      const { processor, db, enrichQueue } = createProcessor({
        connectorManifest: {},
      });

      const mockJob = {
        data: { rawEventId: 'raw-1' },
        id: 'job-3',
        updateProgress: vi.fn(),
      };

      await processor.process(mockJob as any);

      // Default behavior: enrich is enabled
      expect(enrichQueue.add).toHaveBeenCalledWith(
        'enrich',
        expect.objectContaining({ rawEventId: 'raw-1' }),
        expect.any(Object),
      );

      const doneCall = db._setCalls.find(
        (call: Record<string, unknown>) => call.pipelineComplete === true,
      );
      expect(doneCall).toBeUndefined();
    });
  });
});

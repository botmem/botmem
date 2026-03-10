import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmbedProcessor } from '../embed.processor';
import { OllamaService } from '../ollama.service';
import { QdrantService } from '../qdrant.service';

function createMockOllama(): OllamaService {
  return {
    embed: vi.fn().mockResolvedValue(new Array(1024).fill(0.1)),
    generate: vi.fn().mockResolvedValue('{}'),
  } as unknown as OllamaService;
}

function createMockQdrant(): QdrantService {
  return {
    ensureCollection: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    remove: vi.fn().mockResolvedValue(undefined),
  } as unknown as QdrantService;
}

function createMockContactsService() {
  return {
    resolveContact: vi.fn().mockResolvedValue({ id: 'contact-1', name: 'Test' }),
    linkMemoryContact: vi.fn().mockResolvedValue(undefined),
    linkMemory: vi.fn().mockResolvedValue(undefined),
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

function createMockConnectorsService() {
  return {
    get: vi.fn().mockReturnValue({
      manifest: { id: 'gmail', trustScore: 0.8 },
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

/**
 * Create a mock DB that tracks inserts and supports select queries
 * for the embed processor's core flow.
 */
function createMockDb() {
  const rawEvents: any[] = [];
  const memories: any[] = [];
  const accounts: any[] = [];

  // Seed data
  const now = new Date();
  accounts.push({
    id: 'acc-1',
    connectorType: 'gmail',
    identifier: 'test@gmail.com',
    status: 'connected',
    schedule: 'manual',
    itemsSynced: 0,
    createdAt: now,
    updatedAt: now,
  });

  rawEvents.push({
    id: 'raw-1',
    accountId: 'acc-1',
    connectorType: 'gmail',
    sourceId: 'email-123',
    sourceType: 'email',
    payload: JSON.stringify({
      sourceType: 'email',
      sourceId: 'email-123',
      timestamp: '2026-02-20T10:00:00Z',
      content: {
        text: 'Meeting with Dr. Khalil tomorrow at 3pm',
        participants: ['khalil@university.edu', 'me@gmail.com'],
        metadata: { subject: 'Meeting Reminder', from: 'khalil@university.edu' },
      },
    }),
    timestamp: '2026-02-20T10:00:00Z',
    jobId: 'j1',
    createdAt: now,
  });

  // Simple mock that the processor uses
  const db = {
    _rawEvents: rawEvents,
    _memories: memories,
    _accounts: accounts,
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  } as any;

  return db;
}

describe('EmbedProcessor', () => {
  let ollama: ReturnType<typeof createMockOllama>;
  let qdrant: ReturnType<typeof createMockQdrant>;
  let contactsService: ReturnType<typeof createMockContactsService>;
  let enrichQueue: ReturnType<typeof createMockQueue>;
  let events: ReturnType<typeof createMockEvents>;
  let logsService: ReturnType<typeof createMockLogsService>;

  beforeEach(() => {
    ollama = createMockOllama();
    qdrant = createMockQdrant();
    contactsService = createMockContactsService();
    enrichQueue = createMockQueue();
    events = createMockEvents();
    logsService = createMockLogsService();
  });

  it('creates EmbedProcessor with mock services', () => {
    const db = createMockDb();
    const memoryService = {
      getStats: vi.fn().mockResolvedValue({ total: 0 }),
      buildGraphDelta: vi.fn().mockResolvedValue(null),
    };
    const configService = {
      aiConcurrency: { embed: 2 },
    };

    const processor = new EmbedProcessor(
      { db } as any,
      ollama,
      qdrant,
      memoryService as any,
      createMockConnectorsService() as any,
      createMockAccountsService() as any,
      contactsService as any,
      events as any,
      logsService as any,
      createMockJobsService() as any,
      createMockSettingsService() as any,
      createMockPluginRegistry() as any,
      { capture: vi.fn() } as any,
      configService as any,
      enrichQueue as any,
    );

    expect(processor).toBeDefined();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmbedProcessor } from '../embed.processor';
import { OllamaService } from '../ollama.service';
import { QdrantService } from '../qdrant.service';
import { createTestDb } from '../../__tests__/helpers/db.helper';
import { rawEvents, accounts, memories } from '../../db/schema';
import { eq } from 'drizzle-orm';

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
  return { emitToChannel: vi.fn() };
}

function createMockLogsService() {
  return { add: vi.fn() };
}

describe('EmbedProcessor', () => {
  let db: ReturnType<typeof createTestDb>;
  let ollama: ReturnType<typeof createMockOllama>;
  let qdrant: ReturnType<typeof createMockQdrant>;
  let contactsService: ReturnType<typeof createMockContactsService>;
  let enrichQueue: ReturnType<typeof createMockQueue>;
  let fileQueue: ReturnType<typeof createMockQueue>;
  let events: ReturnType<typeof createMockEvents>;
  let logsService: ReturnType<typeof createMockLogsService>;
  let processor: EmbedProcessor;

  beforeEach(async () => {
    db = createTestDb();
    ollama = createMockOllama();
    qdrant = createMockQdrant();
    contactsService = createMockContactsService();
    enrichQueue = createMockQueue();
    fileQueue = createMockQueue();
    events = createMockEvents();
    logsService = createMockLogsService();

    processor = new EmbedProcessor(
      { db } as any,
      ollama,
      qdrant,
      contactsService as any,
      enrichQueue as any,
      fileQueue as any,
      events as any,
      logsService as any,
    );

    // Seed test data
    const now = new Date().toISOString();
    await db.insert(accounts).values({
      id: 'acc-1', connectorType: 'gmail', identifier: 'test@gmail.com',
      status: 'connected', schedule: 'manual', itemsSynced: 0,
      createdAt: now, updatedAt: now,
    });

    await db.insert(rawEvents).values({
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
  });

  it('creates a memory from raw event and generates embedding', async () => {
    const job = { data: { rawEventId: 'raw-1' } } as any;
    await processor.process(job);

    // Memory should be created
    const mems = await db.select().from(memories);
    expect(mems).toHaveLength(1);
    expect(mems[0].text).toBe('Meeting with Dr. Khalil tomorrow at 3pm');
    expect(mems[0].sourceType).toBe('email');
    expect(mems[0].connectorType).toBe('gmail');
    expect(mems[0].embeddingStatus).toBe('done');

    // Embedding should be generated
    expect(ollama.embed).toHaveBeenCalledWith('Meeting with Dr. Khalil tomorrow at 3pm');

    // Vector should be upserted to Qdrant
    expect(qdrant.upsert).toHaveBeenCalledWith(
      mems[0].id,
      expect.any(Array),
      expect.objectContaining({
        source_type: 'email',
        connector_type: 'gmail',
      }),
    );

    // Enrich job should be enqueued
    expect(enrichQueue.add).toHaveBeenCalledWith(
      'enrich',
      expect.objectContaining({ memoryId: mems[0].id }),
      expect.any(Object),
    );
  });

  it('sets embedding_status to failed on Ollama error', async () => {
    ollama.embed = vi.fn().mockRejectedValue(new Error('Ollama down'));

    const job = { data: { rawEventId: 'raw-1' } } as any;
    await expect(processor.process(job)).rejects.toThrow('Ollama down');

    const mems = await db.select().from(memories);
    expect(mems).toHaveLength(1);
    expect(mems[0].embeddingStatus).toBe('failed');
  });

  it('skips processing if raw event not found', async () => {
    const job = { data: { rawEventId: 'nonexistent' } } as any;
    await processor.process(job);

    expect(ollama.embed).not.toHaveBeenCalled();
    expect(qdrant.upsert).not.toHaveBeenCalled();
  });

  it('parses metadata from raw event payload', async () => {
    const job = { data: { rawEventId: 'raw-1' } } as any;
    await processor.process(job);

    const mems = await db.select().from(memories);
    const metadata = JSON.parse(mems[0].metadata);
    expect(metadata.subject).toBe('Meeting Reminder');
    expect(metadata.from).toBe('khalil@university.edu');
  });

  it('emits memory:new event on success', async () => {
    const job = { data: { rawEventId: 'raw-1' } } as any;
    await processor.process(job);

    expect(events.emitToChannel).toHaveBeenCalledWith(
      'memories',
      'memory:new',
      expect.objectContaining({ sourceType: 'email' }),
    );
  });
});

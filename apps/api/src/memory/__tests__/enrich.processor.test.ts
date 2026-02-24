import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EnrichProcessor } from '../enrich.processor';
import { createTestDb } from '../../__tests__/helpers/db.helper';
import { accounts, memories, memoryLinks } from '../../db/schema';
import { eq } from 'drizzle-orm';

function makeDbService(db: any) {
  return { db } as any;
}

describe('EnrichProcessor', () => {
  let processor: EnrichProcessor;
  let db: ReturnType<typeof createTestDb>;
  let ollamaService: any;
  let qdrantService: any;

  beforeEach(async () => {
    db = createTestDb();

    ollamaService = {
      generate: vi.fn(),
    };

    qdrantService = {
      search: vi.fn().mockResolvedValue([]),
    };

    processor = new EnrichProcessor(
      makeDbService(db),
      ollamaService,
      qdrantService,
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
    await db.insert(memories).values({
      id: 'mem-1',
      accountId: 'acc-1',
      connectorType: 'gmail',
      sourceType: 'email',
      sourceId: 'src-1',
      text: 'Meeting with Dr. Khalil at Cairo Hospital on January 15th about the $500 invoice.',
      eventTime: '2025-01-15T10:00:00Z',
      ingestTime: now,
      embeddingStatus: 'done',
      createdAt: now,
    });
  });

  it('extracts entities from memory text', async () => {
    ollamaService.generate.mockResolvedValueOnce(
      JSON.stringify([
        { type: 'person', value: 'Dr. Khalil', confidence: 0.95 },
        { type: 'location', value: 'Cairo Hospital', confidence: 0.9 },
        { type: 'time', value: 'January 15th', confidence: 0.85 },
        { type: 'amount', value: '$500', confidence: 0.9 },
      ]),
    );

    ollamaService.generate.mockResolvedValueOnce(
      JSON.stringify({
        label: 'UNVERIFIED',
        confidence: 0.6,
        rationale: 'Personal message about a meeting — not officially confirmed',
      }),
    );

    await processor.process({ data: { memoryId: 'mem-1' } } as any);

    const rows = await db.select().from(memories).where(eq(memories.id, 'mem-1'));
    const entities = JSON.parse(rows[0].entities);
    expect(entities).toHaveLength(4);
    expect(entities[0].type).toBe('person');
    expect(entities[0].value).toBe('Dr. Khalil');
  });

  it('sets factuality label from LLM response', async () => {
    ollamaService.generate.mockResolvedValueOnce(JSON.stringify([]));
    ollamaService.generate.mockResolvedValueOnce(
      JSON.stringify({
        label: 'FACT',
        confidence: 0.9,
        rationale: 'Confirmed billing statement',
      }),
    );

    await processor.process({ data: { memoryId: 'mem-1' } } as any);

    const rows = await db.select().from(memories).where(eq(memories.id, 'mem-1'));
    const factuality = JSON.parse(rows[0].factuality);
    expect(factuality.label).toBe('FACT');
    expect(factuality.confidence).toBe(0.9);
  });

  it('creates memory links for similar memories', async () => {
    // Add a second memory
    const now = new Date().toISOString();
    await db.insert(memories).values({
      id: 'mem-2',
      accountId: 'acc-1',
      connectorType: 'gmail',
      sourceType: 'email',
      sourceId: 'src-2',
      text: 'Follow up on the meeting with Dr. Khalil',
      eventTime: '2025-01-16T10:00:00Z',
      ingestTime: now,
      embeddingStatus: 'done',
      createdAt: now,
    });

    // Qdrant returns a similar memory
    qdrantService.search.mockResolvedValue([
      { id: 'mem-2', score: 0.92, payload: {} },
    ]);

    ollamaService.generate.mockResolvedValueOnce(JSON.stringify([]));
    ollamaService.generate.mockResolvedValueOnce(
      JSON.stringify({ label: 'UNVERIFIED', confidence: 0.5, rationale: 'test' }),
    );

    await processor.process({ data: { memoryId: 'mem-1' } } as any);

    const links = await db.select().from(memoryLinks);
    expect(links).toHaveLength(1);
    expect(links[0].srcMemoryId).toBe('mem-1');
    expect(links[0].dstMemoryId).toBe('mem-2');
    expect(links[0].linkType).toBe('related');
    expect(links[0].strength).toBeCloseTo(0.92);
  });

  it('skips non-existent memory', async () => {
    await processor.process({ data: { memoryId: 'non-existent' } } as any);
    expect(ollamaService.generate).not.toHaveBeenCalled();
  });

  it('handles malformed LLM response gracefully', async () => {
    ollamaService.generate.mockResolvedValueOnce('not valid json at all');
    ollamaService.generate.mockResolvedValueOnce('also not json');

    // Should not throw
    await processor.process({ data: { memoryId: 'mem-1' } } as any);

    const rows = await db.select().from(memories).where(eq(memories.id, 'mem-1'));
    // Entities should remain default
    expect(JSON.parse(rows[0].entities)).toEqual([]);
  });
});

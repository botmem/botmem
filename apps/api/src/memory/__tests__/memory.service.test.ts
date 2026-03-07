import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryService } from '../memory.service';
import { createTestDb } from '../../__tests__/helpers/db.helper';
import { accounts, memories, memoryLinks, memoryContacts, contacts, contactIdentifiers } from '../../db/schema';
import { eq } from 'drizzle-orm';

function makeDbService(db: any) {
  return { db } as any;
}

describe('MemoryService', () => {
  let service: MemoryService;
  let db: ReturnType<typeof createTestDb>;
  let ollamaService: any;
  let qdrantService: any;
  let connectorsService: any;
  let pluginRegistry: any;

  beforeEach(async () => {
    db = createTestDb();

    ollamaService = {
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      rerank: vi.fn().mockResolvedValue([]),
    };

    qdrantService = {
      search: vi.fn().mockResolvedValue([]),
      ensureCollection: vi.fn(),
      upsert: vi.fn(),
      remove: vi.fn(),
    };

    connectorsService = {
      get: vi.fn().mockReturnValue({
        manifest: { trustScore: 0.8, weights: {} },
      }),
    };

    pluginRegistry = {
      getReranker: vi.fn().mockReturnValue(null),
      getScorers: vi.fn().mockReturnValue([]),
      fireHook: vi.fn().mockResolvedValue(undefined),
    };

    service = new MemoryService(
      makeDbService(db),
      ollamaService,
      qdrantService,
      connectorsService,
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

    // Seed memories
    const now = new Date().toISOString();
    await db.insert(memories).values([
      {
        id: 'mem-1',
        accountId: 'acc-1',
        connectorType: 'gmail',
        sourceType: 'email',
        sourceId: 'src-1',
        text: 'Meeting with Dr. Khalil about the project',
        eventTime: '2025-01-15T10:00:00Z',
        ingestTime: now,
        factuality: '{"label":"FACT","confidence":0.9,"rationale":"confirmed"}',
        entities: '[{"type":"person","value":"Dr. Khalil","confidence":0.95}]',
        embeddingStatus: 'done',
        createdAt: now,
      },
      {
        id: 'mem-2',
        accountId: 'acc-1',
        connectorType: 'slack',
        sourceType: 'message',
        sourceId: 'src-2',
        text: 'Slack conversation about lunch plans',
        eventTime: '2025-01-14T12:00:00Z',
        ingestTime: now,
        factuality: '{"label":"UNVERIFIED","confidence":0.5,"rationale":"casual"}',
        embeddingStatus: 'done',
        createdAt: now,
      },
      {
        id: 'mem-3',
        accountId: 'acc-1',
        connectorType: 'whatsapp',
        sourceType: 'message',
        sourceId: 'src-3',
        text: 'WhatsApp message about vacation',
        eventTime: '2025-01-10T08:00:00Z',
        ingestTime: now,
        embeddingStatus: 'done',
        createdAt: now,
      },
    ]);
  });

  describe('search', () => {
    it('returns scored results from Qdrant + DB', async () => {
      qdrantService.search.mockResolvedValue([
        { id: 'mem-1', score: 0.95, payload: {} },
        { id: 'mem-2', score: 0.7, payload: {} },
      ]);

      const response = await service.search('meeting doctor');
      expect(ollamaService.embed).toHaveBeenCalledWith('meeting doctor');
      expect(response.items).toHaveLength(2);
      expect(response.items[0].id).toBe('mem-1');
      expect(response.items[0].score).toBeDefined();
      expect(response.items[0].score).toBeGreaterThan(0);
    });

    it('returns empty items for empty query', async () => {
      const response = await service.search('');
      expect(response.items).toEqual([]);
      expect(ollamaService.embed).not.toHaveBeenCalled();
    });

    it('filters by source type', async () => {
      qdrantService.search.mockResolvedValue([
        { id: 'mem-1', score: 0.9, payload: { source_type: 'email' } },
      ]);

      await service.search('meeting', { sourceType: 'email' });
      expect(qdrantService.search).toHaveBeenCalledWith(
        [0.1, 0.2, 0.3],
        expect.any(Number),
        expect.objectContaining({
          must: expect.arrayContaining([
            { key: 'source_type', match: { value: 'email' } },
          ]),
        }),
      );
    });
  });

  describe('getById', () => {
    it('returns a single memory with full detail', async () => {
      const mem = await service.getById('mem-1');
      expect(mem).toBeDefined();
      expect(mem!.id).toBe('mem-1');
      expect(mem!.text).toContain('Dr. Khalil');
    });

    it('returns null for non-existent memory', async () => {
      const mem = await service.getById('non-existent');
      expect(mem).toBeNull();
    });
  });

  describe('list', () => {
    it('returns paginated results', async () => {
      const result = await service.list({ limit: 2, offset: 0 });
      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(3);
    });

    it('filters by connector type', async () => {
      const result = await service.list({ connectorType: 'slack' });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].connectorType).toBe('slack');
    });
  });

  describe('insert', () => {
    it('creates a memory in the database', async () => {
      const mem = await service.insert({
        text: 'Manually inserted memory',
        sourceType: 'manual',
        connectorType: 'manual',
      });

      expect(mem.id).toBeDefined();
      expect(mem.text).toBe('Manually inserted memory');

      // Should be in DB
      const rows = await db.select().from(memories).where(eq(memories.id, mem.id));
      expect(rows).toHaveLength(1);
    });
  });

  describe('delete', () => {
    it('removes memory from DB and Qdrant', async () => {
      await service.delete('mem-1');

      const rows = await db.select().from(memories).where(eq(memories.id, 'mem-1'));
      expect(rows).toHaveLength(0);
      expect(qdrantService.remove).toHaveBeenCalledWith('mem-1');
    });
  });

  describe('getStats', () => {
    it('returns aggregate statistics', async () => {
      const stats = await service.getStats();
      expect(stats.total).toBe(3);
      expect(stats.bySource).toBeDefined();
      expect(stats.bySource.email).toBe(1);
      expect(stats.bySource.message).toBe(2);
    });
  });

  describe('getGraphData', () => {
    it('returns nodes and edges', async () => {
      // Create a link
      await db.insert(memoryLinks).values({
        id: 'link-1',
        srcMemoryId: 'mem-1',
        dstMemoryId: 'mem-2',
        linkType: 'related',
        strength: 0.85,
        createdAt: new Date().toISOString(),
      });

      const graph = await service.getGraphData();
      expect(graph.nodes.length).toBeGreaterThanOrEqual(2);
      expect(graph.links).toHaveLength(1);
      expect(graph.links[0].source).toBe('mem-1');
      expect(graph.links[0].target).toBe('mem-2');
    });
  });
});

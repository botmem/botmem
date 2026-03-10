import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentService } from '../agent.service';

describe('AgentService', () => {
  let service: AgentService;
  let mockDb: any;
  let memoryService: any;
  let aiService: any;
  let qdrantService: any;
  let contactsService: any;
  let configService: any;

  const fakeMemory = {
    id: 'mem-1',
    text: 'Meeting with John',
    sourceType: 'email',
    connectorType: 'gmail',
    eventTime: new Date('2025-06-01'),
    ingestTime: new Date('2025-06-01'),
    createdAt: new Date('2025-06-01'),
    factuality: '{"label":"UNVERIFIED","confidence":0.5,"rationale":""}',
    entities: '[]',
    metadata: '{}',
    weights: '{}',
    keyVersion: 0,
    pinned: false,
  };

  beforeEach(() => {
    mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      groupBy: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      then: vi.fn().mockImplementation((fn: any) => fn([])),
    };

    memoryService = {
      search: vi.fn().mockResolvedValue({ items: [], fallback: false, parsed: { temporal: null, intent: 'recall', cleanQuery: 'test' } }),
      getById: vi.fn().mockResolvedValue(fakeMemory),
      getStats: vi.fn().mockResolvedValue({ total: 100, byConnector: { gmail: 50 }, bySource: { email: 50 } }),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    aiService = {
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      generate: vi.fn().mockResolvedValue('Summary of memories'),
    };

    qdrantService = {
      ensureCollection: vi.fn(),
      upsert: vi.fn(),
    };

    contactsService = {
      getById: vi.fn().mockResolvedValue({
        id: 'c-1',
        displayName: 'John Doe',
        identifiers: [{ identifierType: 'email', identifierValue: 'john@example.com' }],
      }),
    };

    configService = {
      aiBackend: 'ollama',
      ollamaEmbedModel: 'mxbai-embed-large',
      openrouterEmbedModel: 'google/gemini-embedding-001',
    };

    service = new AgentService(
      { db: mockDb } as any,
      memoryService,
      aiService,
      qdrantService,
      contactsService,
      configService as any,
    );
  });

  describe('ask', () => {
    it('returns empty results for query with no matches', async () => {
      const result = await service.ask('test query');
      expect(result.results).toEqual([]);
      expect(result.query).toBe('test query');
      expect(memoryService.search).toHaveBeenCalledWith('test query', undefined, 20, false, undefined);
    });

    it('returns enriched results when search finds matches', async () => {
      memoryService.search.mockResolvedValueOnce({
        items: [{ id: 'mem-1', score: 0.9 }],
        fallback: false,
        parsed: { temporal: null, intent: 'recall', cleanQuery: 'test' },
      });
      // getById for enrichMemory
      memoryService.getById.mockResolvedValueOnce(fakeMemory);
      // memoryContacts join returns empty
      mockDb.where.mockResolvedValueOnce([]);

      const result = await service.ask('test query');
      expect(result.results).toHaveLength(1);
      expect(result.results[0].id).toBe('mem-1');
    });

    it('respects limit and filters', async () => {
      await service.ask('test', { limit: 5, filters: { sourceType: 'email' } });
      expect(memoryService.search).toHaveBeenCalledWith('test', { sourceType: 'email' }, 5, false, undefined);
    });

    it('passes userId to search', async () => {
      await service.ask('test', { userId: 'user-1' });
      expect(memoryService.search).toHaveBeenCalledWith('test', undefined, 20, false, 'user-1');
    });
  });

  describe('remember', () => {
    it('creates a memory and returns enriched result', async () => {
      mockDb.where.mockResolvedValueOnce([]); // memoryContacts

      const result = await service.remember('A new note');
      expect(mockDb.insert).toHaveBeenCalled();
      expect(aiService.embed).toHaveBeenCalledWith('A new note');
      expect(qdrantService.upsert).toHaveBeenCalled();
      expect(result.text).toBe('Meeting with John'); // from getById mock
    });

    it('handles embedding failure gracefully', async () => {
      aiService.embed.mockRejectedValueOnce(new Error('AI down'));
      mockDb.where.mockResolvedValueOnce([]);

      // Should not throw
      const result = await service.remember('A note');
      expect(result).toBeDefined();
    });
  });

  describe('forget', () => {
    it('deletes existing memory', async () => {
      memoryService.getById.mockResolvedValueOnce(fakeMemory);

      const result = await service.forget('mem-1');
      expect(result.deleted).toBe(true);
      expect(memoryService.delete).toHaveBeenCalledWith('mem-1');
    });

    it('returns false for non-existent memory', async () => {
      memoryService.getById.mockResolvedValueOnce(null);

      const result = await service.forget('nonexistent');
      expect(result.deleted).toBe(false);
    });
  });

  describe('context', () => {
    it('returns null for unknown contact', async () => {
      contactsService.getById.mockResolvedValueOnce(null);
      const result = await service.context('bad-id');
      expect(result).toBeNull();
    });

    it('handles contact with no memories', async () => {
      mockDb.where.mockResolvedValueOnce([]); // no memoryContacts

      const result = await service.context('c-1');
      expect(result).not.toBeNull();
      expect(result!.contact.displayName).toBe('John Doe');
      expect(result!.identifiersByType.email).toContain('john@example.com');
      expect(result!.recentMemories).toEqual([]);
      expect(result!.stats.totalMemories).toBe(0);
      expect(result!.stats.dateRange).toBeNull();
    });
  });

  describe('summarize', () => {
    it('returns default message when no memories found', async () => {
      const result = await service.summarize('anything');
      expect(result.summary).toBe('No memories found matching your query.');
      expect(result.memories).toEqual([]);
    });

    it('returns AI summary with memories', async () => {
      memoryService.search.mockResolvedValueOnce({
        items: [{ id: 'mem-1', score: 0.9 }],
        fallback: false,
      });
      memoryService.getById.mockResolvedValueOnce(fakeMemory);
      mockDb.where.mockResolvedValueOnce([]); // memoryContacts

      const result = await service.summarize('meeting with john');
      expect(result.summary).toBe('Summary of memories');
      expect(result.memories).toHaveLength(1);
      expect(result.sourceIds).toEqual(['mem-1']);
    });

    it('returns memories without summary if AI fails', async () => {
      memoryService.search.mockResolvedValueOnce({
        items: [{ id: 'mem-1', score: 0.9 }],
        fallback: false,
      });
      memoryService.getById.mockResolvedValueOnce(fakeMemory);
      mockDb.where.mockResolvedValueOnce([]);
      aiService.generate.mockRejectedValueOnce(new Error('AI down'));

      const result = await service.summarize('test');
      expect(result.summary).toBeNull();
      expect(result.memories).toHaveLength(1);
    });
  });

  describe('status', () => {
    it('returns memory and contact stats', async () => {
      mockDb.from.mockResolvedValueOnce([{ count: 25 }]); // contacts count

      const result = await service.status();
      expect(result.memories.total).toBe(100);
      expect(result.memories.byConnector).toEqual({ gmail: 50 });
      expect(result.contacts.total).toBe(25);
      expect(result.embedding.backend).toBe('ollama');
      expect(result.embedding.model).toBe('mxbai-embed-large');
    });

    it('returns openrouter model when backend is openrouter', async () => {
      configService.aiBackend = 'openrouter';
      mockDb.from.mockResolvedValueOnce([{ count: 0 }]);

      const result = await service.status();
      expect(result.embedding.model).toBe('google/gemini-embedding-001');
    });
  });

  describe('timeline', () => {
    it('returns empty grouped results when no memories match', async () => {
      mockDb.limit.mockResolvedValueOnce([]);
      const result = await service.timeline();
      expect(result.results).toEqual({});
      expect(result.totalCount).toBe(0);
    });

    it('returns empty when no memories in timeframe', async () => {
      mockDb.limit.mockResolvedValueOnce([]); // no memories
      const result = await service.timeline({ days: 1 });
      expect(result.totalCount).toBe(0);
      expect(result.results).toEqual({});
    });
  });
});

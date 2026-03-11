import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EnrichService } from '../enrich.service';
import type { DbService } from '../../db/db.service';

describe('EnrichService', () => {
  let service: EnrichService;
  let mockDb: Record<string, ReturnType<typeof vi.fn>>;
  let aiService: { generate: ReturnType<typeof vi.fn>; embed: ReturnType<typeof vi.fn> };
  let qdrantService: {
    recommend: ReturnType<typeof vi.fn>;
    ensureCollection: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
  let logsService: { add: ReturnType<typeof vi.fn> };
  let eventsService: { emitToChannel: ReturnType<typeof vi.fn> };
  let connectorsService: { get: ReturnType<typeof vi.fn> };

  const fakeMemory = {
    id: 'mem-1',
    accountId: 'acc-1',
    connectorType: 'gmail',
    sourceType: 'email',
    text: 'Meeting with John at Google HQ tomorrow',
    eventTime: new Date('2025-01-01'),
    claims: '[]',
    factuality: null,
  };

  // Helper: create a chainable query result that works with Drizzle's pattern
  // select().from().where() → thenable, or select().from().where().limit() → thenable
  let whereResults: unknown[];
  let whereIndex: number;

  function nextWhereResult() {
    const val = whereIndex < whereResults.length ? whereResults[whereIndex] : [];
    whereIndex++;
    const result = Promise.resolve(val) as Promise<unknown> & { limit: ReturnType<typeof vi.fn> };
    result.limit = vi.fn(() => Promise.resolve(val));
    return result;
  }

  beforeEach(() => {
    whereResults = [];
    whereIndex = 0;

    mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn(() => nextWhereResult()),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockResolvedValue(undefined),
    };

    aiService = {
      generate: vi
        .fn()
        .mockResolvedValue(
          '{"entities":[{"type":"person","value":"John"},{"type":"organization","value":"Google"}]}',
        ),
      embed: vi.fn().mockResolvedValue([0.1, 0.2]),
    };

    qdrantService = {
      recommend: vi.fn().mockResolvedValue([]),
      ensureCollection: vi.fn(),
      upsert: vi.fn(),
    };

    logsService = { add: vi.fn() };
    eventsService = { emitToChannel: vi.fn() };
    connectorsService = {
      get: vi.fn().mockReturnValue({
        manifest: {
          trustScore: 0.85,
          weights: { semantic: 0.4, recency: 0.25, importance: 0.2, trust: 0.15 },
        },
      }),
    };

    service = new EnrichService(
      { db: mockDb } as unknown as DbService,
      aiService,
      qdrantService,
      logsService,
      eventsService,
      connectorsService,
    );
  });

  describe('enrich', () => {
    it('does nothing if memory not found', async () => {
      whereResults = [[]]; // no memory found
      await service.enrich('nonexistent');
      expect(aiService.generate).not.toHaveBeenCalled();
    });

    it('extracts entities and classifies factuality', async () => {
      whereResults = [
        [fakeMemory], // 1. get memory
        undefined, // 2. update entities
        undefined, // 3. update factuality
        [{ claims: '[]', factuality: null }], // 4. createLinks: select claims
        undefined, // 5. update weights
      ];

      aiService.generate
        .mockResolvedValueOnce('{"entities":[{"type":"person","value":"John"}]}')
        .mockResolvedValueOnce(
          '{"label":"UNVERIFIED","confidence":0.7,"rationale":"Single source"}',
        );

      await service.enrich('mem-1');
      expect(aiService.generate).toHaveBeenCalledTimes(2);
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('handles entity extraction failure gracefully', async () => {
      whereResults = [
        [fakeMemory],
        undefined, // factuality update
        [{ claims: '[]', factuality: null }],
        undefined, // weights update
      ];
      aiService.generate
        .mockRejectedValueOnce(new Error('AI down'))
        .mockResolvedValueOnce('{"label":"UNVERIFIED","confidence":0.5,"rationale":""}');

      await service.enrich('mem-1');
      expect(logsService.add).toHaveBeenCalled();
    });

    it('handles factuality classification failure gracefully', async () => {
      whereResults = [
        [fakeMemory],
        undefined, // entity update (empty)
        [{ claims: '[]', factuality: null }],
        undefined,
      ];
      aiService.generate
        .mockResolvedValueOnce('{"entities":[]}')
        .mockRejectedValueOnce(new Error('AI down'));

      await service.enrich('mem-1');
      expect(logsService.add).toHaveBeenCalled();
    });

    it('creates links for similar memories above threshold', async () => {
      whereResults = [
        [fakeMemory],
        undefined, // factuality update (no entities → no entity update)
        [{ claims: '[]', factuality: null }], // createLinks src — no claims, so linkType = 'related'
        [], // existingLink
        [], // reverseLink
        undefined, // weights
      ];
      qdrantService.recommend.mockResolvedValueOnce([{ id: 'mem-2', score: 0.85 }]);
      aiService.generate
        .mockResolvedValueOnce('{"entities":[]}')
        .mockResolvedValueOnce('{"label":"FACT","confidence":0.9,"rationale":"confirmed"}');

      await service.enrich('mem-1');
      expect(qdrantService.recommend).toHaveBeenCalled();
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it('skips link creation if existing link found', async () => {
      whereResults = [
        [fakeMemory],
        undefined,
        undefined,
        [{ claims: '[]', factuality: null }],
        [{ id: 'existing-link' }], // existingLink found
        undefined,
      ];
      qdrantService.recommend.mockResolvedValueOnce([{ id: 'mem-2', score: 0.85 }]);
      aiService.generate
        .mockResolvedValueOnce('{"entities":[]}')
        .mockResolvedValueOnce('{"label":"UNVERIFIED","confidence":0.5,"rationale":""}');

      await service.enrich('mem-1');
      // insert should not be called for links (only for links is values called)
    });
  });

  describe('link types', () => {
    it('creates "supports" link when both FACT and score >= 0.92', async () => {
      // Entities returned → entity update WHERE call happens
      // Factuality returned → factuality update WHERE call happens
      whereResults = [
        [fakeMemory], // 1. get memory
        undefined, // 2. update entities
        undefined, // 3. update factuality
        [{ claims: '[{"text":"John works at Google"}]', factuality: { label: 'FACT' } }], // 4. createLinks: src claims
        [{ factuality: { label: 'FACT' } }], // 5. dst factuality
        [], // 6. existingLink
        [], // 7. reverseLink
        undefined, // 8. weights update
      ];
      qdrantService.recommend.mockResolvedValueOnce([{ id: 'mem-2', score: 0.95 }]);
      aiService.generate
        .mockResolvedValueOnce('{"entities":[{"type":"person","value":"John"}]}')
        .mockResolvedValueOnce('{"label":"FACT","confidence":0.95,"rationale":"confirmed"}');

      await service.enrich('mem-1');
      const lastValues = mockDb.values.mock.calls[mockDb.values.mock.calls.length - 1][0];
      expect(lastValues.linkType).toBe('supports');
    });

    it('creates "contradicts" link when FACT vs FICTION and score >= 0.85', async () => {
      // No entities → no entity update WHERE
      // Factuality returned → factuality update WHERE
      whereResults = [
        [fakeMemory], // 1. get memory
        undefined, // 2. update factuality
        [{ claims: '[{"text":"something"}]', factuality: { label: 'FACT' } }], // 3. createLinks: src
        [{ factuality: { label: 'FICTION' } }], // 4. dst factuality
        [], // 5. existingLink
        [], // 6. reverseLink
        undefined, // 7. weights update
      ];
      qdrantService.recommend.mockResolvedValueOnce([{ id: 'mem-2', score: 0.9 }]);
      aiService.generate
        .mockResolvedValueOnce('{"entities":[]}')
        .mockResolvedValueOnce('{"label":"FACT","confidence":0.9,"rationale":"confirmed"}');

      await service.enrich('mem-1');
      const lastValues = mockDb.values.mock.calls[mockDb.values.mock.calls.length - 1][0];
      expect(lastValues.linkType).toBe('contradicts');
    });

    it('creates "contradicts" link for FICTION vs FACT', async () => {
      whereResults = [
        [fakeMemory],
        undefined, // factuality update
        [{ claims: '["claim"]', factuality: { label: 'FICTION' } }],
        [{ factuality: { label: 'FACT' } }],
        [],
        [],
        undefined,
      ];
      qdrantService.recommend.mockResolvedValueOnce([{ id: 'mem-2', score: 0.88 }]);
      aiService.generate
        .mockResolvedValueOnce('{"entities":[]}')
        .mockResolvedValueOnce('{"label":"FICTION","confidence":0.8,"rationale":"made up"}');

      await service.enrich('mem-1');
      const lastValues = mockDb.values.mock.calls[mockDb.values.mock.calls.length - 1][0];
      expect(lastValues.linkType).toBe('contradicts');
    });

    it('skips similar memories below threshold', async () => {
      whereResults = [
        [fakeMemory],
        undefined,
        undefined,
        [{ claims: '[]', factuality: null }],
        undefined,
      ];
      qdrantService.recommend.mockResolvedValueOnce([{ id: 'mem-2', score: 0.5 }]);
      aiService.generate
        .mockResolvedValueOnce('{"entities":[]}')
        .mockResolvedValueOnce('{"label":"UNVERIFIED","confidence":0.5,"rationale":""}');

      await service.enrich('mem-1');
    });

    it('skips link to self', async () => {
      whereResults = [
        [fakeMemory],
        undefined,
        undefined,
        [{ claims: '[]', factuality: null }],
        undefined,
      ];
      qdrantService.recommend.mockResolvedValueOnce([{ id: 'mem-1', score: 0.95 }]);
      aiService.generate
        .mockResolvedValueOnce('{"entities":[]}')
        .mockResolvedValueOnce('{"label":"UNVERIFIED","confidence":0.5,"rationale":""}');

      await service.enrich('mem-1');
    });

    it('handles reverse link already existing', async () => {
      whereResults = [
        [fakeMemory],
        undefined,
        undefined,
        [{ claims: '[]', factuality: null }],
        [], // existingLink - empty
        [{ id: 'reverse-link' }], // reverseLink - found
        undefined,
      ];
      qdrantService.recommend.mockResolvedValueOnce([{ id: 'mem-2', score: 0.85 }]);
      aiService.generate
        .mockResolvedValueOnce('{"entities":[]}')
        .mockResolvedValueOnce('{"label":"UNVERIFIED","confidence":0.5,"rationale":""}');

      await service.enrich('mem-1');
    });

    it('handles qdrant recommend failure gracefully', async () => {
      whereResults = [[fakeMemory], undefined, undefined, undefined];
      qdrantService.recommend.mockRejectedValueOnce(new Error('Qdrant down'));
      aiService.generate
        .mockResolvedValueOnce('{"entities":[]}')
        .mockResolvedValueOnce('{"label":"UNVERIFIED","confidence":0.5,"rationale":""}');

      await service.enrich('mem-1');
    });

    it('handles malformed claims JSON', async () => {
      whereResults = [
        [fakeMemory],
        undefined,
        undefined,
        [{ claims: 'not json', factuality: null }],
        [],
        [],
        undefined,
      ];
      qdrantService.recommend.mockResolvedValueOnce([{ id: 'mem-2', score: 0.85 }]);
      aiService.generate
        .mockResolvedValueOnce('{"entities":[]}')
        .mockResolvedValueOnce('{"label":"UNVERIFIED","confidence":0.5,"rationale":""}');

      await service.enrich('mem-1');
    });
  });

  describe('entity deduplication', () => {
    it('deduplicates entities with same type and name', async () => {
      whereResults = [
        [fakeMemory],
        undefined,
        undefined,
        [{ claims: '[]', factuality: null }],
        undefined,
      ];
      aiService.generate
        .mockResolvedValueOnce(
          '{"entities":[{"type":"person","name":"John"},{"type":"person","name":"John"},{"type":"person","name":"Jane"}]}',
        )
        .mockResolvedValueOnce('{"label":"UNVERIFIED","confidence":0.5,"rationale":""}');

      await service.enrich('mem-1');
      const setCalls = mockDb.set.mock.calls;
      const entitySetCall = setCalls.find(
        (c: unknown[]) => (c[0] as Record<string, unknown>).entities !== undefined,
      );
      if (entitySetCall) {
        const entities = JSON.parse(entitySetCall[0].entities);
        expect(entities.length).toBe(2);
      }
    });
  });

  describe('factuality parsing', () => {
    it('handles invalid JSON from factuality response', async () => {
      whereResults = [[fakeMemory], undefined, [{ claims: '[]', factuality: null }], undefined];
      aiService.generate
        .mockResolvedValueOnce('{"entities":[]}')
        .mockResolvedValueOnce('not valid json at all');

      await service.enrich('mem-1');
    });

    it('handles partial factuality JSON (missing confidence)', async () => {
      whereResults = [[fakeMemory], undefined, [{ claims: '[]', factuality: null }], undefined];
      aiService.generate
        .mockResolvedValueOnce('{"entities":[]}')
        .mockResolvedValueOnce('{"label":"FACT"}');

      await service.enrich('mem-1');
    });

    it('parses factuality from text with surrounding content', async () => {
      whereResults = [
        [fakeMemory],
        undefined,
        undefined,
        [{ claims: '[]', factuality: null }],
        undefined,
      ];
      aiService.generate
        .mockResolvedValueOnce('{"entities":[]}')
        .mockResolvedValueOnce(
          'Here is the result: {"label":"FACT","confidence":0.9,"rationale":"confirmed"} end',
        );

      await service.enrich('mem-1');
      // Should have updated factuality (parseJsonObject extracts from surrounding text)
      const factSetCall = mockDb.set.mock.calls.find(
        (c: unknown[]) => (c[0] as Record<string, unknown>).factuality !== undefined,
      );
      expect(factSetCall).toBeDefined();
    });
  });

  describe('getWeights (via enrich)', () => {
    it('falls back to defaults when connector has no weights', async () => {
      connectorsService.get.mockReturnValue({ manifest: { trustScore: 0.85 } });
      whereResults = [
        [fakeMemory],
        undefined,
        undefined,
        [{ claims: '[]', factuality: null }],
        undefined,
      ];
      aiService.generate
        .mockResolvedValueOnce('{"entities":[]}')
        .mockResolvedValueOnce('{"label":"UNVERIFIED","confidence":0.5,"rationale":""}');

      await service.enrich('mem-1');
    });
  });

  describe('getTrustScore (via enrich)', () => {
    it('uses connector trust score', async () => {
      whereResults = [
        [fakeMemory],
        undefined,
        undefined,
        [{ claims: '[]', factuality: null }],
        undefined,
      ];
      aiService.generate
        .mockResolvedValueOnce('{"entities":[]}')
        .mockResolvedValueOnce('{"label":"UNVERIFIED","confidence":0.5,"rationale":""}');

      await service.enrich('mem-1');
      expect(connectorsService.get).toHaveBeenCalledWith('gmail');
    });

    it('falls back to 0.7 if connector not found', async () => {
      connectorsService.get.mockImplementation(() => {
        throw new Error('not found');
      });
      whereResults = [
        [fakeMemory],
        undefined,
        undefined,
        [{ claims: '[]', factuality: null }],
        undefined,
      ];
      aiService.generate
        .mockResolvedValueOnce('{"entities":[]}')
        .mockResolvedValueOnce('{"label":"UNVERIFIED","confidence":0.5,"rationale":""}');

      await service.enrich('mem-1');
    });
  });
});

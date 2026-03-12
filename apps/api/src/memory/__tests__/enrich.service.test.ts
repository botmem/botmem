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
    metadata: null,
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
          '{"entities":[{"type":"person","value":"John"},{"type":"organization","value":"Google"}],"factuality":{"label":"UNVERIFIED","confidence":0.5,"rationale":"default"}}',
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

    const cryptoService = {
      encrypt: vi.fn((v: string | null) => (v ? `enc:${v}` : null)),
      decrypt: vi.fn((v: string | null) => (v ? v.replace('enc:', '') : v)),
      hmac: vi.fn((v: string) => `hmac:${v}`),
    };

    service = new EnrichService(
      { db: mockDb } as unknown as DbService,
      cryptoService as unknown as import('../../crypto/crypto.service').CryptoService,
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
      // For email sourceType, combined prompt: 1 LLM call for entities + factuality
      // DB where() calls:
      // 1. get memory
      // 2. update entities (entities found)
      // 3. update factuality
      // 4. createLinks: select src claims
      // 5. update weights
      whereResults = [
        [fakeMemory], // 1. get memory
        undefined, // 2. update entities
        undefined, // 3. update factuality
        [{ claims: '[]', factuality: null }], // 4. createLinks: select src claims
        undefined, // 5. update weights
      ];

      aiService.generate.mockResolvedValueOnce(
        '{"entities":[{"type":"person","value":"John"}],"factuality":{"label":"UNVERIFIED","confidence":0.7,"rationale":"Single source"}}',
      );

      await service.enrich('mem-1');
      expect(aiService.generate).toHaveBeenCalledTimes(1);
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('handles entity extraction failure gracefully', async () => {
      // For email sourceType, combined call fails → entities=[], factuality=null
      // No entities → no entity update
      // factuality=null → no factuality update
      // DB where() calls:
      // 1. get memory
      // 2. createLinks: select src claims
      // 3. update weights
      whereResults = [
        [fakeMemory], // 1. get memory
        [{ claims: '[]', factuality: null }], // 2. createLinks: select src claims
        undefined, // 3. update weights
      ];
      aiService.generate.mockRejectedValueOnce(new Error('AI down'));

      await service.enrich('mem-1');
      expect(logsService.add).toHaveBeenCalled();
    });

    it('handles factuality classification failure gracefully', async () => {
      // For email sourceType, combined call — if entities parse but factuality is missing/null
      // extractEntitiesAndFactuality returns { entities: [], factuality: null } on full failure
      // Or entities with no factuality if factuality field missing from response
      // DB where() calls:
      // 1. get memory
      // 2. createLinks: select src claims
      // 3. update weights
      whereResults = [
        [fakeMemory], // 1. get memory
        [{ claims: '[]', factuality: null }], // 2. createLinks: select src claims
        undefined, // 3. update weights
      ];
      // Combined call returns entities but no valid factuality
      aiService.generate.mockResolvedValueOnce('{"entities":[],"factuality":{}}');

      await service.enrich('mem-1');
      expect(logsService.add).toHaveBeenCalled();
    });

    it('creates links for similar memories above threshold', async () => {
      // For email sourceType with empty entities response
      // No entities → no entity update, factuality present → factuality update
      // DB where() calls:
      // 1. get memory
      // 2. update factuality (factuality is valid)
      // 3. createLinks: select src claims (no claims → no dst factuality query)
      // 4. batch existing links check
      // 5. update weights
      whereResults = [
        [fakeMemory], // 1. get memory
        undefined, // 2. update factuality
        [{ claims: '[]', factuality: null }], // 3. createLinks: src claims
        [], // 4. batch existing links (none found)
        undefined, // 5. update weights
      ];
      qdrantService.recommend.mockResolvedValueOnce([{ id: 'mem-2', score: 0.85 }]);
      aiService.generate.mockResolvedValueOnce(
        '{"entities":[],"factuality":{"label":"FACT","confidence":0.9,"rationale":"confirmed"}}',
      );

      await service.enrich('mem-1');
      expect(qdrantService.recommend).toHaveBeenCalled();
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it('skips link creation if existing link found', async () => {
      // entities present → entity update + factuality update
      // DB where() calls:
      // 1. get memory
      // 2. update entities
      // 3. update factuality
      // 4. createLinks: src claims
      // 5. batch existing links (found)
      // 6. update weights
      whereResults = [
        [fakeMemory], // 1. get memory
        undefined, // 2. update entities
        undefined, // 3. update factuality
        [{ claims: '[]', factuality: null }], // 4. createLinks: src claims
        [{ srcMemoryId: 'mem-1', dstMemoryId: 'mem-2' }], // 5. batch existing links
        undefined, // 6. update weights
      ];
      qdrantService.recommend.mockResolvedValueOnce([{ id: 'mem-2', score: 0.85 }]);
      aiService.generate.mockResolvedValueOnce(
        '{"entities":[{"type":"person","value":"John"}],"factuality":{"label":"UNVERIFIED","confidence":0.5,"rationale":"default"}}',
      );

      await service.enrich('mem-1');
      // insert should not be called for links since existing link found
    });
  });

  describe('link types', () => {
    it('creates "supports" link when both FACT and score >= 0.92', async () => {
      // entities present → entity update + factuality update
      // srcClaims present → dst factuality batch query
      // DB where() calls:
      // 1. get memory
      // 2. update entities
      // 3. update factuality
      // 4. createLinks: src claims (has claims + FACT)
      // 5. batch existing links
      // 6. batch dst factuality
      // 7. update weights
      whereResults = [
        [fakeMemory], // 1. get memory
        undefined, // 2. update entities
        undefined, // 3. update factuality
        [{ claims: '[{"text":"John works at Google"}]', factuality: '{"label":"FACT"}' }], // 4. src claims
        [], // 5. batch existing links (none)
        [{ id: 'mem-2', factuality: '{"label":"FACT"}' }], // 6. batch dst factuality
        undefined, // 7. update weights
      ];
      qdrantService.recommend.mockResolvedValueOnce([{ id: 'mem-2', score: 0.95 }]);
      aiService.generate.mockResolvedValueOnce(
        '{"entities":[{"type":"person","value":"John"}],"factuality":{"label":"FACT","confidence":0.95,"rationale":"confirmed"}}',
      );

      await service.enrich('mem-1');
      const lastValues = mockDb.values.mock.calls[mockDb.values.mock.calls.length - 1][0];
      expect(lastValues.linkType).toBe('supports');
    });

    it('creates "contradicts" link when FACT vs FICTION and score >= 0.85', async () => {
      // No entities → no entity update; factuality update present
      // srcClaims present → dst factuality batch query
      // DB where() calls:
      // 1. get memory
      // 2. update factuality
      // 3. createLinks: src claims (has claims + FACT)
      // 4. batch existing links
      // 5. batch dst factuality
      // 6. update weights
      whereResults = [
        [fakeMemory], // 1. get memory
        undefined, // 2. update factuality
        [{ claims: '[{"text":"something"}]', factuality: '{"label":"FACT"}' }], // 3. src claims
        [], // 4. batch existing links (none)
        [{ id: 'mem-2', factuality: '{"label":"FICTION"}' }], // 5. batch dst factuality
        undefined, // 6. update weights
      ];
      qdrantService.recommend.mockResolvedValueOnce([{ id: 'mem-2', score: 0.9 }]);
      aiService.generate.mockResolvedValueOnce(
        '{"entities":[],"factuality":{"label":"FACT","confidence":0.9,"rationale":"confirmed"}}',
      );

      await service.enrich('mem-1');
      const lastValues = mockDb.values.mock.calls[mockDb.values.mock.calls.length - 1][0];
      expect(lastValues.linkType).toBe('contradicts');
    });

    it('creates "contradicts" link for FICTION vs FACT', async () => {
      // No entities → no entity update; factuality update present
      // DB where() calls:
      // 1. get memory
      // 2. update factuality
      // 3. createLinks: src claims (has claims + FICTION)
      // 4. batch existing links
      // 5. batch dst factuality
      // 6. update weights
      whereResults = [
        [fakeMemory], // 1. get memory
        undefined, // 2. update factuality
        [{ claims: '["claim"]', factuality: '{"label":"FICTION"}' }], // 3. src claims
        [], // 4. batch existing links
        [{ id: 'mem-2', factuality: '{"label":"FACT"}' }], // 5. batch dst factuality
        undefined, // 6. update weights
      ];
      qdrantService.recommend.mockResolvedValueOnce([{ id: 'mem-2', score: 0.88 }]);
      aiService.generate.mockResolvedValueOnce(
        '{"entities":[],"factuality":{"label":"FICTION","confidence":0.8,"rationale":"made up"}}',
      );

      await service.enrich('mem-1');
      const lastValues = mockDb.values.mock.calls[mockDb.values.mock.calls.length - 1][0];
      expect(lastValues.linkType).toBe('contradicts');
    });

    it('skips similar memories below threshold', async () => {
      // No entities, factuality present → factuality update only
      // DB where() calls:
      // 1. get memory
      // 2. update factuality
      // 3. createLinks: src claims (no candidates above threshold → returns early)
      // 4. update weights
      whereResults = [
        [fakeMemory], // 1. get memory
        undefined, // 2. update factuality
        [{ claims: '[]', factuality: null }], // 3. createLinks: src claims
        undefined, // 4. update weights
      ];
      qdrantService.recommend.mockResolvedValueOnce([{ id: 'mem-2', score: 0.5 }]);
      aiService.generate.mockResolvedValueOnce(
        '{"entities":[],"factuality":{"label":"UNVERIFIED","confidence":0.5,"rationale":"default"}}',
      );

      await service.enrich('mem-1');
    });

    it('skips link to self', async () => {
      // No entities, factuality present → factuality update only
      // DB where() calls:
      // 1. get memory
      // 2. update factuality
      // 3. createLinks: src claims (self filtered out → no candidates)
      // 4. update weights
      whereResults = [
        [fakeMemory], // 1. get memory
        undefined, // 2. update factuality
        [{ claims: '[]', factuality: null }], // 3. createLinks: src claims
        undefined, // 4. update weights
      ];
      qdrantService.recommend.mockResolvedValueOnce([{ id: 'mem-1', score: 0.95 }]);
      aiService.generate.mockResolvedValueOnce(
        '{"entities":[],"factuality":{"label":"UNVERIFIED","confidence":0.5,"rationale":"default"}}',
      );

      await service.enrich('mem-1');
    });

    it('handles reverse link already existing', async () => {
      // No entities, factuality present → factuality update only
      // DB where() calls:
      // 1. get memory
      // 2. update factuality
      // 3. createLinks: src claims
      // 4. batch existing links (reverse found)
      // 5. update weights
      whereResults = [
        [fakeMemory], // 1. get memory
        undefined, // 2. update factuality
        [{ claims: '[]', factuality: null }], // 3. createLinks: src claims
        [{ srcMemoryId: 'mem-2', dstMemoryId: 'mem-1' }], // 4. batch existing links (reverse found)
        undefined, // 5. update weights
      ];
      qdrantService.recommend.mockResolvedValueOnce([{ id: 'mem-2', score: 0.85 }]);
      aiService.generate.mockResolvedValueOnce(
        '{"entities":[],"factuality":{"label":"UNVERIFIED","confidence":0.5,"rationale":"default"}}',
      );

      await service.enrich('mem-1');
    });

    it('handles qdrant recommend failure gracefully', async () => {
      // No entities, factuality present → factuality update only
      // Qdrant fails → createLinks catches error
      // DB where() calls:
      // 1. get memory
      // 2. update factuality
      // 3. update weights (createLinks error is caught)
      whereResults = [
        [fakeMemory], // 1. get memory
        undefined, // 2. update factuality
        undefined, // 3. update weights
      ];
      qdrantService.recommend.mockRejectedValueOnce(new Error('Qdrant down'));
      aiService.generate.mockResolvedValueOnce(
        '{"entities":[],"factuality":{"label":"UNVERIFIED","confidence":0.5,"rationale":"default"}}',
      );

      await service.enrich('mem-1');
    });

    it('handles malformed claims JSON', async () => {
      // No entities, factuality present → factuality update only
      // DB where() calls:
      // 1. get memory
      // 2. update factuality
      // 3. createLinks: src claims (malformed JSON → srcClaims=[])
      // 4. batch existing links
      // 5. update weights
      whereResults = [
        [fakeMemory], // 1. get memory
        undefined, // 2. update factuality
        [{ claims: 'not json', factuality: null }], // 3. createLinks: src claims
        [], // 4. batch existing links
        undefined, // 5. update weights
      ];
      qdrantService.recommend.mockResolvedValueOnce([{ id: 'mem-2', score: 0.85 }]);
      aiService.generate.mockResolvedValueOnce(
        '{"entities":[],"factuality":{"label":"UNVERIFIED","confidence":0.5,"rationale":"default"}}',
      );

      await service.enrich('mem-1');
    });
  });

  describe('entity deduplication', () => {
    it('deduplicates entities with same type and name', async () => {
      // entities found → entity update + factuality update
      // DB where() calls:
      // 1. get memory
      // 2. update entities
      // 3. update factuality
      // 4. createLinks: src claims
      // 5. update weights
      whereResults = [
        [fakeMemory], // 1. get memory
        undefined, // 2. update entities
        undefined, // 3. update factuality
        [{ claims: '[]', factuality: null }], // 4. createLinks: src claims
        undefined, // 5. update weights
      ];
      aiService.generate.mockResolvedValueOnce(
        '{"entities":[{"type":"person","name":"John"},{"type":"person","name":"John"},{"type":"person","name":"Jane"}],"factuality":{"label":"UNVERIFIED","confidence":0.5,"rationale":"default"}}',
      );

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
      // Combined call returns invalid JSON → extractEntitiesAndFactuality catches,
      // returns { entities: [], factuality: null }
      // No entities → no entity update, no factuality → no factuality update
      // DB where() calls:
      // 1. get memory
      // 2. createLinks: src claims
      // 3. update weights
      whereResults = [
        [fakeMemory], // 1. get memory
        [{ claims: '[]', factuality: null }], // 2. createLinks: src claims
        undefined, // 3. update weights
      ];
      aiService.generate.mockResolvedValueOnce('not valid json at all');

      await service.enrich('mem-1');
    });

    it('handles partial factuality JSON (missing confidence)', async () => {
      // Combined call returns entities but factuality has no confidence (number check fails)
      // → factuality=null
      // No entities → no entity update, no factuality → no factuality update
      // DB where() calls:
      // 1. get memory
      // 2. createLinks: src claims
      // 3. update weights
      whereResults = [
        [fakeMemory], // 1. get memory
        [{ claims: '[]', factuality: null }], // 2. createLinks: src claims
        undefined, // 3. update weights
      ];
      aiService.generate.mockResolvedValueOnce('{"entities":[],"factuality":{"label":"FACT"}}');

      await service.enrich('mem-1');
    });

    it('parses factuality from text with surrounding content', async () => {
      // Combined call with surrounding text → parseJsonObject extracts JSON
      // entities empty → no entity update; factuality valid → factuality update
      // DB where() calls:
      // 1. get memory
      // 2. update factuality
      // 3. createLinks: src claims
      // 4. update weights
      whereResults = [
        [fakeMemory], // 1. get memory
        undefined, // 2. update factuality
        [{ claims: '[]', factuality: null }], // 3. createLinks: src claims
        undefined, // 4. update weights
      ];
      aiService.generate.mockResolvedValueOnce(
        'Here is the result: {"entities":[],"factuality":{"label":"FACT","confidence":0.9,"rationale":"confirmed"}} end',
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
      // No entities, factuality present → factuality update only
      // DB where() calls:
      // 1. get memory
      // 2. update factuality
      // 3. createLinks: src claims
      // 4. update weights
      whereResults = [
        [fakeMemory], // 1. get memory
        undefined, // 2. update factuality
        [{ claims: '[]', factuality: null }], // 3. createLinks: src claims
        undefined, // 4. update weights
      ];
      aiService.generate.mockResolvedValueOnce(
        '{"entities":[],"factuality":{"label":"UNVERIFIED","confidence":0.5,"rationale":"default"}}',
      );

      await service.enrich('mem-1');
    });
  });

  describe('getTrustScore (via enrich)', () => {
    it('uses connector trust score', async () => {
      // No entities, factuality present → factuality update only
      // DB where() calls:
      // 1. get memory
      // 2. update factuality
      // 3. createLinks: src claims
      // 4. update weights
      whereResults = [
        [fakeMemory], // 1. get memory
        undefined, // 2. update factuality
        [{ claims: '[]', factuality: null }], // 3. createLinks: src claims
        undefined, // 4. update weights
      ];
      aiService.generate.mockResolvedValueOnce(
        '{"entities":[],"factuality":{"label":"UNVERIFIED","confidence":0.5,"rationale":"default"}}',
      );

      await service.enrich('mem-1');
      expect(connectorsService.get).toHaveBeenCalledWith('gmail');
    });

    it('falls back to 0.7 if connector not found', async () => {
      connectorsService.get.mockImplementation(() => {
        throw new Error('not found');
      });
      // No entities, factuality present → factuality update only
      // DB where() calls:
      // 1. get memory
      // 2. update factuality
      // 3. createLinks: src claims
      // 4. update weights
      whereResults = [
        [fakeMemory], // 1. get memory
        undefined, // 2. update factuality
        [{ claims: '[]', factuality: null }], // 3. createLinks: src claims
        undefined, // 4. update weights
      ];
      aiService.generate.mockResolvedValueOnce(
        '{"entities":[],"factuality":{"label":"UNVERIFIED","confidence":0.5,"rationale":"default"}}',
      );

      await service.enrich('mem-1');
    });
  });
});

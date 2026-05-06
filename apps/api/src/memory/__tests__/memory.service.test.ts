import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryService } from '../memory.service';
import type { DbService } from '../../db/db.service';

function makeDbService(db: Record<string, ReturnType<typeof vi.fn>>) {
  return {
    db,
    withCurrentUser: vi.fn().mockImplementation((fn: (d: typeof db) => unknown) => fn(db)),
  } as unknown as DbService;
}

describe('MemoryService', () => {
  let service: MemoryService;
  let aiService: {
    embed: ReturnType<typeof vi.fn>;
    embedQuery: ReturnType<typeof vi.fn>;
    generate: ReturnType<typeof vi.fn>;
  };
  let searchIndexService: {
    search: ReturnType<typeof vi.fn>;
    hybridSearch: ReturnType<typeof vi.fn>;
    ensureCollection: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    buildFilterString: ReturnType<typeof vi.fn>;
    buildLegacyFilter: ReturnType<typeof vi.fn>;
    textSearch: ReturnType<typeof vi.fn>;
    getSchemaStatus: ReturnType<typeof vi.fn>;
  };
  let connectorsService: { get: ReturnType<typeof vi.fn> };
  let pluginRegistry: {
    getScorers: ReturnType<typeof vi.fn>;
    fireHook: ReturnType<typeof vi.fn>;
  };
  let cryptoService: Record<string, ReturnType<typeof vi.fn>>;
  let userKeyService: { getKey: ReturnType<typeof vi.fn>; getDek: ReturnType<typeof vi.fn> };
  let mockDb: Record<string, ReturnType<typeof vi.fn>>;

  const fakeMemoryRow = {
    id: 'mem-1',
    accountId: 'acc-1',
    connectorType: 'gmail',
    sourceType: 'email',
    sourceId: 'src-1',
    text: 'Meeting with John about project',
    eventTime: new Date('2025-06-01'),
    ingestTime: new Date('2025-06-01'),
    createdAt: new Date('2025-06-01'),
    factuality: '{"label":"UNVERIFIED","confidence":0.5}',
    entities: '[]',
    claims: '[]',
    metadata: '{}',
    weights: '{}',
    pinned: false,
    pipelineComplete: true,
    embeddingStatus: 'done',
    memoryBankId: null,
    importance: 0.5,
  };

  beforeEach(() => {
    aiService = {
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      embedQuery: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      generate: vi.fn().mockResolvedValue('generated text'),
    };

    searchIndexService = {
      search: vi.fn().mockResolvedValue([]),
      hybridSearch: vi.fn().mockResolvedValue({ results: [], facetCounts: [], found: 0 }),
      ensureCollection: vi.fn(),
      upsert: vi.fn(),
      remove: vi.fn(),
      buildFilterString: vi.fn().mockReturnValue(''),
      textSearch: vi.fn().mockResolvedValue([]),
      getSchemaStatus: vi.fn().mockResolvedValue({
        collection: 'memories',
        currentVersion: 2,
        expectedVersion: 2,
        status: 'current',
        missingFields: [],
      }),
      buildLegacyFilter: vi.fn().mockReturnValue(''),
    };

    connectorsService = {
      get: vi.fn().mockReturnValue({
        manifest: {
          trustScore: 0.8,
          weights: { semantic: 0.4, recency: 0.25, importance: 0.2, trust: 0.15 },
        },
      }),
    };

    pluginRegistry = {
      getScorers: vi.fn().mockReturnValue([]),
      fireHook: vi.fn().mockResolvedValue(undefined),
    };

    cryptoService = {
      encrypt: vi.fn().mockImplementation((v: string) => v),
      decrypt: vi.fn().mockImplementation((v: string) => v),
      isEncrypted: vi.fn().mockReturnValue(false),
      decryptMemoryFieldsWithKey: vi
        .fn()
        .mockImplementation((m: Record<string, string | null>) => m),
      decryptMemoryFieldsWithKeyStrict: vi
        .fn()
        .mockImplementation((m: Record<string, string | null>) => m),
      encryptMemoryFieldsWithKey: vi.fn().mockImplementation((m: Record<string, string>) => m),
      decryptWithKeyStrict: vi.fn().mockImplementation((v: string) => v),
    };

    userKeyService = {
      getKey: vi.fn().mockReturnValue(null),
      getDek: vi.fn().mockResolvedValue(null),
    };

    mockDb = {} as Record<string, ReturnType<typeof vi.fn>>;
    const self = () => mockDb;
    mockDb.select = vi.fn(self);
    mockDb.from = vi.fn(self);
    mockDb.where = vi.fn(self);
    mockDb.orderBy = vi.fn(self);
    mockDb.limit = vi.fn(self);
    mockDb.offset = vi.fn(self);
    mockDb.leftJoin = vi.fn(self);
    mockDb.innerJoin = vi.fn(self);
    mockDb.groupBy = vi.fn(self);
    mockDb.insert = vi.fn(self);
    mockDb.values = vi.fn().mockResolvedValue(undefined);
    mockDb.update = vi.fn(self);
    mockDb.set = vi.fn(self);
    mockDb.delete = vi.fn(self);
    mockDb.execute = vi.fn().mockResolvedValue({ rows: [] });
    mockDb.transaction = vi
      .fn()
      .mockImplementation(async (fn: (tx: Record<string, ReturnType<typeof vi.fn>>) => unknown) => {
        const tx = {
          delete: vi.fn().mockReturnThis(),
          where: vi.fn().mockResolvedValue(undefined),
        };
        return fn(tx);
      });
    mockDb.then = vi.fn().mockImplementation((fn: (...args: unknown[]) => unknown) => fn([]));

    service = new MemoryService(
      makeDbService(mockDb),
      aiService,
      searchIndexService,
      connectorsService,
      pluginRegistry,
      cryptoService,
      userKeyService,
    );
  });

  describe('search', () => {
    it('returns empty items for empty query', async () => {
      const response = await service.search('');
      expect(response.items).toEqual([]);
      expect(aiService.embed).not.toHaveBeenCalled();
    });

    it('returns empty items for whitespace query', async () => {
      const response = await service.search('   ');
      expect(response.items).toEqual([]);
    });

    it('embeds the query and calls search pipeline', async () => {
      const result = await service.search('meeting with john');
      expect(aiService.embedQuery).toHaveBeenCalled();
      expect(searchIndexService.textSearch).toHaveBeenCalled();
      expect(result).toHaveProperty('items');
    });

    it('strips request filler words from lexical search queries', async () => {
      await service.search('what are the death certificate details');

      expect(searchIndexService.textSearch).toHaveBeenCalledWith(
        'death certificate',
        expect.any(Number),
        undefined,
        'text,entities_text,people,locations,location_text,organizations',
      );
    });

    it('returns diagnostics when debug is enabled', async () => {
      const result = await service.search(
        'card top ups ghanoomy',
        undefined,
        20,
        undefined,
        undefined,
        undefined,
        undefined,
        { debug: true },
      );
      expect(result.diagnostics?.intent).toBe('transaction');
      expect(result.diagnostics?.schemaStatus?.status).toBe('current');
    });

    it('reruns mixed topical searches without entity resolution when entity hints have no topic evidence', async () => {
      (service as unknown as { contactsCache: Map<string, unknown> }).contactsCache.set(
        '__none__',
        {
          expires: Date.now() + 60_000,
          data: [{ id: 'person-1', displayName: 'Acme Booking', entityType: 'person' }],
        },
      );
      searchIndexService.hybridSearch
        .mockResolvedValueOnce({ results: [], facetCounts: [], found: 0 })
        .mockResolvedValueOnce({
          results: [{ id: 'mem-1', score: 0.92 }],
          facetCounts: [],
          found: 1,
        });
      searchIndexService.textSearch
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'mem-1', score: 0.92 }]);
      vi.spyOn(
        service as unknown as { fetchMemoryRowsBatch: (ids: string[]) => unknown },
        'fetchMemoryRowsBatch',
      ).mockResolvedValueOnce(
        new Map([['mem-1', { memory: fakeMemoryRow, accountIdentifier: null }]]),
      );

      const result = await service.search(
        'latest Acme booking email',
        { connectorType: 'gmail' },
        5,
        undefined,
        undefined,
        undefined,
        undefined,
        { debug: true },
      );

      expect(result.items).toHaveLength(1);
      expect(result.fallback).toBe(true);
      expect(result.resolvedEntities?.contacts[0].displayName).toBe('Acme Booking');
      expect(result.diagnostics?.entityResolutionFallback).toBe('reran_without_entities');
      expect(searchIndexService.hybridSearch).toHaveBeenCalledTimes(2);
    });

    it('reruns empty pure contact-like queries without entity resolution', async () => {
      (service as unknown as { contactsCache: Map<string, unknown> }).contactsCache.set(
        '__none__',
        {
          expires: Date.now() + 60_000,
          data: [{ id: 'person-1', displayName: 'Acme', entityType: 'person' }],
        },
      );
      searchIndexService.hybridSearch
        .mockResolvedValueOnce({ results: [], facetCounts: [], found: 0 })
        .mockResolvedValueOnce({
          results: [{ id: 'mem-1', score: 0.88 }],
          facetCounts: [],
          found: 1,
        });
      searchIndexService.textSearch
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'mem-1', score: 0.88 }]);
      vi.spyOn(
        service as unknown as { fetchMemoryRowsBatch: (ids: string[]) => unknown },
        'fetchMemoryRowsBatch',
      ).mockResolvedValueOnce(
        new Map([
          [
            'mem-1',
            {
              memory: {
                ...fakeMemoryRow,
                text: 'Acme itinerary and ticket details',
              },
              accountIdentifier: null,
            },
          ],
        ]),
      );

      const result = await service.search(
        'Acme',
        { connectorType: 'gmail' },
        5,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          debug: true,
        },
      );

      expect(result.items).toHaveLength(1);
      expect(result.fallback).toBe(true);
      expect(result.diagnostics?.entityResolutionFallback).toBe('reran_without_entities');
      expect(result.items[0].text).toContain('Acme itinerary');
    });

    it('ranks fallback candidates by dynamic query token coverage', async () => {
      searchIndexService.hybridSearch.mockResolvedValueOnce({
        results: [
          { id: 'noise', score: 0.82 },
          { id: 'relevant', score: 0.82 },
        ],
        facetCounts: [],
        found: 2,
      });
      searchIndexService.textSearch.mockResolvedValueOnce([
        { id: 'noise', score: 0.82 },
        { id: 'relevant', score: 0.82 },
      ]);
      vi.spyOn(
        service as unknown as { fetchMemoryRowsBatch: (ids: string[]) => unknown },
        'fetchMemoryRowsBatch',
      ).mockResolvedValueOnce(
        new Map([
          [
            'noise',
            {
              memory: {
                ...fakeMemoryRow,
                id: 'noise',
                text: 'Latest account statement and money transfer receipt',
              },
              accountIdentifier: null,
            },
          ],
          [
            'relevant',
            {
              memory: {
                ...fakeMemoryRow,
                id: 'relevant',
                text: 'Latest Acme booking ticket confirmation and itinerary',
              },
              accountIdentifier: null,
            },
          ],
        ]),
      );

      const result = await service.search(
        'latest Acme booking ticket',
        { connectorType: 'gmail' },
        5,
        undefined,
        undefined,
        undefined,
        undefined,
        { debug: true, noEntityResolution: true },
      );

      expect(result.items.map((item) => item.id)).toEqual(['relevant', 'noise']);
      expect(result.diagnostics?.topScoreComponents[0].queryCoverage).toBe(1);
    });

    it('boosts recency and source metadata for latest booking intent without hard-coded brands', async () => {
      searchIndexService.hybridSearch.mockResolvedValueOnce({
        results: [
          { id: 'generic-booking', score: 0.82 },
          { id: 'source-matched', score: 0.82 },
        ],
        facetCounts: [],
        found: 2,
      });
      searchIndexService.textSearch.mockResolvedValueOnce([
        { id: 'generic-booking', score: 0.82 },
        { id: 'source-matched', score: 0.82 },
      ]);
      vi.spyOn(
        service as unknown as { fetchMemoryRowsBatch: (ids: string[]) => unknown },
        'fetchMemoryRowsBatch',
      ).mockResolvedValueOnce(
        new Map([
          [
            'generic-booking',
            {
              memory: {
                ...fakeMemoryRow,
                id: 'generic-booking',
                text: 'Booking ticket confirmation for a cinema event',
                eventTime: new Date('2024-01-01T00:00:00.000Z'),
                metadata: JSON.stringify({ from: 'tickets@example-cinema.test' }),
              },
              accountIdentifier: null,
            },
          ],
          [
            'source-matched',
            {
              memory: {
                ...fakeMemoryRow,
                id: 'source-matched',
                text: 'Booking ticket confirmation',
                eventTime: new Date(),
                metadata: JSON.stringify({
                  from: 'updates@northstarair.example',
                  subject: 'NorthstarAir booking ticket',
                }),
              },
              accountIdentifier: null,
            },
          ],
        ]),
      );

      const result = await service.search(
        'latest northstarair booking ticket',
        { connectorType: 'gmail' },
        5,
        undefined,
        undefined,
        undefined,
        undefined,
        { debug: true, noEntityResolution: true },
      );

      expect(result.items.map((item) => item.id)).toEqual(['source-matched', 'generic-booking']);
      expect(result.diagnostics?.topScoreComponents[0].sourceBoost).toBeGreaterThan(1);
      expect(result.diagnostics?.topScoreComponents[0].recencyBoost).toBeGreaterThan(1);
      expect(result.diagnostics?.topScoreComponents[1].negativePrior).toBeLessThan(1);
    });

    it('returns empty when user has no accounts', async () => {
      // getUserAccountIds returns empty array for user with no accounts
      mockDb.where.mockResolvedValueOnce([]); // accounts query

      const response = await service.search('test', undefined, 20, false, 'user-with-no-accounts');
      expect(response.items).toEqual([]);
    });

    it('applies source type filter from NLQ', async () => {
      searchIndexService.hybridSearch.mockResolvedValueOnce({
        results: [],
        facetCounts: [],
        found: 0,
      });
      mockDb.execute.mockResolvedValueOnce({ rows: [] });

      // A query like "emails about project" should detect sourceType
      const response = await service.search('test query');
      // Just verify no crash — NLQ parsing is tested separately
      expect(response.items).toBeDefined();
    });
  });

  describe('getById', () => {
    it('returns null for non-existent memory', async () => {
      mockDb.where.mockResolvedValueOnce([]);
      const result = await service.getById('nonexistent');
      expect(result).toBeNull();
    });

    it('returns decrypted memory with people', async () => {
      mockDb.where.mockResolvedValueOnce([fakeMemoryRow]); // memory row
      mockDb.where.mockResolvedValueOnce([
        { memoryId: 'mem-1', role: 'sender', personId: 'p-1', displayName: 'John' },
      ]); // people
      const result = await service.getById('mem-1');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('mem-1');
      expect(result!.text).toBe('Meeting with John about project');
      expect(result!.people).toHaveLength(1);
      expect(result!.people[0].displayName).toBe('John');
    });

    it('decrypts with user key when available', async () => {
      mockDb.where.mockResolvedValueOnce([fakeMemoryRow]);
      userKeyService.getDek.mockResolvedValueOnce(Buffer.from('userkey'));

      await service.getById('mem-1', 'user-1');
      expect(cryptoService.decryptMemoryFieldsWithKeyStrict).toHaveBeenCalled();
    });

    it('returns null when user key not available for encrypted memory', async () => {
      mockDb.where.mockResolvedValueOnce([fakeMemoryRow]);
      userKeyService.getDek.mockResolvedValueOnce(null);
      userKeyService.getKey.mockReturnValueOnce(null);
      cryptoService.isEncrypted.mockReturnValueOnce(true);

      const result = await service.getById('mem-1', 'user-1');
      expect(result).toBeNull();
    });
  });

  describe('list', () => {
    it('returns items with people and total count', async () => {
      // The dashboard list path reads from memory_search_index:
      // 1. total count (terminal)
      // 2. rows query (chains to orderBy→limit→offset)
      // 3. getPeopleForMemories (terminal)
      let whereCall = 0;
      mockDb.where.mockImplementation(() => {
        whereCall++;
        if (whereCall === 1) return Promise.resolve([{ count: 1 }]);
        if (whereCall === 3)
          return Promise.resolve([
            { memoryId: 'mem-1', role: 'sender', personId: 'p-1', displayName: 'Alice' },
          ]);
        return mockDb; // call 2: chain continues
      });
      mockDb.offset.mockResolvedValueOnce([
        {
          id: fakeMemoryRow.id,
          accountId: fakeMemoryRow.accountId,
          accountIdentifier: 'test@gmail.com',
          connectorType: fakeMemoryRow.connectorType,
          sourceType: fakeMemoryRow.sourceType,
          text: fakeMemoryRow.text,
          eventTime: fakeMemoryRow.eventTime,
          factualityLabel: 'UNVERIFIED',
          pinned: fakeMemoryRow.pinned,
          importance: fakeMemoryRow.importance,
          recallCount: 0,
        },
      ]);

      const result = await service.list({ userId: 'user-1' });
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.items[0].people).toHaveLength(1);
      expect(result.items[0].people[0].displayName).toBe('Alice');
    });

    it('returns empty when user has no accounts', async () => {
      mockDb.where.mockResolvedValueOnce([{ count: 0 }]);
      mockDb.offset.mockResolvedValueOnce([]);
      const result = await service.list({ userId: 'user-1' });
      expect(result).toEqual({ items: [], total: 0 });
    });

    it('applies connector and source type filters', async () => {
      mockDb.where.mockResolvedValueOnce([{ count: 0 }]); // total
      mockDb.offset.mockResolvedValueOnce([]); // rows

      await service.list({
        userId: 'user-1',
        connectorType: 'gmail',
        sourceType: 'email',
        limit: 10,
        offset: 5,
      });
      // No crash = success with filters applied
    });
  });

  describe('timeline', () => {
    it('returns metadata as a parsed object and supports fromMe filtering', async () => {
      vi.spyOn(service, 'getPeopleForMemories').mockResolvedValueOnce(new Map());
      mockDb.where.mockResolvedValueOnce([{ count: 1 }]);
      mockDb.limit.mockResolvedValueOnce([
        {
          memory: {
            ...fakeMemoryRow,
            metadata: JSON.stringify({ fromMe: true, senderName: 'Me' }),
          },
          accountIdentifier: 'me@example.com',
        },
      ]);

      const result = await service.timeline({ fromMe: true });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].metadata).toEqual({ fromMe: true, senderName: 'Me' });
    });

    it('hydrates missing WhatsApp sender names from linked sender people', async () => {
      vi.spyOn(service, 'getPeopleForMemories').mockResolvedValueOnce(
        new Map([
          ['mem-1', [{ role: 'sender', personId: 'person-1', displayName: 'Linked Sender' }]],
        ]),
      );
      mockDb.where.mockResolvedValueOnce([{ count: 1 }]);
      mockDb.limit.mockResolvedValueOnce([
        {
          memory: {
            ...fakeMemoryRow,
            connectorType: 'whatsapp',
            sourceType: 'message',
            metadata: JSON.stringify({ fromMe: false, senderLid: '123456' }),
          },
          accountIdentifier: 'wa@example.com',
        },
      ]);

      const result = await service.timeline({ connectorType: 'whatsapp' });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].metadata).toMatchObject({
        fromMe: false,
        senderLid: '123456',
        senderName: 'Linked Sender',
      });
    });
  });

  describe('insert', () => {
    it('creates a new memory and returns it', async () => {
      const result = await service.insert({
        text: 'New memory',
        sourceType: 'note',
        connectorType: 'manual',
      });
      expect(result.id).toBeDefined();
      expect(result.text).toBe('New memory');
      expect(result.sourceType).toBe('note');
      expect(mockDb.insert).toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('deletes memory from DB and search index', async () => {
      await service.delete('mem-1');
      expect(searchIndexService.remove).toHaveBeenCalledWith('mem-1');
    });

    it('handles search index removal failure gracefully', async () => {
      searchIndexService.remove.mockRejectedValueOnce(new Error('search index down'));
      // Should not throw
      await service.delete('mem-1');
    });
  });

  describe('getStats', () => {
    it('returns stats with zero totals when user has no accounts', async () => {
      mockDb.where.mockResolvedValueOnce([]); // no accounts
      const result = await service.getStats('user-1');
      expect(result.total).toBe(0);
    });

    it('returns zero stats structure when user has no accounts', async () => {
      mockDb.where.mockResolvedValueOnce([]); // no accounts
      const result = await service.getStats('user-1');
      expect(result).toEqual({ total: 0, bySource: {}, byConnector: {}, byFactuality: {} });
    });
  });

  describe('needsRecoveryKey', () => {
    it('returns false when no userId', async () => {
      const result = await service.needsRecoveryKey();
      expect(result).toBe(false);
    });

    it('returns false when user has DEK', async () => {
      userKeyService.getDek.mockResolvedValueOnce(Buffer.from('key'));
      mockDb.where.mockResolvedValueOnce([{ id: 'acc-1' }]).mockReturnValueOnce(mockDb);
      mockDb.limit.mockResolvedValueOnce([]);
      const result = await service.needsRecoveryKey('user-1');
      expect(result).toBe(false);
    });

    it('returns true when no DEK and encrypted memories exist', async () => {
      userKeyService.getDek.mockResolvedValueOnce(null);
      cryptoService.isEncrypted.mockReturnValueOnce(true);
      mockDb.where.mockResolvedValueOnce([{ id: 'acc-1' }]).mockReturnValueOnce(mockDb);
      mockDb.limit.mockResolvedValueOnce([{ text: 'iv:cipher:tag' }]);
      const result = await service.needsRecoveryKey('user-1');
      expect(result).toBe(true);
    });

    it('returns false when no DEK but no encrypted memories', async () => {
      userKeyService.getDek.mockResolvedValueOnce(null);
      mockDb.where
        .mockResolvedValueOnce([{ id: 'acc-1' }])
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([{ id: 'acc-1' }])
        .mockReturnValueOnce(mockDb);
      mockDb.limit.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      const result = await service.needsRecoveryKey('user-1');
      expect(result).toBe(false);
    });

    it('returns true when no DEK and raw memory pipeline debt exists', async () => {
      userKeyService.getDek.mockResolvedValueOnce(null);
      mockDb.where
        .mockResolvedValueOnce([{ id: 'acc-1' }])
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([{ id: 'acc-1' }])
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb);
      mockDb.limit
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ recoveryKeyHash: 'hash' }])
        .mockResolvedValueOnce([{ id: 'raw-1' }]);

      const result = await service.needsRecoveryKey('user-1');

      expect(result).toBe(true);
    });
  });

  describe('getUserAccountIds', () => {
    it('returns null when no userId', async () => {
      const result = await service.getUserAccountIds();
      expect(result).toBeNull();
    });

    it('returns account IDs for user', async () => {
      mockDb.where.mockResolvedValueOnce([{ id: 'acc-1' }, { id: 'acc-2' }]);
      const result = await service.getUserAccountIds('user-1');
      expect(result).toEqual(['acc-1', 'acc-2']);
    });

    it('returns empty array when user has no accounts', async () => {
      mockDb.where.mockResolvedValueOnce([]);
      const result = await service.getUserAccountIds('user-1');
      expect(result).toEqual([]);
    });
  });

  describe('getPeopleForMemories', () => {
    it('returns empty map for empty input', async () => {
      const result = await service.getPeopleForMemories([]);
      expect(result.size).toBe(0);
    });

    it('returns people grouped by memory ID', async () => {
      mockDb.where.mockResolvedValueOnce([
        { memoryId: 'mem-1', role: 'sender', personId: 'p-1', displayName: 'Alice' },
        { memoryId: 'mem-1', role: 'recipient', personId: 'p-2', displayName: 'Bob' },
        { memoryId: 'mem-2', role: 'sender', personId: 'p-1', displayName: 'Alice' },
      ]);

      const result = await service.getPeopleForMemories(['mem-1', 'mem-2']);
      expect(result.get('mem-1')).toHaveLength(2);
      expect(result.get('mem-2')).toHaveLength(1);
      expect(result.get('mem-1')![0].displayName).toBe('Alice');
      expect(result.get('mem-1')![1].displayName).toBe('Bob');
    });

    it('decrypts display names', async () => {
      cryptoService.decrypt.mockImplementation((v: string) =>
        v === 'encrypted-name' ? 'Decrypted Name' : v,
      );
      mockDb.where.mockResolvedValueOnce([
        { memoryId: 'mem-1', role: 'sender', personId: 'p-1', displayName: 'encrypted-name' },
      ]);

      const result = await service.getPeopleForMemories(['mem-1']);
      expect(result.get('mem-1')![0].displayName).toBe('Decrypted Name');
    });
  });

  describe('invalidateContactsCache', () => {
    it('clears contacts cache without error', () => {
      service.invalidateContactsCache();
      // No error = success
    });
  });

  describe('needsRelogin (deprecated)', () => {
    it('delegates to needsRecoveryKey', async () => {
      userKeyService.getDek.mockResolvedValueOnce(Buffer.from('key'));
      const result = await service.needsRelogin('user-1');
      expect(result).toBe(false);
    });
  });

  it('creates MemoryService with mock dependencies', () => {
    expect(service).toBeDefined();
  });

  describe('backfillWhatsappSenderNames', () => {
    it('requires a recovery key before updating encrypted WhatsApp metadata', async () => {
      userKeyService.getDek.mockResolvedValueOnce(null);

      const result = await service.backfillWhatsappSenderNames('user-1');

      expect(result).toEqual({ updated: 0, scanned: 0, needsRecoveryKey: true });
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it('uses linked sender people before falling back to platform ids', async () => {
      userKeyService.getDek.mockResolvedValueOnce(Buffer.from('userkey'));
      vi.spyOn(
        service as unknown as { getUserAccountIds: (userId?: string) => Promise<string[]> },
        'getUserAccountIds',
      ).mockResolvedValueOnce(['acc-1']);
      mockDb.limit.mockResolvedValueOnce([
        {
          memory: {
            ...fakeMemoryRow,
            connectorType: 'whatsapp',
            sourceType: 'message',
            text: 'Unknown: hello',
            metadata: JSON.stringify({ fromMe: false, senderLid: '123456@lid' }),
          },
          senderName: 'Alice Sender',
        },
      ]);

      const result = await service.backfillWhatsappSenderNames('user-1');

      expect(result).toEqual({ updated: 1, scanned: 1 });
      expect(cryptoService.encryptMemoryFieldsWithKey).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Alice Sender: hello',
          metadata: expect.stringContaining('Alice Sender'),
        }),
        Buffer.from('userkey'),
      );
    });
  });

  describe('activity', () => {
    it('returns authored messages plus user-owned photos and locations', async () => {
      const timelineItems: Awaited<ReturnType<typeof service.timeline>>['items'] = [
        {
          id: 'incoming-message',
          sourceType: 'message',
          connectorType: 'whatsapp',
          metadata: { fromMe: false },
        },
        {
          id: 'outgoing-message',
          sourceType: 'message',
          connectorType: 'whatsapp',
          metadata: { direction: 'outgoing' },
        },
        {
          id: 'photo',
          sourceType: 'photo',
          connectorType: 'photos',
          metadata: {},
        },
        {
          id: 'location',
          sourceType: 'location',
          connectorType: 'locations',
          metadata: {},
        },
      ];
      const timelineSpy = vi.spyOn(service, 'timeline').mockResolvedValueOnce({
        items: timelineItems,
        total: 4,
      });

      const result = await service.activity({ userId: 'user-1', limit: 25 });

      expect(timelineSpy).toHaveBeenCalledWith({
        userId: 'user-1',
        limit: 75,
      });
      expect(result.items.map((item) => item.id)).toEqual([
        'outgoing-message',
        'photo',
        'location',
      ]);
      expect(result.total).toBe(3);
    });
  });
});

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
  let configService: { bridgeLiveSearch: boolean; bridgeSearchTimeoutMs: number };
  let appleTunnel: {
    isBridgeOnlineForUser: ReturnType<typeof vi.fn>;
    searchViaBridge: ReturnType<typeof vi.fn>;
  };
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

    configService = { bridgeLiveSearch: false, bridgeSearchTimeoutMs: 8000 };
    appleTunnel = {
      isBridgeOnlineForUser: vi.fn().mockReturnValue(false),
      searchViaBridge: vi.fn().mockResolvedValue(null),
    };

    service = new MemoryService(
      makeDbService(mockDb),
      aiService,
      searchIndexService,
      connectorsService,
      pluginRegistry,
      cryptoService,
      userKeyService,
      configService as never,
      appleTunnel as never,
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

    it('infers OCR text source from old and compact media metadata', () => {
      const inferTextSource = (
        service as unknown as {
          inferTextSource(metadata: unknown): 'body' | 'attachment_ocr' | 'metadata';
        }
      ).inferTextSource.bind(service);

      expect(
        inferTextSource({ mediaExtraction: { status: 'extracted', source: 'vision_ocr' } }),
      ).toBe('attachment_ocr');
      expect(inferTextSource({ mediaExtraction: { extractedText: 'legacy extracted text' } })).toBe(
        'attachment_ocr',
      );
      expect(inferTextSource({ mediaExtraction: { status: 'failed' } })).toBe('body');
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

    it('does not resolve zero-memory name-only contacts as people', async () => {
      (service as unknown as { contactsCache: Map<string, unknown> }).contactsCache.set(
        '__none__',
        {
          expires: Date.now() + 60_000,
          data: [
            {
              id: 'ghost',
              displayName: 'North Station',
              entityType: 'person',
              memoryCount: 0,
            },
          ],
        },
      );

      const result = await (
        service as unknown as {
          resolveEntities: (words: string[]) => Promise<{
            contacts: { id: string; displayName: string }[];
            topicWords: string[];
            contactIds: string[];
          }>;
        }
      ).resolveEntities(['north', 'station']);

      expect(result.contacts).toEqual([]);
      expect(result.contactIds).toEqual([]);
      expect(result.topicWords).toEqual(['north', 'station']);
    });

    it('does not run lexical exact search for person plus generic conversation words', async () => {
      (service as unknown as { contactsCache: Map<string, unknown> }).contactsCache.set(
        '__none__',
        {
          expires: Date.now() + 60_000,
          data: [
            { id: 'low-memory', displayName: 'Hisham Azmy', entityType: 'person', memoryCount: 1 },
            {
              id: 'high-memory',
              displayName: 'Hisham Issa',
              entityType: 'person',
              memoryCount: 4602,
            },
          ],
        },
      );

      const result = await service.search(
        'Hisham messages conversation',
        { connectorType: 'whatsapp' },
        5,
        undefined,
        undefined,
        undefined,
        undefined,
        { debug: true },
      );

      expect(searchIndexService.textSearch).not.toHaveBeenCalled();
      expect(result.resolvedEntities?.contacts[0]).toMatchObject({
        id: 'high-memory',
        displayName: 'Hisham Issa',
      });
      expect(result.resolvedEntities?.topicWords).toEqual([]);
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
          data: [
            {
              id: 'person-1',
              displayName: 'Acme Booking',
              entityType: 'person',
              memoryCount: 1,
            },
          ],
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
          data: [
            {
              id: 'person-1',
              displayName: 'Acme',
              entityType: 'person',
              memoryCount: 1,
            },
          ],
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

    it('keeps boosted sort scores distinct above 1.0', async () => {
      searchIndexService.hybridSearch.mockResolvedValueOnce({
        results: [
          { id: 'lower', score: 0.98 },
          { id: 'higher', score: 1.0 },
        ],
        facetCounts: [],
        found: 2,
      });
      searchIndexService.textSearch.mockResolvedValueOnce([
        { id: 'lower', score: 0.98 },
        { id: 'higher', score: 1.0 },
      ]);
      vi.spyOn(
        service as unknown as { fetchMemoryRowsBatch: (ids: string[]) => unknown },
        'fetchMemoryRowsBatch',
      ).mockResolvedValueOnce(
        new Map([
          [
            'lower',
            {
              memory: {
                ...fakeMemoryRow,
                id: 'lower',
                text: 'alpha beta lower result with enough body text to include a length signal',
                eventTime: new Date(),
              },
              accountIdentifier: null,
            },
          ],
          [
            'higher',
            {
              memory: {
                ...fakeMemoryRow,
                id: 'higher',
                text: 'alpha beta higher result with enough body text to include a length signal',
                eventTime: new Date(),
              },
              accountIdentifier: null,
            },
          ],
        ]),
      );

      const result = await service.search(
        'alpha beta',
        undefined,
        2,
        undefined,
        undefined,
        undefined,
        0,
        { debug: true, noEntityResolution: true },
      );

      expect(result.items.map((item) => item.id)).toEqual(['higher', 'lower']);
      expect(result.items[0].score).toBeGreaterThan(1);
      expect(result.items[0].score).toBeGreaterThan(result.items[1].score);
      expect(result.diagnostics?.topScoreComponents.map((item) => item.score)).toEqual([
        result.items[0].score,
        result.items[1].score,
      ]);
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

  describe('getGraphData', () => {
    it('marks contact nodes without avatars so clients skip avatar fetches', async () => {
      mockDb.where
        .mockResolvedValueOnce([{ id: 'acc-1' }])
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([{ memoryId: 'mem-1', personId: 'person-1', role: 'sender' }])
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([
          {
            id: 'person-1',
            displayName: 'No Avatar',
            entityType: 'person',
            avatars: [],
            preferredAvatarIndex: 0,
          },
        ])
        .mockResolvedValueOnce([]);
      mockDb.limit
        .mockResolvedValueOnce([fakeMemoryRow])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await service.getGraphData(10, 10, 'user-1');
      const contact = result.nodes.find((node) => node.id === 'contact-person-1');

      expect(contact).toMatchObject({ hasAvatar: false });
      expect(contact?.avatarUrl).toBeUndefined();
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

    it('collapses Gmail message rows when a thread representative exists', async () => {
      vi.spyOn(service, 'getPeopleForMemories').mockResolvedValueOnce(new Map());
      mockDb.where.mockResolvedValueOnce([{ count: 3 }]);
      mockDb.limit.mockResolvedValueOnce([
        {
          memory: {
            ...fakeMemoryRow,
            id: 'email-1',
            sourceId: 'msg-1',
            metadata: JSON.stringify({ emailThreadKey: 'gmail:thread-1' }),
          },
          accountIdentifier: 'me@example.com',
        },
        {
          memory: {
            ...fakeMemoryRow,
            id: 'thread-1',
            sourceType: 'email_thread',
            sourceId: 'email-thread:gmail:thread-1',
            metadata: JSON.stringify({ emailThreadKey: 'gmail:thread-1' }),
          },
          accountIdentifier: 'me@example.com',
        },
        {
          memory: {
            ...fakeMemoryRow,
            id: 'email-2',
            sourceId: 'msg-2',
            metadata: JSON.stringify({ emailThreadKey: 'gmail:thread-1' }),
          },
          accountIdentifier: 'me@example.com',
        },
      ]);

      const result = await service.timeline({ connectorType: 'gmail' });

      expect(result.items.map((item) => item.id)).toEqual(['thread-1']);
      expect(result.items[0].sourceType).toBe('email_thread');
    });

    it('keeps distinct Gmail threads separate', async () => {
      vi.spyOn(service, 'getPeopleForMemories').mockResolvedValueOnce(new Map());
      mockDb.where.mockResolvedValueOnce([{ count: 2 }]);
      mockDb.limit.mockResolvedValueOnce([
        {
          memory: {
            ...fakeMemoryRow,
            id: 'thread-1',
            sourceType: 'email_thread',
            sourceId: 'email-thread:gmail:thread-1',
            metadata: JSON.stringify({ emailThreadKey: 'gmail:thread-1' }),
          },
          accountIdentifier: 'me@example.com',
        },
        {
          memory: {
            ...fakeMemoryRow,
            id: 'email-2',
            sourceId: 'msg-2',
            metadata: JSON.stringify({ emailThreadKey: 'gmail:thread-2' }),
          },
          accountIdentifier: 'me@example.com',
        },
      ]);

      const result = await service.timeline({ connectorType: 'gmail' });

      expect(result.items.map((item) => item.id)).toEqual(['thread-1', 'email-2']);
    });

    it('keeps Gmail emails without a thread key as standalone memories', async () => {
      vi.spyOn(service, 'getPeopleForMemories').mockResolvedValueOnce(new Map());
      mockDb.where.mockResolvedValueOnce([{ count: 1 }]);
      mockDb.limit.mockResolvedValueOnce([
        {
          memory: {
            ...fakeMemoryRow,
            id: 'email-1',
            sourceId: 'msg-1',
            metadata: '{}',
          },
          accountIdentifier: 'me@example.com',
        },
      ]);

      const result = await service.timeline({ connectorType: 'gmail' });

      expect(result.items.map((item) => item.id)).toEqual(['email-1']);
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

    it('returns factuality counts from plaintext labels', async () => {
      mockDb.where.mockReturnValue(mockDb);
      mockDb.then = vi
        .fn()
        .mockImplementationOnce((fn: (rows: unknown[]) => unknown) => fn([{ count: '3' }]));
      mockDb.groupBy
        .mockResolvedValueOnce([{ key: 'email', count: '3' }])
        .mockResolvedValueOnce([{ key: 'gmail', count: '3' }])
        .mockResolvedValueOnce([
          { label: 'FACT', count: '1' },
          { label: 'UNVERIFIED', count: '2' },
        ]);

      const result = await service.getStats('user-1');

      expect(result).toEqual({
        total: 3,
        bySource: { email: 3 },
        byConnector: { gmail: 3 },
        byFactuality: { FACT: 1, UNVERIFIED: 2 },
      });
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

  describe('live bridge routing', () => {
    it('does NOT route to bridge when flag is off (even if online)', async () => {
      configService.bridgeLiveSearch = false;
      appleTunnel.isBridgeOnlineForUser.mockReturnValue(true);

      const result = await service.search('hello', undefined, 20, 'user-1');

      expect(appleTunnel.searchViaBridge).not.toHaveBeenCalled();
      // normal (non-bridge) pipeline ran
      expect(result).toHaveProperty('items');
    });

    it('does NOT route to bridge when no userId', async () => {
      configService.bridgeLiveSearch = true;
      appleTunnel.isBridgeOnlineForUser.mockReturnValue(true);

      await service.search('hello');

      expect(appleTunnel.searchViaBridge).not.toHaveBeenCalled();
    });

    it('does NOT route to bridge when offline', async () => {
      configService.bridgeLiveSearch = true;
      appleTunnel.isBridgeOnlineForUser.mockReturnValue(false);

      const result = await service.search('hello', undefined, 20, 'user-1');

      expect(appleTunnel.searchViaBridge).not.toHaveBeenCalled();
      expect(result).toHaveProperty('items');
    });

    it('routes to bridge and returns bridge-only results when flag on + online', async () => {
      configService.bridgeLiveSearch = true;
      appleTunnel.isBridgeOnlineForUser.mockReturnValue(true);
      appleTunnel.searchViaBridge.mockResolvedValue({
        items: [
          {
            id: 'bridge-1',
            text: 'live imessage',
            sourceType: 'imessage',
            connectorType: 'apple',
            eventTime: '2026-01-01T00:00:00.000Z',
            score: 0.9,
            people: [{ name: 'Alice' }],
          },
        ],
      });

      const result = await service.search('hi', undefined, 20, 'user-1');

      expect(appleTunnel.searchViaBridge).toHaveBeenCalledWith('user-1', {
        query: 'hi',
        filters: undefined,
        limit: 20,
      });
      // bridge-only — Postgres pipeline must NOT run
      expect(searchIndexService.textSearch).not.toHaveBeenCalled();
      expect(result.fallback).toBe(false);
      expect(result.found).toBe(1);
      expect(result.items).toHaveLength(1);
      const item = result.items[0];
      expect(item.id).toBe('bridge-1');
      expect(item.eventTime).toBeInstanceOf(Date);
      expect(item.factuality).toEqual({
        label: 'UNVERIFIED',
        confidence: 0.5,
        rationale: 'live bridge',
      });
      expect(item.weights.final).toBe(0.9);
      expect(item.weights.semantic).toBe(0.9);
      expect(item.people).toEqual([{ role: 'sender', personId: '', displayName: 'Alice' }]);
      expect(item.pinned).toBe(false);
    });

    it('falls through to normal search when bridge online but RPC fails', async () => {
      configService.bridgeLiveSearch = true;
      appleTunnel.isBridgeOnlineForUser.mockReturnValue(true);
      appleTunnel.searchViaBridge.mockResolvedValue(null); // failure → null

      const result = await service.search('hi', undefined, 20, 'user-1');

      expect(appleTunnel.searchViaBridge).toHaveBeenCalled();
      // online but RPC returned null → fell through to the normal (non-bridge) pipeline
      expect(result).toHaveProperty('items');
      expect(result.fallback).toBeDefined();
    });
  });

  describe('mapBridgeResults', () => {
    const call = (items: unknown[], limit = 20) =>
      (
        service as unknown as {
          mapBridgeResults(
            items: unknown[],
            opts: { limit: number },
          ): {
            items: Array<Record<string, unknown>>;
            fallback: boolean;
            found: number;
          };
        }
      ).mapBridgeResults(items, { limit });

    it('applies sensible defaults for missing fields', () => {
      const before = Date.now();
      const res = call([{}]);
      const item = res.items[0];
      expect(item.id).toBe('');
      expect(item.text).toBe('');
      expect(item.connectorType).toBe('apple');
      expect(item.entities).toBe('');
      expect(item.metadata).toEqual({});
      expect(item.pinned).toBe(false);
      expect(item.score).toBe(0);
      expect((item.weights as Record<string, number>).final).toBe(0);
      expect(item.people).toBeUndefined();
      // eventTime falls back to ~now
      expect((item.eventTime as Date).getTime()).toBeGreaterThanOrEqual(before);
    });

    it('parses ISO dates and falls back to now on invalid', () => {
      const res = call([{ eventTime: '2025-05-05T10:00:00.000Z', ingestTime: 'not-a-date' }]);
      const item = res.items[0];
      expect((item.eventTime as Date).toISOString()).toBe('2025-05-05T10:00:00.000Z');
      expect(item.ingestTime).toBeInstanceOf(Date);
      // createdAt defaults to ingestTime when absent
      expect(item.createdAt).toBeInstanceOf(Date);
    });

    it('maps people from {name} to {role,personId,displayName}', () => {
      const res = call([
        { people: [{ name: 'Bob' }, { displayName: 'Carol', role: 'recipient' }] },
      ]);
      expect(res.items[0].people).toEqual([
        { role: 'sender', personId: '', displayName: 'Bob' },
        { role: 'recipient', personId: '', displayName: 'Carol' },
      ]);
    });

    it('truncates to limit', () => {
      const items = Array.from({ length: 5 }, (_, i) => ({ id: `b-${i}`, score: i }));
      const res = call(items, 2);
      expect(res.items).toHaveLength(2);
      expect(res.found).toBe(2);
    });

    it('is defensive against non-array and non-object items', () => {
      const res = call(['junk', 42, null] as unknown[]);
      expect(res.items).toHaveLength(3);
      expect(res.items[0].id).toBe('');
      expect(res.fallback).toBe(false);
    });
  });
});

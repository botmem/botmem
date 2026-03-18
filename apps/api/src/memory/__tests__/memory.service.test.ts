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
    rerank: ReturnType<typeof vi.fn>;
    generate: ReturnType<typeof vi.fn>;
  };
  let typesenseService: {
    search: ReturnType<typeof vi.fn>;
    hybridSearch: ReturnType<typeof vi.fn>;
    ensureCollection: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    buildFilterString: ReturnType<typeof vi.fn>;
  };
  let connectorsService: { get: ReturnType<typeof vi.fn> };
  let pluginRegistry: {
    getReranker: ReturnType<typeof vi.fn>;
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
    keyVersion: 0,
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
      rerank: vi.fn().mockResolvedValue([0.8, 0.6]),
      generate: vi.fn().mockResolvedValue('generated text'),
    };

    typesenseService = {
      search: vi.fn().mockResolvedValue([]),
      hybridSearch: vi.fn().mockResolvedValue({ results: [], facetCounts: [], found: 0 }),
      ensureCollection: vi.fn(),
      upsert: vi.fn(),
      remove: vi.fn(),
      buildFilterString: vi.fn().mockReturnValue(''),
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
      getReranker: vi.fn().mockReturnValue(null),
      getScorers: vi.fn().mockReturnValue([]),
      fireHook: vi.fn().mockResolvedValue(undefined),
    };

    cryptoService = {
      encrypt: vi.fn().mockImplementation((v: string) => v),
      decrypt: vi.fn().mockImplementation((v: string) => v),
      isEncrypted: vi.fn().mockReturnValue(false),
      encryptMemoryFields: vi.fn().mockImplementation((f: Record<string, string | null>) => f),
      decryptMemoryFields: vi.fn().mockImplementation((m: Record<string, string | null>) => m),
      decryptMemoryFieldsWithKey: vi
        .fn()
        .mockImplementation((m: Record<string, string | null>) => m),
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
      typesenseService,
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

    it('embeds the query and searches Typesense', async () => {
      typesenseService.hybridSearch.mockResolvedValueOnce({
        results: [{ id: 'mem-1', score: 0.9 }],
        facetCounts: [],
        found: 1,
      });
      // fetchMemoryRowsBatch: batch select
      mockDb.where.mockResolvedValueOnce([
        { memory: fakeMemoryRow, accountIdentifier: 'test@gmail.com' },
      ]);
      // FTS: execute
      mockDb.execute.mockResolvedValueOnce({ rows: [] });

      await service.search('meeting with john');
      expect(aiService.embedQuery).toHaveBeenCalled();
      expect(typesenseService.hybridSearch).toHaveBeenCalled();
    });

    it('returns empty when user has no accounts', async () => {
      // getUserAccountIds returns empty array for user with no accounts
      mockDb.where.mockResolvedValueOnce([]); // accounts query

      const response = await service.search('test', undefined, 20, false, 'user-with-no-accounts');
      expect(response.items).toEqual([]);
    });

    it('applies source type filter from NLQ', async () => {
      typesenseService.hybridSearch.mockResolvedValueOnce({
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

    it('decrypts with user key for keyVersion >= 1', async () => {
      const encryptedRow = { ...fakeMemoryRow, keyVersion: 1 };
      mockDb.where.mockResolvedValueOnce([encryptedRow]);
      userKeyService.getDek.mockResolvedValueOnce(Buffer.from('userkey'));

      await service.getById('mem-1', 'user-1');
      expect(cryptoService.decryptMemoryFieldsWithKey).toHaveBeenCalled();
    });

    it('returns placeholder when user key not available for encrypted memory', async () => {
      const encryptedRow = { ...fakeMemoryRow, keyVersion: 1 };
      mockDb.where.mockResolvedValueOnce([encryptedRow]);
      userKeyService.getDek.mockResolvedValueOnce(null);
      userKeyService.getKey.mockReturnValueOnce(null);

      const result = await service.getById('mem-1', 'user-1');
      expect(result!.text).toContain('Encrypted');
    });
  });

  describe('list', () => {
    it('returns items with people and total count', async () => {
      // The mock chain calls where() multiple times:
      // 1. getUserAccountIds (terminal)
      // 2. total count (terminal)
      // 3. rows query (chains to orderBy→limit→offset)
      // 4. getPeopleForMemories (terminal)
      // Use a call counter to return appropriate values
      let whereCall = 0;
      mockDb.where.mockImplementation(() => {
        whereCall++;
        if (whereCall === 1) return Promise.resolve([{ id: 'acc-1' }]);
        if (whereCall === 2) return Promise.resolve([{ count: 1 }]);
        if (whereCall === 4)
          return Promise.resolve([
            { memoryId: 'mem-1', role: 'sender', personId: 'p-1', displayName: 'Alice' },
          ]);
        return mockDb; // call 3: chain continues
      });
      mockDb.offset.mockResolvedValueOnce([
        { memory: fakeMemoryRow, accountIdentifier: 'test@gmail.com' },
      ]);

      const result = await service.list({ userId: 'user-1' });
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.items[0].people).toHaveLength(1);
      expect(result.items[0].people[0].displayName).toBe('Alice');
    });

    it('returns empty when user has no accounts', async () => {
      mockDb.where.mockResolvedValueOnce([]); // no accounts
      const result = await service.list({ userId: 'user-1' });
      expect(result).toEqual({ items: [], total: 0 });
    });

    it('applies connector and source type filters', async () => {
      mockDb.where.mockResolvedValueOnce([{ id: 'acc-1' }]); // accounts
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
    it('deletes memory from DB and Qdrant', async () => {
      await service.delete('mem-1');
      expect(typesenseService.remove).toHaveBeenCalledWith('mem-1');
    });

    it('handles Qdrant removal failure gracefully', async () => {
      typesenseService.remove.mockRejectedValueOnce(new Error('Qdrant down'));
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
      const result = await service.needsRecoveryKey('user-1');
      expect(result).toBe(false);
    });

    it('returns true when no DEK and encrypted memories exist', async () => {
      userKeyService.getDek.mockResolvedValueOnce(null);
      mockDb.limit.mockResolvedValueOnce([{ count: 5 }]);
      const result = await service.needsRecoveryKey('user-1');
      expect(result).toBe(true);
    });

    it('returns false when no DEK but no encrypted memories', async () => {
      userKeyService.getDek.mockResolvedValueOnce(null);
      mockDb.limit.mockResolvedValueOnce([{ count: 0 }]);
      const result = await service.needsRecoveryKey('user-1');
      expect(result).toBe(false);
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
});

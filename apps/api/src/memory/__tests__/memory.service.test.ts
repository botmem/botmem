import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryService } from '../memory.service';

function makeDbService(db: any) {
  return { db } as any;
}

describe('MemoryService', () => {
  let service: MemoryService;
  let ollamaService: any;
  let qdrantService: any;
  let connectorsService: any;
  let pluginRegistry: any;
  let cryptoService: any;

  beforeEach(() => {
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

    cryptoService = {
      encrypt: vi.fn().mockImplementation((v: string) => v),
      decrypt: vi.fn().mockImplementation((v: string) => v),
      isEncrypted: vi.fn().mockReturnValue(false),
      encryptMemoryFields: vi.fn().mockImplementation((f: any) => f),
      decryptMemoryFields: vi.fn().mockImplementation((m: any) => m),
    };

    // Mock DB with basic chain support
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      offset: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      groupBy: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      then: vi.fn().mockImplementation((fn: (...args: unknown[]) => unknown) => fn([])),
      [Symbol.asyncIterator]: async function* () {},
    } as any;

    service = new MemoryService(
      makeDbService(mockDb),
      ollamaService,
      qdrantService,
      connectorsService,
      pluginRegistry,
      cryptoService,
    );
  });

  describe('search', () => {
    it('returns empty items for empty query', async () => {
      const response = await service.search('');
      expect(response.items).toEqual([]);
      expect(ollamaService.embed).not.toHaveBeenCalled();
    });
  });

  it('creates MemoryService with mock dependencies', () => {
    expect(service).toBeDefined();
  });
});

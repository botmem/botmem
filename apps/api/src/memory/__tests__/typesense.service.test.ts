import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TypesenseService } from '../typesense.service';
import { ConfigService } from '../../config/config.service';

function createMockConfig(overrides: Partial<ConfigService> = {}): ConfigService {
  return {
    typesenseUrl: 'http://localhost:8108',
    typesenseApiKey: 'test-key',
    embedDimension: 1024,
    ...overrides,
  } as ConfigService;
}

/**
 * Build a chainable mock that mirrors the Typesense SDK client shape:
 *   client.collections(name).retrieve()
 *   client.collections(name).documents().upsert(doc)
 *   client.collections(name).documents(id).retrieve()
 *   client.collections(name).documents(id).delete()
 *   client.collections().create(schema)
 *   client.collections(name).synonyms().upsert(id, body)
 *   client.multiSearch.perform(params, {})
 *   client.health.retrieve()
 *   client.stopwords().upsert(id, body)
 */
function buildMockClient() {
  const mocks = {
    // collections(name).retrieve()
    collectionRetrieve: vi.fn(),
    // collections().create(schema)
    collectionsCreate: vi.fn(),
    // collections(name).documents().upsert(doc)
    documentsUpsert: vi.fn(),
    // collections(name).documents(id).retrieve()
    documentRetrieve: vi.fn(),
    // collections(name).documents(id).delete()
    documentDelete: vi.fn(),
    // collections(name).synonyms().upsert(id, body)
    synonymsUpsert: vi.fn(),
    // client.multiSearch.perform(params, {})
    multiSearchPerform: vi.fn(),
    // client.health.retrieve()
    healthRetrieve: vi.fn(),
    // client.stopwords().upsert(id, body)
    stopwordsUpsert: vi.fn(),
  };

  const client = {
    collections: vi.fn((name?: string) => {
      if (!name) {
        return { create: mocks.collectionsCreate };
      }
      return {
        retrieve: mocks.collectionRetrieve,
        documents: vi.fn((id?: string) => {
          if (!id) {
            return { upsert: mocks.documentsUpsert };
          }
          return {
            retrieve: mocks.documentRetrieve,
            delete: mocks.documentDelete,
          };
        }),
        synonyms: vi.fn(() => ({ upsert: mocks.synonymsUpsert })),
      };
    }),
    multiSearch: { perform: mocks.multiSearchPerform },
    health: { retrieve: mocks.healthRetrieve },
    stopwords: vi.fn(() => ({ upsert: mocks.stopwordsUpsert })),
  };

  return { client, mocks };
}

describe('TypesenseService', () => {
  let service: TypesenseService;
  let mocks: ReturnType<typeof buildMockClient>['mocks'];

  beforeEach(() => {
    const config = createMockConfig();
    service = new TypesenseService(config);
    const built = buildMockClient();
    mocks = built.mocks;
    (service as unknown as { client: typeof built.client }).client = built.client;
  });

  describe('ensureCollection', () => {
    it('does nothing if collection already exists with correct dimensions', async () => {
      mocks.collectionRetrieve.mockResolvedValue({
        fields: [{ name: 'embedding', num_dim: 1024 }],
      });

      await service.ensureCollection(1024);

      expect(mocks.collectionsCreate).not.toHaveBeenCalled();
    });

    it('creates collection if retrieve returns 404', async () => {
      mocks.collectionRetrieve.mockRejectedValue({ httpStatus: 404 });
      mocks.collectionsCreate.mockResolvedValue({});

      await service.ensureCollection(1024);

      expect(mocks.collectionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'memories' }),
      );
    });

    it('creates collection on "Not Found" error message', async () => {
      mocks.collectionRetrieve.mockRejectedValue(new Error('Not Found'));
      mocks.collectionsCreate.mockResolvedValue({});

      await service.ensureCollection(1024);

      expect(mocks.collectionsCreate).toHaveBeenCalled();
    });

    it('throws if vector dimension mismatch', async () => {
      mocks.collectionRetrieve.mockResolvedValue({
        fields: [{ name: 'embedding', num_dim: 768 }],
      });

      await expect(service.ensureCollection(1024)).rejects.toThrow(
        /vector dimension 768.*EMBED_DIMENSION is 1024/,
      );
    });

    it('skips dimension check when no embedding field found', async () => {
      mocks.collectionRetrieve.mockResolvedValue({
        fields: [{ name: 'text', type: 'string' }],
      });

      // Should not throw — no embedding field means no mismatch
      await service.ensureCollection(1024);
      expect(mocks.collectionsCreate).not.toHaveBeenCalled();
    });
  });

  describe('onModuleInit', () => {
    it('calls ensureCollection and seeding', async () => {
      mocks.collectionRetrieve.mockResolvedValue({
        fields: [{ name: 'embedding', num_dim: 1024 }],
      });
      // Seeding calls (best-effort)
      mocks.synonymsUpsert.mockResolvedValue({});
      mocks.stopwordsUpsert.mockResolvedValue({});
      // seedConversationModel tries to retrieve then create
      mocks.collectionRetrieve.mockResolvedValue({});

      await service.onModuleInit();

      expect(mocks.collectionRetrieve).toHaveBeenCalled();
    });

    it('handles init failure gracefully', async () => {
      const logSpy = vi
        .spyOn(
          (service as unknown as { logger: { error: ReturnType<typeof vi.fn> } }).logger,
          'error',
        )
        .mockImplementation(() => {});
      mocks.collectionRetrieve.mockRejectedValue(new Error('connection refused'));

      await service.onModuleInit();

      expect(logSpy).toHaveBeenCalled();
    });
  });

  describe('upsert', () => {
    it('upserts a document', async () => {
      mocks.documentsUpsert.mockResolvedValue({});

      await service.upsert('mem-1', [0.1, 0.2], { source_type: 'email' });

      expect(mocks.documentsUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'mem-1',
          embedding: [0.1, 0.2],
        }),
      );
    });

    it('retries on 404 and creates collection', async () => {
      mocks.documentsUpsert.mockRejectedValueOnce({ httpStatus: 404 }).mockResolvedValueOnce({});
      mocks.collectionRetrieve.mockRejectedValue({ httpStatus: 404 });
      mocks.collectionsCreate.mockResolvedValue({});

      await service.upsert('mem-1', [0.1], { x: 1 });

      expect(mocks.collectionsCreate).toHaveBeenCalled();
      expect(mocks.documentsUpsert).toHaveBeenCalledTimes(2);
    });

    it('retries on "Not Found" error', async () => {
      mocks.documentsUpsert.mockRejectedValueOnce(new Error('Not Found')).mockResolvedValueOnce({});
      mocks.collectionRetrieve.mockRejectedValue(new Error('Not Found'));
      mocks.collectionsCreate.mockResolvedValue({});

      await service.upsert('mem-1', [0.1], {});

      expect(mocks.documentsUpsert).toHaveBeenCalledTimes(2);
    });

    it('throws after exhausting retries', async () => {
      mocks.documentsUpsert.mockRejectedValue(new Error('Server error'));

      await expect(service.upsert('mem-1', [0.1], {}, 0)).rejects.toThrow('Server error');
    });
  });

  describe('search', () => {
    it('searches with vector and returns scored results', async () => {
      mocks.multiSearchPerform.mockResolvedValue({
        results: [
          {
            hits: [
              { document: { id: 'mem-1', source_type: 'email' }, vector_distance: 0.05 },
              { document: { id: 'mem-2', source_type: 'message' }, vector_distance: 0.18 },
            ],
          },
        ],
      });

      const results = await service.search([0.1, 0.2], 10);

      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('mem-1');
      expect(results[0].score).toBeCloseTo(0.95);
    });

    it('returns empty array when no hits', async () => {
      mocks.multiSearchPerform.mockResolvedValue({
        results: [{ hits: [] }],
      });

      const results = await service.search([0.1], 5);
      expect(results).toEqual([]);
    });

    it('returns empty array and creates collection on 404', async () => {
      mocks.multiSearchPerform.mockRejectedValue({ httpStatus: 404 });
      mocks.collectionRetrieve.mockRejectedValue({ httpStatus: 404 });
      mocks.collectionsCreate.mockResolvedValue({});

      const results = await service.search([0.1], 5);

      expect(results).toEqual([]);
      expect(mocks.collectionsCreate).toHaveBeenCalled();
    });

    it('returns empty array on "Not Found" error', async () => {
      mocks.multiSearchPerform.mockRejectedValue(new Error('Not Found'));
      mocks.collectionRetrieve.mockRejectedValue(new Error('Not Found'));
      mocks.collectionsCreate.mockResolvedValue({});

      const results = await service.search([0.1], 5);
      expect(results).toEqual([]);
    });

    it('throws on non-collection errors', async () => {
      mocks.multiSearchPerform.mockRejectedValue(new Error('Internal server error'));

      await expect(service.search([0.1], 5)).rejects.toThrow('Internal server error');
    });

    it('handles null hits gracefully', async () => {
      mocks.multiSearchPerform.mockResolvedValue({
        results: [{}],
      });

      const results = await service.search([0.1], 5);
      expect(results).toEqual([]);
    });
  });

  describe('recommend', () => {
    it('returns recommendations for a memory', async () => {
      // First call: retrieve the source document's embedding
      mocks.documentRetrieve.mockResolvedValue({
        id: 'mem-1',
        embedding: [0.1, 0.2],
      });
      // Then multiSearch for similar
      mocks.multiSearchPerform.mockResolvedValue({
        results: [
          {
            hits: [{ document: { id: 'mem-2', source_type: 'email' }, vector_distance: 0.12 }],
          },
        ],
      });

      const results = await service.recommend('mem-1', 5);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('mem-2');
    });

    it('returns empty array when document has no embedding', async () => {
      mocks.documentRetrieve.mockResolvedValue({ id: 'mem-1' });

      const results = await service.recommend('mem-1', 5);
      expect(results).toEqual([]);
    });

    it('returns empty array on error', async () => {
      mocks.documentRetrieve.mockRejectedValue(new Error('fail'));

      const results = await service.recommend('mem-1', 5);
      expect(results).toEqual([]);
    });
  });

  describe('getCollectionInfo', () => {
    it('returns collection stats', async () => {
      mocks.collectionRetrieve.mockResolvedValue({
        num_documents: 100,
      });

      const info = await service.getCollectionInfo();

      expect(info.pointsCount).toBe(100);
      expect(info.indexedVectorsCount).toBe(100);
      expect(info.status).toBe('ready');
    });

    it('returns defaults on error', async () => {
      mocks.collectionRetrieve.mockRejectedValue(new Error('not found'));

      const info = await service.getCollectionInfo();

      expect(info.pointsCount).toBe(0);
      expect(info.status).toBe('not_found');
    });

    it('handles missing fields', async () => {
      mocks.collectionRetrieve.mockResolvedValue({});

      const info = await service.getCollectionInfo();

      expect(info.pointsCount).toBe(0);
      expect(info.indexedVectorsCount).toBe(0);
      expect(info.status).toBe('ready');
    });
  });

  describe('pointExists', () => {
    it('returns true when document found', async () => {
      mocks.documentRetrieve.mockResolvedValue({ id: 'mem-1' });

      expect(await service.pointExists('mem-1')).toBe(true);
    });

    it('returns false on error (not found)', async () => {
      mocks.documentRetrieve.mockRejectedValue({ httpStatus: 404 });

      expect(await service.pointExists('mem-1')).toBe(false);
    });

    it('returns false on other errors', async () => {
      mocks.documentRetrieve.mockRejectedValue(new Error('fail'));

      expect(await service.pointExists('mem-1')).toBe(false);
    });
  });

  describe('healthCheck', () => {
    it('returns true when typesense is accessible', async () => {
      mocks.healthRetrieve.mockResolvedValue({ ok: true });

      expect(await service.healthCheck()).toBe(true);
    });

    it('returns false when typesense is down', async () => {
      mocks.healthRetrieve.mockRejectedValue(new Error('connection refused'));

      expect(await service.healthCheck()).toBe(false);
    });
  });

  describe('remove', () => {
    it('deletes a document by id', async () => {
      mocks.documentDelete.mockResolvedValue({});

      await service.remove('mem-1');

      expect(mocks.documentDelete).toHaveBeenCalled();
    });

    it('ignores 404 error', async () => {
      mocks.documentDelete.mockRejectedValue({ httpStatus: 404 });

      await expect(service.remove('mem-1')).resolves.toBeUndefined();
    });

    it('ignores "Not Found" error', async () => {
      mocks.documentDelete.mockRejectedValue(new Error('Not Found'));

      await expect(service.remove('mem-1')).resolves.toBeUndefined();
    });

    it('throws on other errors', async () => {
      mocks.documentDelete.mockRejectedValue(new Error('Internal error'));

      await expect(service.remove('mem-1')).rejects.toThrow('Internal error');
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QdrantService } from '../qdrant.service';
import { ConfigService } from '../../config/config.service';

function createMockConfig(overrides: Partial<ConfigService> = {}): ConfigService {
  return {
    qdrantUrl: 'http://localhost:6333',
    embedDimension: 1024,
    ...overrides,
  } as ConfigService;
}

describe('QdrantService', () => {
  let service: QdrantService;
  let mockClient: any;

  beforeEach(() => {
    service = new QdrantService(createMockConfig());
    mockClient = {
      collectionExists: vi.fn(),
      createCollection: vi.fn(),
      updateCollection: vi.fn(),
      createPayloadIndex: vi.fn(),
      upsert: vi.fn(),
      search: vi.fn(),
      recommend: vi.fn(),
      delete: vi.fn(),
      getCollection: vi.fn(),
      retrieve: vi.fn(),
      setPayload: vi.fn(),
      getCollections: vi.fn(),
    };
    (service as any).client = mockClient;
  });

  describe('ensureCollection', () => {
    it('creates collection if it does not exist', async () => {
      mockClient.collectionExists.mockResolvedValue({ exists: false });
      mockClient.createCollection.mockResolvedValue(true);

      await service.ensureCollection(1024);

      expect(mockClient.createCollection).toHaveBeenCalledWith('memories', {
        vectors: { size: 1024, distance: 'Cosine' },
        optimizers_config: { indexing_threshold: 1000 },
      });
    });

    it('skips creation if collection already exists', async () => {
      mockClient.collectionExists.mockResolvedValue({ exists: true });

      await service.ensureCollection(1024);

      expect(mockClient.createCollection).not.toHaveBeenCalled();
    });
  });

  describe('ensureTemporalIndex', () => {
    it('creates event_time payload index', async () => {
      mockClient.createPayloadIndex.mockResolvedValue(undefined);

      await service.ensureTemporalIndex();

      expect(mockClient.createPayloadIndex).toHaveBeenCalledWith('memories', {
        field_name: 'event_time',
        field_schema: 'datetime',
      });
    });

    it('ignores 400 (already exists) error', async () => {
      mockClient.createPayloadIndex.mockRejectedValue({ status: 400 });

      await expect(service.ensureTemporalIndex()).resolves.toBeUndefined();
    });

    it('ignores "already exists" message error', async () => {
      mockClient.createPayloadIndex.mockRejectedValue({ message: 'index already exists' });

      await expect(service.ensureTemporalIndex()).resolves.toBeUndefined();
    });

    it('logs error for other failures', async () => {
      const logSpy = vi.spyOn((service as any).logger, 'error').mockImplementation(() => {});
      mockClient.createPayloadIndex.mockRejectedValue(new Error('connection refused'));

      await service.ensureTemporalIndex();

      expect(logSpy).toHaveBeenCalled();
    });
  });

  describe('ensureIndexed', () => {
    it('updates collection optimizers config', async () => {
      mockClient.updateCollection.mockResolvedValue(undefined);

      await service.ensureIndexed();

      expect(mockClient.updateCollection).toHaveBeenCalledWith('memories', {
        optimizers_config: { indexing_threshold: 1000 },
      });
    });

    it('ignores errors silently', async () => {
      mockClient.updateCollection.mockRejectedValue(new Error('not found'));

      await expect(service.ensureIndexed()).resolves.toBeUndefined();
    });
  });

  describe('onModuleInit', () => {
    it('calls ensureCollection, ensureIndexed, and ensureTemporalIndex', async () => {
      mockClient.collectionExists.mockResolvedValue({ exists: true });
      mockClient.updateCollection.mockResolvedValue(undefined);
      mockClient.createPayloadIndex.mockResolvedValue(undefined);

      await service.onModuleInit();

      expect(mockClient.collectionExists).toHaveBeenCalled();
      expect(mockClient.updateCollection).toHaveBeenCalled();
      expect(mockClient.createPayloadIndex).toHaveBeenCalled();
    });

    it('handles init failure gracefully', async () => {
      const logSpy = vi.spyOn((service as any).logger, 'error').mockImplementation(() => {});
      mockClient.collectionExists.mockRejectedValue(new Error('connection refused'));

      await service.onModuleInit();

      expect(logSpy).toHaveBeenCalled();
    });
  });

  describe('upsert', () => {
    it('upserts a vector with payload', async () => {
      mockClient.upsert.mockResolvedValue({});

      await service.upsert('mem-1', [0.1, 0.2], { source_type: 'email' });

      expect(mockClient.upsert).toHaveBeenCalledWith('memories', {
        points: [{
          id: 'mem-1',
          vector: [0.1, 0.2],
          payload: { source_type: 'email' },
        }],
      });
    });

    it('retries on "Not Found" and creates collection', async () => {
      mockClient.upsert
        .mockRejectedValueOnce(new Error('Not Found'))
        .mockResolvedValueOnce({});
      mockClient.collectionExists.mockResolvedValue({ exists: false });
      mockClient.createCollection.mockResolvedValue(true);

      await service.upsert('mem-1', [0.1], { x: 1 });

      expect(mockClient.collectionExists).toHaveBeenCalled();
      expect(mockClient.upsert).toHaveBeenCalledTimes(2);
    });

    it('retries on "doesn\'t exist" error', async () => {
      mockClient.upsert
        .mockRejectedValueOnce(new Error("Collection doesn't exist"))
        .mockResolvedValueOnce({});
      mockClient.collectionExists.mockResolvedValue({ exists: false });
      mockClient.createCollection.mockResolvedValue(true);

      await service.upsert('mem-1', [0.1], {});

      expect(mockClient.upsert).toHaveBeenCalledTimes(2);
    });

    it('throws after exhausting retries', async () => {
      mockClient.upsert.mockRejectedValue(new Error('Server error'));

      await expect(service.upsert('mem-1', [0.1], {}, 1)).rejects.toThrow('Server error');
      expect(mockClient.upsert).toHaveBeenCalledTimes(2); // initial + 1 retry
    });
  });

  describe('search', () => {
    it('searches with vector and returns scored results', async () => {
      mockClient.search.mockResolvedValue([
        { id: 'mem-1', score: 0.95, payload: { source_type: 'email' } },
        { id: 'mem-2', score: 0.82, payload: { source_type: 'message' } },
      ]);

      const results = await service.search([0.1, 0.2], 10);

      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('mem-1');
    });

    it('passes filters when provided', async () => {
      mockClient.search.mockResolvedValue([]);
      const filter = { must: [{ key: 'source_type', match: { value: 'email' } }] };

      await service.search([0.1], 5, filter);

      expect(mockClient.search).toHaveBeenCalledWith('memories', expect.objectContaining({ filter }));
    });

    it('returns empty array and creates collection on "Not Found"', async () => {
      mockClient.search.mockRejectedValue(new Error('Not Found'));
      mockClient.collectionExists.mockResolvedValue({ exists: false });
      mockClient.createCollection.mockResolvedValue(true);

      const results = await service.search([0.1], 5);

      expect(results).toEqual([]);
      expect(mockClient.collectionExists).toHaveBeenCalled();
    });

    it('handles null payload gracefully', async () => {
      mockClient.search.mockResolvedValue([
        { id: 'mem-1', score: 0.5, payload: null },
      ]);

      const results = await service.search([0.1], 5);
      expect(results[0].payload).toEqual({});
    });

    it('throws on non-collection errors', async () => {
      mockClient.search.mockRejectedValue(new Error('Internal server error'));

      await expect(service.search([0.1], 5)).rejects.toThrow('Internal server error');
    });
  });

  describe('recommend', () => {
    it('returns recommendations for a memory', async () => {
      mockClient.recommend.mockResolvedValue([
        { id: 'mem-2', score: 0.88, payload: { source_type: 'email' } },
      ]);

      const results = await service.recommend('mem-1', 5);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('mem-2');
    });

    it('passes filter when provided', async () => {
      mockClient.recommend.mockResolvedValue([]);
      const filter = { must: [{ key: 'source', match: { value: 'gmail' } }] };

      await service.recommend('mem-1', 5, filter);

      expect(mockClient.recommend).toHaveBeenCalledWith('memories', expect.objectContaining({ filter }));
    });

    it('returns empty array on error', async () => {
      mockClient.recommend.mockRejectedValue(new Error('fail'));

      const results = await service.recommend('mem-1', 5);
      expect(results).toEqual([]);
    });
  });

  describe('getCollectionInfo', () => {
    it('returns collection stats', async () => {
      mockClient.getCollection.mockResolvedValue({
        points_count: 100,
        indexed_vectors_count: 90,
        status: 'green',
      });

      const info = await service.getCollectionInfo();

      expect(info.pointsCount).toBe(100);
      expect(info.indexedVectorsCount).toBe(90);
      expect(info.status).toBe('green');
    });

    it('returns defaults on error', async () => {
      mockClient.getCollection.mockRejectedValue(new Error('not found'));

      const info = await service.getCollectionInfo();

      expect(info.pointsCount).toBe(0);
      expect(info.status).toBe('not_found');
    });

    it('handles missing fields', async () => {
      mockClient.getCollection.mockResolvedValue({});

      const info = await service.getCollectionInfo();

      expect(info.pointsCount).toBe(0);
      expect(info.indexedVectorsCount).toBe(0);
      expect(info.status).toBe('unknown');
    });
  });

  describe('pointExists', () => {
    it('returns true when point found', async () => {
      mockClient.retrieve.mockResolvedValue([{ id: 'mem-1' }]);

      expect(await service.pointExists('mem-1')).toBe(true);
    });

    it('returns false when point not found', async () => {
      mockClient.retrieve.mockResolvedValue([]);

      expect(await service.pointExists('mem-1')).toBe(false);
    });

    it('returns false on error', async () => {
      mockClient.retrieve.mockRejectedValue(new Error('fail'));

      expect(await service.pointExists('mem-1')).toBe(false);
    });
  });

  describe('setPayload', () => {
    it('calls client setPayload', async () => {
      mockClient.setPayload.mockResolvedValue(undefined);

      await service.setPayload({ key: 'value' }, { must: [] });

      expect(mockClient.setPayload).toHaveBeenCalledWith('memories', {
        payload: { key: 'value' },
        filter: { must: [] },
        wait: true,
      });
    });
  });

  describe('healthCheck', () => {
    it('returns true when qdrant is accessible', async () => {
      mockClient.getCollections.mockResolvedValue({ collections: [] });

      expect(await service.healthCheck()).toBe(true);
    });

    it('returns false when qdrant is down', async () => {
      mockClient.getCollections.mockRejectedValue(new Error('connection refused'));

      expect(await service.healthCheck()).toBe(false);
    });
  });

  describe('remove', () => {
    it('deletes a point by id', async () => {
      mockClient.delete.mockResolvedValue({});

      await service.remove('mem-1');

      expect(mockClient.delete).toHaveBeenCalledWith('memories', {
        points: ['mem-1'],
      });
    });

    it('ignores "Not Found" error', async () => {
      mockClient.delete.mockRejectedValue(new Error('Not Found'));

      await expect(service.remove('mem-1')).resolves.toBeUndefined();
    });

    it('ignores "doesn\'t exist" error', async () => {
      mockClient.delete.mockRejectedValue(new Error("Collection doesn't exist"));

      await expect(service.remove('mem-1')).resolves.toBeUndefined();
    });

    it('throws on other errors', async () => {
      mockClient.delete.mockRejectedValue(new Error('Internal error'));

      await expect(service.remove('mem-1')).rejects.toThrow('Internal error');
    });
  });
});

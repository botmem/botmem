import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QdrantService } from '../qdrant.service';
import { ConfigService } from '../../config/config.service';

function createMockConfig(): ConfigService {
  return { qdrantUrl: 'http://localhost:6333' } as ConfigService;
}

describe('QdrantService', () => {
  let service: QdrantService;
  let mockClient: any;

  beforeEach(() => {
    service = new QdrantService(createMockConfig());
    // Mock the internal client after construction
    mockClient = {
      collectionExists: vi.fn(),
      createCollection: vi.fn(),
      upsert: vi.fn(),
      search: vi.fn(),
      delete: vi.fn(),
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
      });
    });

    it('skips creation if collection already exists', async () => {
      mockClient.collectionExists.mockResolvedValue({ exists: true });

      await service.ensureCollection(1024);

      expect(mockClient.createCollection).not.toHaveBeenCalled();
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
  });

  describe('search', () => {
    it('searches with vector and returns scored results', async () => {
      mockClient.search.mockResolvedValue([
        { id: 'mem-1', score: 0.95, payload: { source_type: 'email' } },
        { id: 'mem-2', score: 0.82, payload: { source_type: 'message' } },
      ]);

      const results = await service.search([0.1, 0.2], 10);

      expect(mockClient.search).toHaveBeenCalledWith('memories', {
        vector: [0.1, 0.2],
        limit: 10,
        with_payload: true,
      });
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('mem-1');
      expect(results[0].score).toBe(0.95);
    });

    it('passes filters when provided', async () => {
      mockClient.search.mockResolvedValue([]);

      const filter = { must: [{ key: 'source_type', match: { value: 'email' } }] };
      await service.search([0.1], 5, filter);

      expect(mockClient.search).toHaveBeenCalledWith('memories', expect.objectContaining({
        filter,
      }));
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
  });
});

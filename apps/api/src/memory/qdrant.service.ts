import { Injectable, OnModuleInit } from '@nestjs/common';
import { QdrantClient } from '@qdrant/js-client-rest';
import { ConfigService } from '../config/config.service';

export interface ScoredPoint {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

@Injectable()
export class QdrantService implements OnModuleInit {
  private client: QdrantClient;
  private static readonly COLLECTION = 'memories';

  constructor(private config: ConfigService) {
    this.client = new QdrantClient({ url: config.qdrantUrl });
  }

  async onModuleInit() {
    // Collection will be created on first embedding when we know the vector size
  }

  async ensureCollection(vectorSize: number): Promise<void> {
    const { exists } = await this.client.collectionExists(QdrantService.COLLECTION);
    if (!exists) {
      await this.client.createCollection(QdrantService.COLLECTION, {
        vectors: { size: vectorSize, distance: 'Cosine' },
      });
    }
  }

  async upsert(memoryId: string, vector: number[], payload: Record<string, unknown>): Promise<void> {
    await this.client.upsert(QdrantService.COLLECTION, {
      points: [{
        id: memoryId,
        vector,
        payload,
      }],
    });
  }

  async search(vector: number[], limit: number, filter?: Record<string, unknown>): Promise<ScoredPoint[]> {
    const params: Record<string, unknown> = {
      vector,
      limit,
      with_payload: true,
    };
    if (filter) {
      params.filter = filter;
    }

    const results = await this.client.search(QdrantService.COLLECTION, params as any);
    return results.map((r: any) => ({
      id: r.id as string,
      score: r.score as number,
      payload: (r.payload || {}) as Record<string, unknown>,
    }));
  }

  async recommend(memoryId: string, limit: number, filter?: Record<string, unknown>): Promise<ScoredPoint[]> {
    try {
      const params: Record<string, unknown> = {
        positive: [memoryId],
        limit,
        with_payload: true,
      };
      if (filter) {
        params.filter = filter;
      }

      const results = await this.client.recommend(QdrantService.COLLECTION, params as any);
      return results.map((r: any) => ({
        id: r.id as string,
        score: r.score as number,
        payload: (r.payload || {}) as Record<string, unknown>,
      }));
    } catch {
      return [];
    }
  }

  async remove(memoryId: string): Promise<void> {
    await this.client.delete(QdrantService.COLLECTION, {
      points: [memoryId],
    });
  }
}

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
    // Ensure the collection exists at startup with the known embed dimension.
    // nomic-embed-text produces 768-dim vectors; this avoids a chicken-and-egg
    // problem where the first embed failure prevents the collection from being created.
    try {
      await this.ensureCollection(768);
      // Ensure HNSW index is built even for small collections
      await this.ensureIndexed();
      // Create datetime payload index on event_time for temporal filtering
      await this.ensureTemporalIndex();
    } catch (err) {
      console.error('Qdrant collection init failed (will retry on first embed):', err);
    }
  }

  async ensureCollection(vectorSize: number): Promise<void> {
    const { exists } = await this.client.collectionExists(QdrantService.COLLECTION);
    if (!exists) {
      await this.client.createCollection(QdrantService.COLLECTION, {
        vectors: { size: vectorSize, distance: 'Cosine' },
        optimizers_config: { indexing_threshold: 1000 },
      });
    }
  }

  /** Create datetime payload index on event_time for efficient temporal range queries */
  async ensureTemporalIndex(): Promise<void> {
    try {
      await this.client.createPayloadIndex(QdrantService.COLLECTION, {
        field_name: 'event_time',
        field_schema: 'datetime',
      });
    } catch (err: any) {
      // 400 = index already exists, safe to ignore
      if (err?.status !== 400 && !err?.message?.includes('already exists')) {
        console.error('Failed to create event_time payload index:', err);
      }
    }
  }

  /** Update indexing threshold on existing collection to trigger HNSW index build */
  async ensureIndexed(): Promise<void> {
    try {
      await this.client.updateCollection(QdrantService.COLLECTION, {
        optimizers_config: { indexing_threshold: 1000 },
      });
    } catch {
      // Collection may not exist yet
    }
  }

  async upsert(memoryId: string, vector: number[], payload: Record<string, unknown>, retries = 2): Promise<void> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.client.upsert(QdrantService.COLLECTION, {
          points: [{
            id: memoryId,
            vector,
            payload,
          }],
        });
        return;
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (msg.includes('Not Found') || msg.includes("doesn't exist")) {
          await this.ensureCollection(vector.length);
          continue;
        }
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
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

    try {
      const results = await this.client.search(QdrantService.COLLECTION, params as any);
      return results.map((r: any) => ({
        id: r.id as string,
        score: r.score as number,
        payload: (r.payload || {}) as Record<string, unknown>,
      }));
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (msg.includes('Not Found') || msg.includes("doesn't exist")) {
        await this.ensureCollection(vector.length);
        return [];
      }
      throw err;
    }
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

  async getCollectionInfo(): Promise<{ pointsCount: number; indexedVectorsCount: number; status: string }> {
    try {
      const info = await this.client.getCollection(QdrantService.COLLECTION);
      return {
        pointsCount: (info as any).points_count ?? 0,
        indexedVectorsCount: (info as any).indexed_vectors_count ?? 0,
        status: (info as any).status ?? 'unknown',
      };
    } catch {
      return { pointsCount: 0, indexedVectorsCount: 0, status: 'not_found' };
    }
  }

  async pointExists(id: string): Promise<boolean> {
    try {
      const result = await this.client.retrieve(QdrantService.COLLECTION, { ids: [id], with_payload: false, with_vector: false });
      return result.length > 0;
    } catch {
      return false;
    }
  }

  async setPayload(
    payload: Record<string, unknown>,
    filter: Record<string, unknown>,
  ): Promise<void> {
    await this.client.setPayload(QdrantService.COLLECTION, {
      payload,
      filter,
      wait: true,
    });
  }

  async remove(memoryId: string): Promise<void> {
    try {
      await this.client.delete(QdrantService.COLLECTION, {
        points: [memoryId],
      });
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (msg.includes('Not Found') || msg.includes("doesn't exist")) return;
      throw err;
    }
  }
}

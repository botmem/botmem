import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { eq, and } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { AiService } from './ai.service';
import { QdrantService } from './qdrant.service';
import { LogsService } from '../logs/logs.service';
import { EventsService } from '../events/events.service';
import { memories, memoryLinks } from '../db/schema';
import { entityExtractionPrompt, factualityPrompt, ENTITY_FORMAT_SCHEMA } from './prompts';
import { ConnectorsService } from '../connectors/connectors.service';
import { normalizeEntities } from './entity-normalizer';

const SIMILARITY_THRESHOLD = 0.8;
const SIMILAR_MEMORY_LIMIT = 5;

@Injectable()
export class EnrichService {
  constructor(
    private dbService: DbService,
    private ai: AiService,
    private qdrant: QdrantService,
    private logsService: LogsService,
    private events: EventsService,
    private connectors: ConnectorsService,
  ) {}

  private getTrustScore(connectorType: string): number {
    try {
      return this.connectors.get(connectorType).manifest.trustScore;
    } catch {
      return 0.7;
    }
  }

  private getWeights(connectorType: string): {
    semantic: number;
    recency: number;
    importance: number;
    trust: number;
  } {
    const defaults = { semantic: 0.4, recency: 0.25, importance: 0.2, trust: 0.15 };
    try {
      const w = this.connectors.get(connectorType).manifest.weights;
      return {
        semantic: w?.semantic ?? defaults.semantic,
        recency: w?.recency ?? defaults.recency,
        importance: w?.importance ?? defaults.importance,
        trust: w?.trust ?? defaults.trust,
      };
    } catch {
      return defaults;
    }
  }

  async enrich(memoryId: string): Promise<void> {
    const rows = await this.dbService.db.select().from(memories).where(eq(memories.id, memoryId));

    if (!rows.length) return;
    const memory = rows[0];
    const mid = memoryId.slice(0, 8);
    const pipelineStart = Date.now();

    this.addLog(
      memory.connectorType,
      memory.accountId,
      'info',
      `[enrich:start] ${memory.sourceType} ${mid} (${memory.text.length} chars)`,
    );

    // Entity extraction
    let t0 = Date.now();
    const rawEntities = await this.extractEntities(memory.text);
    // Deduplicate: collapse entities with the same type + normalized name/value
    const seenEntityKeys = new Set<string>();
    const entities = rawEntities.filter((e) => {
      const key = `${e.type}::${((e as Record<string, unknown>).name || (e as Record<string, unknown>).value || '').toString().toLowerCase().trim()}`;
      if (seenEntityKeys.has(key)) return false;
      seenEntityKeys.add(key);
      return true;
    });
    const entityMs = Date.now() - t0;
    if (entities.length) {
      await this.dbService.db
        .update(memories)
        .set({ entities: JSON.stringify(entities) })
        .where(eq(memories.id, memoryId));
    }
    this.addLog(
      memory.connectorType,
      memory.accountId,
      'info',
      `[enrich:entities] ${mid} → ${entities.length} entities in ${entityMs}ms`,
    );

    // Factuality labeling
    t0 = Date.now();
    const factuality = await this.classifyFactuality(
      memory.text,
      memory.sourceType,
      memory.connectorType,
    );
    const factMs = Date.now() - t0;
    if (factuality) {
      await this.dbService.db
        .update(memories)
        .set({ factuality: JSON.stringify(factuality) })
        .where(eq(memories.id, memoryId));
    }
    const factLabel = factuality?.label || 'unclassified';
    const factConf = factuality?.confidence?.toFixed(2) || '?';
    this.addLog(
      memory.connectorType,
      memory.accountId,
      'info',
      `[enrich:factuality] ${mid} → ${factLabel} (${factConf}) in ${factMs}ms`,
    );

    // Graph link creation — find similar memories via Qdrant
    t0 = Date.now();
    await this.createLinks(memoryId);
    const linkMs = Date.now() - t0;

    // Compute and store base weights
    const ageDays = (Date.now() - new Date(memory.eventTime).getTime()) / (1000 * 60 * 60 * 24);
    const recency = Math.exp(-0.015 * ageDays);
    const importance = 0.5 + Math.min(entities.length * 0.1, 0.4);
    const trust = this.getTrustScore(memory.connectorType);
    const weights = { semantic: 0, rerank: 0, recency, importance, trust, final: 0 };

    await this.dbService.db
      .update(memories)
      .set({ weights: JSON.stringify(weights) })
      .where(eq(memories.id, memoryId));

    const totalMs = Date.now() - pipelineStart;
    this.addLog(
      memory.connectorType,
      memory.accountId,
      'info',
      `[enrich:done] ${mid} in ${totalMs}ms — entities=${entityMs}ms(${entities.length}) factuality=${factMs}ms(${factLabel}) links=${linkMs}ms`,
    );
  }

  private addLog(connectorType: string, accountId: string | null, level: string, message: string) {
    const stage = 'enrich';
    this.logsService.add({
      connectorType,
      accountId: accountId ?? undefined,
      stage,
      level,
      message,
    });
    this.events.emitToChannel('logs', 'log', {
      connectorType,
      accountId,
      stage,
      level,
      message,
      timestamp: new Date(),
    });
  }

  private async extractEntities(text: string): Promise<Array<{ type: string; value: string }>> {
    try {
      const response = await this.ai.generate(
        entityExtractionPrompt(text),
        undefined,
        2,
        ENTITY_FORMAT_SCHEMA,
      );
      const parsed = JSON.parse(response);
      return normalizeEntities(parsed.entities || []);
    } catch {
      return [];
    }
  }

  private async classifyFactuality(
    text: string,
    sourceType: string,
    connectorType: string,
  ): Promise<{ label: string; confidence: number; rationale: string } | null> {
    try {
      const response = await this.ai.generate(factualityPrompt(text, sourceType, connectorType));
      const parsed = this.parseJsonObject(response);
      if (parsed && parsed.label && typeof parsed.confidence === 'number') {
        return parsed as { label: string; confidence: number; rationale: string };
      }
      return null;
    } catch {
      return null;
    }
  }

  private async createLinks(memoryId: string): Promise<void> {
    try {
      const results = await this.qdrant.recommend(memoryId, SIMILAR_MEMORY_LIMIT);

      const [srcMem] = await this.dbService.db
        .select({ claims: memories.claims, factuality: memories.factuality })
        .from(memories)
        .where(eq(memories.id, memoryId));
      const srcClaims: string[] = [];
      try {
        srcClaims.push(
          ...JSON.parse(srcMem?.claims || '[]').map((c: Record<string, unknown> | string) =>
            typeof c === 'string' ? c : (c.text as string) || String(c),
          ),
        );
      } catch {
        /* empty */
      }
      const srcFact = srcMem?.factuality as Record<string, unknown> | null;
      const srcFactLabel = srcFact?.label || 'UNVERIFIED';

      for (const result of results) {
        if (result.score >= SIMILARITY_THRESHOLD && result.id !== memoryId) {
          let linkType = 'related';

          if (srcClaims.length > 0) {
            const [dstMem] = await this.dbService.db
              .select({ factuality: memories.factuality })
              .from(memories)
              .where(eq(memories.id, result.id));
            const dstFact = dstMem?.factuality as Record<string, unknown> | null;
            const dstFactLabel = dstFact?.label || 'UNVERIFIED';

            if (result.score >= 0.92 && srcFactLabel === 'FACT' && dstFactLabel === 'FACT') {
              linkType = 'supports';
            } else if (
              result.score >= 0.85 &&
              ((srcFactLabel === 'FACT' && dstFactLabel === 'FICTION') ||
                (srcFactLabel === 'FICTION' && dstFactLabel === 'FACT'))
            ) {
              linkType = 'contradicts';
            }
          }

          // Check for existing link in both directions to prevent duplicates
          const existingLink = await this.dbService.db
            .select({ id: memoryLinks.id })
            .from(memoryLinks)
            .where(
              and(eq(memoryLinks.srcMemoryId, memoryId), eq(memoryLinks.dstMemoryId, result.id)),
            )
            .limit(1);
          const reverseLink = await this.dbService.db
            .select({ id: memoryLinks.id })
            .from(memoryLinks)
            .where(
              and(eq(memoryLinks.srcMemoryId, result.id), eq(memoryLinks.dstMemoryId, memoryId)),
            )
            .limit(1);
          if (!existingLink.length && !reverseLink.length) {
            await this.dbService.db.insert(memoryLinks).values({
              id: randomUUID(),
              srcMemoryId: memoryId,
              dstMemoryId: result.id,
              linkType,
              strength: result.score,
              createdAt: new Date(),
            });
          }
        }
      }
    } catch {
      // Link creation is best-effort
    }
  }

  private parseJsonArray(text: string): unknown[] {
    try {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) return JSON.parse(match[0]);
      return JSON.parse(text);
    } catch {
      return [];
    }
  }

  private parseJsonObject(text: string): Record<string, unknown> | null {
    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
}

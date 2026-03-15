import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { CryptoService } from '../crypto/crypto.service';
import { UserKeyService } from '../crypto/user-key.service';
import { AiService } from './ai.service';
import { TypesenseService } from './typesense.service';
import { LogsService } from '../logs/logs.service';
import { EventsService } from '../events/events.service';
import { memories, memoryLinks, accounts } from '../db/schema';
import {
  entityExtractionPrompt,
  enrichmentPrompt,
  ENTITY_FORMAT_SCHEMA,
  ENRICHMENT_FORMAT_SCHEMA,
} from './prompts';
import { ConnectorsService } from '../connectors/connectors.service';
import { normalizeEntities } from './entity-normalizer';

const SIMILARITY_THRESHOLD = 0.8;
const SIMILAR_MEMORY_LIMIT = 5;

/** Messages shorter than this with no URLs/attachments skip enrichment entirely */
const TRIVIAL_MESSAGE_MAX_CHARS = 30;

/** Source types that benefit from factuality classification */
const FACTUALITY_SOURCE_TYPES = new Set(['email', 'document']);

@Injectable()
export class EnrichService {
  constructor(
    private dbService: DbService,
    private crypto: CryptoService,
    private userKeyService: UserKeyService,
    private ai: AiService,
    private typesense: TypesenseService,
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

  /**
   * Check if a memory is trivial (short, no URLs, no attachments) and can skip enrichment.
   */
  private isTrivialMessage(text: string, metadata: string | null): boolean {
    if (text.length > TRIVIAL_MESSAGE_MAX_CHARS) return false;
    // Check for URLs
    if (/https?:\/\/\S+/.test(text)) return false;
    // Check for attachments in metadata
    if (metadata) {
      try {
        const parsed = JSON.parse(metadata);
        if (parsed.attachments?.length > 0) return false;
        if (parsed.fileUrl || parsed.fileBase64) return false;
      } catch {
        // ignore parse errors
      }
    }
    return true;
  }

  async enrich(memoryId: string): Promise<void> {
    const rows = await this.dbService.db.select().from(memories).where(eq(memories.id, memoryId));

    if (!rows.length) return;
    const rawMemory = rows[0];
    const mid = memoryId.slice(0, 8);
    const pipelineStart = Date.now();

    // Decrypt memory fields — they are encrypted at embed time with user's DEK
    let memory = rawMemory;
    const kv = rawMemory.keyVersion ?? 0;
    if (kv >= 1 && rawMemory.accountId) {
      const [acct] = await this.dbService.db
        .select({ userId: accounts.userId })
        .from(accounts)
        .where(eq(accounts.id, rawMemory.accountId));
      if (acct?.userId) {
        const userKey = await this.userKeyService.getDek(acct.userId);
        if (!userKey) {
          throw new Error('User key not available. Submit recovery key to unlock encryption.');
        }
        memory = this.crypto.decryptMemoryFieldsWithKey(rawMemory, userKey);
      }
    }

    // Skip enrichment for trivial messages (short, no URLs, no attachments)
    if (this.isTrivialMessage(memory.text, memory.metadata)) {
      // Still compute base weights
      const ageDays = (Date.now() - new Date(memory.eventTime).getTime()) / (1000 * 60 * 60 * 24);
      const recency = Math.exp(-0.015 * ageDays);
      const trust = this.getTrustScore(memory.connectorType);
      const weights = { semantic: 0, rerank: 0, recency, importance: 0.5, trust, final: 0 };
      const defaultFactuality = JSON.stringify({
        label: 'UNVERIFIED',
        confidence: 0.5,
        rationale: 'trivial message — skipped enrichment',
      });

      await this.dbService.db
        .update(memories)
        .set({
          weights: JSON.stringify(weights),
          factuality: this.crypto.encrypt(defaultFactuality)!,
          factualityLabel: 'UNVERIFIED',
        })
        .where(eq(memories.id, memoryId));

      this.addLog(
        memory.connectorType,
        memory.accountId,
        'info',
        `[enrich:skip] ${mid} trivial message (${memory.text.length} chars) — skipped enrichment`,
      );
      return;
    }

    this.addLog(
      memory.connectorType,
      memory.accountId,
      'info',
      `[enrich:start] ${memory.sourceType} ${mid} (${memory.text.length} chars)`,
    );

    let entities: Array<{ type: string; value: string }> = [];
    let factuality: { label: string; confidence: number; rationale: string } | null = null;
    let entityMs = 0;
    let factMs = 0;

    const shouldClassifyFactuality = FACTUALITY_SOURCE_TYPES.has(memory.sourceType);

    if (shouldClassifyFactuality) {
      // Combined prompt: extract entities AND classify factuality in one LLM call
      const t0 = Date.now();
      const result = await this.extractEntitiesAndFactuality(
        memory.text,
        memory.sourceType,
        memory.connectorType,
      );
      entities = result.entities;
      factuality = result.factuality;
      entityMs = Date.now() - t0;
      factMs = 0; // Combined call — no separate factuality timing
    } else {
      // Entity extraction only — skip factuality for messages/photos/locations
      const t0 = Date.now();
      entities = await this.extractEntities(memory.text, memory.sourceType, memory.connectorType);
      entityMs = Date.now() - t0;

      // Default factuality for non-email sources
      factuality = {
        label: 'UNVERIFIED',
        confidence: 0.5,
        rationale: `default for ${memory.sourceType} — factuality classification skipped`,
      };
    }

    // Deduplicate entities
    const seenEntityKeys = new Set<string>();
    entities = entities.filter((e) => {
      const key = `${e.type}::${((e as Record<string, unknown>).name || (e as Record<string, unknown>).value || '').toString().toLowerCase().trim()}`;
      if (seenEntityKeys.has(key)) return false;
      seenEntityKeys.add(key);
      return true;
    });

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
      `[enrich:entities] ${mid} → ${entities.length} entities in ${entityMs}ms${shouldClassifyFactuality ? ' (combined with factuality)' : ''}`,
    );

    if (factuality) {
      await this.dbService.db
        .update(memories)
        .set({
          factuality: this.crypto.encrypt(JSON.stringify(factuality))!,
          factualityLabel: factuality.label,
        })
        .where(eq(memories.id, memoryId));
    }
    const factLabel = factuality?.label || 'unclassified';
    const factConf = factuality?.confidence?.toFixed(2) || '?';
    this.addLog(
      memory.connectorType,
      memory.accountId,
      'info',
      `[enrich:factuality] ${mid} → ${factLabel} (${factConf})${shouldClassifyFactuality ? '' : ' (default — skipped LLM)'}${factMs ? ` in ${factMs}ms` : ''}`,
    );

    // Graph link creation — find similar memories via Qdrant
    const t0 = Date.now();
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
      `[enrich:done] ${mid} in ${totalMs}ms — entities=${entityMs}ms(${entities.length}) factuality=${factLabel} links=${linkMs}ms`,
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

  /**
   * Extract entities only (for non-email sources where factuality is skipped).
   */
  private async extractEntities(
    text: string,
    sourceType?: string,
    connectorType?: string,
  ): Promise<Array<{ type: string; value: string }>> {
    try {
      const response = await this.ai.generate(
        entityExtractionPrompt(text, sourceType, connectorType),
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

  /**
   * Combined entity extraction + factuality classification in a single LLM call.
   * Used for emails and documents where factuality adds value.
   * Saves one LLM call per memory compared to separate calls.
   */
  private async extractEntitiesAndFactuality(
    text: string,
    sourceType: string,
    connectorType: string,
  ): Promise<{
    entities: Array<{ type: string; value: string }>;
    factuality: { label: string; confidence: number; rationale: string } | null;
  }> {
    try {
      const response = await this.ai.generate(
        enrichmentPrompt(text, sourceType, connectorType),
        undefined,
        2,
        ENRICHMENT_FORMAT_SCHEMA,
      );
      const parsed = this.parseJsonObject(response);
      if (!parsed) return { entities: [], factuality: null };

      const entities = normalizeEntities(
        (parsed.entities as Array<{ type: string; value: string }>) || [],
      );

      let factuality: { label: string; confidence: number; rationale: string } | null = null;
      const fact = parsed.factuality as Record<string, unknown> | undefined;
      if (fact && fact.label && typeof fact.confidence === 'number') {
        factuality = fact as { label: string; confidence: number; rationale: string };
      }

      return { entities, factuality };
    } catch {
      return { entities: [], factuality: null };
    }
  }

  private async createLinks(memoryId: string): Promise<void> {
    try {
      const results = await this.typesense.recommend(memoryId, SIMILAR_MEMORY_LIMIT);

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
      let srcFactLabel = 'UNVERIFIED';
      if (srcMem?.factuality) {
        try {
          const decrypted = this.crypto.decrypt(srcMem.factuality as string);
          const parsed = decrypted ? JSON.parse(decrypted) : null;
          srcFactLabel = parsed?.label || 'UNVERIFIED';
        } catch {
          // If it's already a JSON object string (pre-migration), try direct parse
          try {
            const parsed = JSON.parse(srcMem.factuality as string);
            srcFactLabel = parsed?.label || 'UNVERIFIED';
          } catch {
            srcFactLabel = 'UNVERIFIED';
          }
        }
      }

      // Filter candidates above threshold
      const candidates = results.filter(
        (r) => r.score >= SIMILARITY_THRESHOLD && r.id !== memoryId,
      );
      if (!candidates.length) return;

      // Batch check existing links in both directions to avoid N individual queries
      const candidateIds = candidates.map((c) => c.id);
      const existingLinks = await this.dbService.db
        .select({ srcMemoryId: memoryLinks.srcMemoryId, dstMemoryId: memoryLinks.dstMemoryId })
        .from(memoryLinks)
        .where(
          sql`(${memoryLinks.srcMemoryId} = ${memoryId} AND ${memoryLinks.dstMemoryId} IN (${sql.join(
            candidateIds.map((id) => sql`${id}`),
            sql`, `,
          )}))
           OR (${memoryLinks.dstMemoryId} = ${memoryId} AND ${memoryLinks.srcMemoryId} IN (${sql.join(
             candidateIds.map((id) => sql`${id}`),
             sql`, `,
           )}))`,
        );

      const linkedPairs = new Set(existingLinks.map((l) => `${l.srcMemoryId}::${l.dstMemoryId}`));

      // Batch fetch destination factuality for candidates with claims
      let dstFactMap = new Map<string, string>();
      if (srcClaims.length > 0 && candidateIds.length > 0) {
        const dstRows = await this.dbService.db
          .select({ id: memories.id, factuality: memories.factuality })
          .from(memories)
          .where(
            sql`${memories.id} IN (${sql.join(
              candidateIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          );
        dstFactMap = new Map(
          dstRows.map((r) => {
            let label = 'UNVERIFIED';
            if (r.factuality) {
              try {
                const decrypted = this.crypto.decrypt(r.factuality as string);
                const parsed = decrypted ? JSON.parse(decrypted) : null;
                label = parsed?.label || 'UNVERIFIED';
              } catch {
                try {
                  const parsed = JSON.parse(r.factuality as string);
                  label = parsed?.label || 'UNVERIFIED';
                } catch {
                  /* keep default */
                }
              }
            }
            return [r.id, label];
          }),
        );
      }

      for (const result of candidates) {
        // Check both directions
        if (
          linkedPairs.has(`${memoryId}::${result.id}`) ||
          linkedPairs.has(`${result.id}::${memoryId}`)
        ) {
          continue;
        }

        let linkType = 'related';

        if (srcClaims.length > 0) {
          const dstFactLabel = dstFactMap.get(result.id) || 'UNVERIFIED';

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

        await this.dbService.db.insert(memoryLinks).values({
          id: randomUUID(),
          srcMemoryId: memoryId,
          dstMemoryId: result.id,
          linkType,
          strength: result.score,
          createdAt: new Date(),
        });
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

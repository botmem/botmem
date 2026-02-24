import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { eq, sql, and } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { OllamaService } from './ollama.service';
import { QdrantService, ScoredPoint } from './qdrant.service';
import { memories, memoryLinks, memoryContacts, contacts, contactIdentifiers } from '../db/schema';

interface SearchFilters {
  sourceType?: string;
  connectorType?: string;
  contactId?: string;
  factualityLabel?: string;
}

export interface SearchResult {
  id: string;
  text: string;
  sourceType: string;
  connectorType: string;
  eventTime: string;
  factuality: string;
  entities: string;
  score: number;
}

const TRUST_SCORES: Record<string, number> = {
  gmail: 0.95,
  slack: 0.9,
  whatsapp: 0.8,
  imessage: 0.8,
  photos: 0.85,
  locations: 0.85,
  manual: 0.7,
};

@Injectable()
export class MemoryService {
  constructor(
    private dbService: DbService,
    private ollama: OllamaService,
    private qdrant: QdrantService,
    @InjectQueue('embed') private embedQueue: Queue,
  ) {}

  async search(query: string, filters?: SearchFilters, limit = 20): Promise<SearchResult[]> {
    if (!query.trim()) return [];

    const vector = await this.ollama.embed(query);

    const qdrantFilter: Record<string, unknown> | undefined = filters
      ? this.buildQdrantFilter(filters)
      : undefined;

    const qdrantResults = await this.qdrant.search(vector, limit, qdrantFilter);

    if (!qdrantResults.length) return [];

    // Fetch full memory rows
    const db = this.dbService.db;
    const results: SearchResult[] = [];

    for (const point of qdrantResults) {
      const rows = await db.select().from(memories).where(eq(memories.id, point.id));
      if (!rows.length) continue;

      const mem = rows[0];
      const score = this.computeScore(point.score, mem);
      results.push({
        id: mem.id,
        text: mem.text,
        sourceType: mem.sourceType,
        connectorType: mem.connectorType,
        eventTime: mem.eventTime,
        factuality: mem.factuality,
        entities: mem.entities,
        score,
      });
    }

    // If filtering by contactId, filter results through memory_contacts
    if (filters?.contactId) {
      const linkedMemoryIds = new Set(
        (
          await db
            .select({ memoryId: memoryContacts.memoryId })
            .from(memoryContacts)
            .where(eq(memoryContacts.contactId, filters.contactId))
        ).map((r) => r.memoryId),
      );
      return results.filter((r) => linkedMemoryIds.has(r.id));
    }

    return results.sort((a, b) => b.score - a.score);
  }

  async getById(id: string) {
    const rows = await this.dbService.db
      .select()
      .from(memories)
      .where(eq(memories.id, id));
    return rows.length ? rows[0] : null;
  }

  async list(params: {
    limit?: number;
    offset?: number;
    connectorType?: string;
    sourceType?: string;
  } = {}) {
    const db = this.dbService.db;
    const limit = params.limit || 50;
    const offset = params.offset || 0;

    const conditions = [];
    if (params.connectorType) {
      conditions.push(eq(memories.connectorType, params.connectorType));
    }
    if (params.sourceType) {
      conditions.push(eq(memories.sourceType, params.sourceType));
    }

    const where = conditions.length ? and(...conditions) : undefined;

    const countQuery = where
      ? db.select({ count: sql<number>`COUNT(*)` }).from(memories).where(where)
      : db.select({ count: sql<number>`COUNT(*)` }).from(memories);
    const totalRows = await countQuery;
    const total = totalRows[0]?.count || 0;

    const itemsQuery = where
      ? db.select().from(memories).where(where).limit(limit).offset(offset)
      : db.select().from(memories).limit(limit).offset(offset);
    const items = await itemsQuery;

    return { items, total };
  }

  async insert(data: {
    text: string;
    sourceType: string;
    connectorType: string;
    accountId?: string;
    metadata?: Record<string, unknown>;
  }) {
    const id = randomUUID();
    const now = new Date().toISOString();

    await this.dbService.db.insert(memories).values({
      id,
      accountId: data.accountId || null,
      connectorType: data.connectorType,
      sourceType: data.sourceType,
      sourceId: `manual-${id}`,
      text: data.text,
      eventTime: now,
      ingestTime: now,
      metadata: JSON.stringify(data.metadata || {}),
      embeddingStatus: 'pending',
      createdAt: now,
    });

    return { id, text: data.text, sourceType: data.sourceType, connectorType: data.connectorType };
  }

  async delete(id: string) {
    await this.dbService.db.delete(memories).where(eq(memories.id, id));
    try {
      await this.qdrant.remove(id);
    } catch {
      // Qdrant removal is best-effort
    }
  }

  async getStats() {
    const db = this.dbService.db;

    const totalRows = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(memories);
    const total = totalRows[0]?.count || 0;

    const sourceRows = await db
      .select({ key: memories.sourceType, count: sql<number>`COUNT(*)` })
      .from(memories)
      .groupBy(memories.sourceType);
    const bySource: Record<string, number> = {};
    for (const r of sourceRows) bySource[r.key] = r.count;

    const connectorRows = await db
      .select({ key: memories.connectorType, count: sql<number>`COUNT(*)` })
      .from(memories)
      .groupBy(memories.connectorType);
    const byConnector: Record<string, number> = {};
    for (const r of connectorRows) byConnector[r.key] = r.count;

    // Factuality is stored as JSON, extract label with json_extract
    const factRows = await db
      .select({
        label: sql<string>`json_extract(${memories.factuality}, '$.label')`,
        count: sql<number>`COUNT(*)`,
      })
      .from(memories)
      .groupBy(sql`json_extract(${memories.factuality}, '$.label')`);
    const byFactuality: Record<string, number> = {};
    for (const r of factRows) {
      if (r.label) byFactuality[r.label] = r.count;
    }

    return { total, bySource, byConnector, byFactuality };
  }

  async getGraphData(limit = 500) {
    const db = this.dbService.db;

    // Fetch capped number of recent memories instead of all
    const recentMemories = await db
      .select()
      .from(memories)
      .orderBy(sql`${memories.eventTime} DESC`)
      .limit(limit);

    const memoryIds = new Set(recentMemories.map((m) => m.id));

    // Only fetch links and contacts related to these memories
    const relevantLinks = await db
      .select()
      .from(memoryLinks)
      .where(
        sql`${memoryLinks.srcMemoryId} IN (${sql.join(
          recentMemories.map((m) => sql`${m.id}`),
          sql`, `,
        )})`,
      );

    const relevantMemoryContacts = await db
      .select()
      .from(memoryContacts)
      .where(
        sql`${memoryContacts.memoryId} IN (${sql.join(
          recentMemories.map((m) => sql`${m.id}`),
          sql`, `,
        )})`,
      );

    const relevantContactIds = [...new Set(relevantMemoryContacts.map((mc) => mc.contactId))];

    const relevantContacts = relevantContactIds.length
      ? await db
          .select()
          .from(contacts)
          .where(sql`${contacts.id} IN (${sql.join(relevantContactIds.map((id) => sql`${id}`), sql`, `)})`)
      : [];

    const relevantIdentifiers = relevantContactIds.length
      ? await db
          .select()
          .from(contactIdentifiers)
          .where(sql`${contactIdentifiers.contactId} IN (${sql.join(relevantContactIds.map((id) => sql`${id}`), sql`, `)})`)
      : [];

    // Build entity → cluster mapping
    const entityClusters = new Map<string, number>();
    let nextCluster = 0;

    const memoryNodes = recentMemories.map((m) => {
      let entities: any[] = [];
      try { entities = JSON.parse(m.entities); } catch {}

      let factLabel = 'UNVERIFIED';
      try { factLabel = JSON.parse(m.factuality).label; } catch {}

      const dominantEntity = entities.find((e: any) => e.type === 'person' || e.type === 'organization');
      let cluster = 0;
      if (dominantEntity) {
        const key = dominantEntity.value.toLowerCase();
        if (!entityClusters.has(key)) entityClusters.set(key, nextCluster++);
        cluster = entityClusters.get(key)!;
      }

      const trust = TRUST_SCORES[m.connectorType] || 0.7;
      const importance = Math.min(0.3 + entities.length * 0.1 + trust * 0.3, 1.0);
      const entityNames = entities.map((e: any) => e.value).slice(0, 5);

      return {
        id: m.id,
        label: m.text.slice(0, 60),
        type: m.sourceType,
        connectorType: m.connectorType,
        factuality: factLabel,
        importance,
        cluster,
        nodeType: 'memory' as const,
        entities: entityNames,
      };
    });

    // Build contact nodes
    const identifiersByContact = new Map<string, string[]>();
    for (const ident of relevantIdentifiers) {
      const list = identifiersByContact.get(ident.contactId) || [];
      list.push(ident.connectorType || 'unknown');
      identifiersByContact.set(ident.contactId, list);
    }

    const contactNodes = relevantContacts.map((c) => {
      const connectors = [...new Set(identifiersByContact.get(c.id) || [])];
      const nameKey = c.displayName.toLowerCase();
      let cluster = 0;
      if (entityClusters.has(nameKey)) cluster = entityClusters.get(nameKey)!;

      return {
        id: `contact-${c.id}`,
        label: c.displayName,
        type: 'contact' as const,
        connectorType: connectors[0] || 'manual',
        factuality: 'FACT',
        importance: 0.8,
        cluster,
        nodeType: 'contact' as const,
        connectors,
      };
    });

    // Edges — only include those where both endpoints are in our node set
    const edges = relevantLinks
      .filter((l) => memoryIds.has(l.srcMemoryId) && memoryIds.has(l.dstMemoryId))
      .map((l) => ({
        source: l.srcMemoryId,
        target: l.dstMemoryId,
        type: l.linkType,
        strength: l.strength,
      }));

    const contactEdges = relevantMemoryContacts.map((mc) => ({
      source: `contact-${mc.contactId}`,
      target: mc.memoryId,
      type: 'involves',
      strength: 0.7,
    }));

    return {
      nodes: [...memoryNodes, ...contactNodes],
      edges: [...edges, ...contactEdges],
    };
  }

  private computeScore(semanticScore: number, mem: any): number {
    const ageDays = (Date.now() - new Date(mem.eventTime).getTime()) / (1000 * 60 * 60 * 24);
    const recency = Math.exp(-0.015 * ageDays);

    let entityCount = 0;
    try {
      entityCount = JSON.parse(mem.entities).length;
    } catch {}
    const importance = 0.5 + Math.min(entityCount * 0.1, 0.4);
    const trust = TRUST_SCORES[mem.connectorType] || 0.7;

    return 0.4 * semanticScore + 0.25 * recency + 0.2 * importance + 0.15 * trust;
  }

  private buildQdrantFilter(filters: SearchFilters): Record<string, unknown> {
    const must: any[] = [];

    if (filters.sourceType) {
      must.push({ key: 'source_type', match: { value: filters.sourceType } });
    }
    if (filters.connectorType) {
      must.push({ key: 'connector_type', match: { value: filters.connectorType } });
    }

    return must.length ? { must } : {};
  }
}

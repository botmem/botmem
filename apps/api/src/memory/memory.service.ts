import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { eq, sql, and, inArray } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { OllamaService } from './ollama.service';
import { QdrantService, ScoredPoint } from './qdrant.service';
import { ConnectorsService } from '../connectors/connectors.service';
import { memories, memoryLinks, memoryContacts, contacts, contactIdentifiers, accounts } from '../db/schema';

interface SearchFilters {
  sourceType?: string;
  connectorType?: string;
  contactId?: string;
  factualityLabel?: string;
}

/** Strip accents/diacritics for fuzzy matching (amélie → amelie) */
function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export interface SearchResult {
  id: string;
  text: string;
  sourceType: string;
  connectorType: string;
  eventTime: string;
  ingestTime: string;
  createdAt: string;
  factuality: string;
  entities: string;
  metadata: string;
  accountIdentifier: string | null;
  score: number;
  weights: {
    semantic: number;
    rerank: number;
    recency: number;
    importance: number;
    trust: number;
    final: number;
  };
}

@Injectable()
export class MemoryService {
  constructor(
    private dbService: DbService,
    private ollama: OllamaService,
    private qdrant: QdrantService,
    private connectors: ConnectorsService,
  ) {}

  private getTrustScore(connectorType: string): number {
    try {
      return this.connectors.get(connectorType).manifest.trustScore;
    } catch {
      return 0.7;
    }
  }

  private getWeights(connectorType: string): { semantic: number; recency: number; importance: number; trust: number } {
    const defaults = { semantic: 0.40, recency: 0.25, importance: 0.20, trust: 0.15 };
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

  async search(query: string, filters?: SearchFilters, limit = 20): Promise<SearchResult[]> {
    if (!query.trim()) return [];

    const db = this.dbService.db;

    // If filtering by contactId, skip hybrid and just fetch that contact's memories
    if (filters?.contactId) {
      const vector = await this.ollama.embed(query);
      const qdrantFilter = filters ? this.buildQdrantFilter(filters) : undefined;
      const qdrantResults = await this.qdrant.search(vector, limit * 3, qdrantFilter);
      const linkedMemoryIds = new Set(
        (await db.select({ memoryId: memoryContacts.memoryId })
          .from(memoryContacts)
          .where(eq(memoryContacts.contactId, filters.contactId))
        ).map((r) => r.memoryId),
      );
      const results: SearchResult[] = [];
      for (const point of qdrantResults) {
        if (!linkedMemoryIds.has(point.id)) continue;
        const row = await this.fetchMemoryRow(point.id);
        if (!row) continue;
        const { score, weights } = this.computeWeights(point.score, row.memory);
        results.push(this.toSearchResult(row, score, weights));
        if (results.length >= limit) break;
      }
      return results.sort((a, b) => b.score - a.score);
    }

    // --- Hybrid search: vector + text + contact name ---

    // 1. Vector search
    const vector = await this.ollama.embed(query);
    const qdrantFilter = filters ? this.buildQdrantFilter(filters) : undefined;
    const qdrantResults = await this.qdrant.search(vector, limit * 2, qdrantFilter);

    // 2. Text search (SQL LIKE) — split query into words, match ALL words (AND logic)
    const queryLower = query.toLowerCase();
    const queryNorm = stripAccents(queryLower);
    const queryWords = queryLower.split(/\s+/).filter((w) => w.length >= 2);
    const queryWordsNorm = queryWords.map(stripAccents);
    const textConditions: any[] = [
      eq(memories.embeddingStatus, 'done'),
    ];
    for (const word of queryWords) {
      textConditions.push(sql`LOWER(${memories.text}) LIKE ${'%' + word + '%'}` as any);
    }
    if (filters?.sourceType) textConditions.push(eq(memories.sourceType, filters.sourceType));
    if (filters?.connectorType) textConditions.push(eq(memories.connectorType, filters.connectorType));
    const textMatches = await db
      .select({ id: memories.id })
      .from(memories)
      .where(and(...textConditions)!)
      .limit(limit * 2);
    const textMatchIds = new Set(textMatches.map((r) => r.id));

    // 3. Contact name search — find contacts matching ANY query word
    // Match both accented and stripped versions (amélie matches amelie and vice versa)
    const seenContactIds = new Set<string>();
    const matchingContacts: { id: string; displayName: string }[] = [];
    for (const word of queryWordsNorm) {
      const rows = await db
        .select({ id: contacts.id, displayName: contacts.displayName })
        .from(contacts)
        .where(sql`LOWER(${contacts.displayName}) LIKE ${'%' + word + '%'}`);
      for (const c of rows) {
        if (!seenContactIds.has(c.id)) { seenContactIds.add(c.id); matchingContacts.push(c); }
      }
    }
    // Fallback: fetch all contacts and match with accent stripping (SQLite can't do NFD)
    if (!matchingContacts.length) {
      const allContactRows = await db.select({ id: contacts.id, displayName: contacts.displayName }).from(contacts);
      for (const c of allContactRows) {
        if (queryWordsNorm.some((w) => stripAccents(c.displayName.toLowerCase()).includes(w)) && !seenContactIds.has(c.id)) {
          matchingContacts.push(c);
        }
      }
    }

    const contactMatchIds = new Set<string>();
    if (matchingContacts.length) {
      const contactIds = matchingContacts.map((c) => c.id);
      const linked = await db
        .select({ memoryId: memoryContacts.memoryId })
        .from(memoryContacts)
        .where(inArray(memoryContacts.contactId, contactIds));
      for (const r of linked) contactMatchIds.add(r.memoryId);
    }

    // 4. Also check contact identifiers (email, phone, handle) — match ANY word
    const matchingIdents: { contactId: string }[] = [];
    for (const word of queryWords) {
      const rows = await db
        .select({ contactId: contactIdentifiers.contactId })
        .from(contactIdentifiers)
        .where(sql`LOWER(${contactIdentifiers.identifierValue}) LIKE ${'%' + word + '%'}`);
      for (const r of rows) matchingIdents.push(r);
    }
    if (matchingIdents.length) {
      const identContactIds = [...new Set(matchingIdents.map((r) => r.contactId))];
      const linked = await db
        .select({ memoryId: memoryContacts.memoryId })
        .from(memoryContacts)
        .where(inArray(memoryContacts.contactId, identContactIds));
      for (const r of linked) contactMatchIds.add(r.memoryId);
    }

    const hasExactMatches = textMatchIds.size > 0 || contactMatchIds.size > 0;

    // Collect candidate memory IDs
    // When text/contact matches exist, only include semantic results that overlap
    const allCandidateIds = new Set<string>();
    for (const id of textMatchIds) allCandidateIds.add(id);
    for (const id of contactMatchIds) allCandidateIds.add(id);
    if (!hasExactMatches) {
      // No exact matches — fall back to semantic results
      for (const point of qdrantResults) allCandidateIds.add(point.id);
    } else {
      // Add semantic results only if they also match text/contact (reinforcement)
      for (const point of qdrantResults) {
        if (textMatchIds.has(point.id) || contactMatchIds.has(point.id)) {
          allCandidateIds.add(point.id);
        }
      }
    }

    if (!allCandidateIds.size) return [];

    // Build semantic score map from vector results
    const semanticScores = new Map<string, number>();
    for (const point of qdrantResults) {
      semanticScores.set(point.id, point.score);
    }

    // Fetch and score all candidates
    const results: SearchResult[] = [];
    for (const id of allCandidateIds) {
      const row = await this.fetchMemoryRow(id);
      if (!row) continue;

      const mem = row.memory;
      // Apply source type / connector type filters for text/contact matches
      if (filters?.sourceType && mem.sourceType !== filters.sourceType) continue;
      if (filters?.connectorType && mem.connectorType !== filters.connectorType) continue;

      const semanticScore = semanticScores.get(id) ?? 0;
      const hasTextMatch = textMatchIds.has(id);
      const hasContactMatch = contactMatchIds.has(id);

      // Boost: text/contact matches get a significant relevance boost
      const textBoost = hasTextMatch ? 0.45 : 0;
      const contactBoost = hasContactMatch ? 0.40 : 0;

      const { score, weights } = this.computeWeights(semanticScore, mem);
      const boostedScore = Math.min(score + textBoost + contactBoost, 1.0);
      const boostedWeights = { ...weights, final: boostedScore };

      results.push(this.toSearchResult(row, boostedScore, boostedWeights));
    }

    // Apply minimum score threshold — drop noise
    const MIN_SCORE = 0.35;
    const filtered = results.filter((r) => r.score >= MIN_SCORE);

    return filtered.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private async fetchMemoryRow(id: string) {
    const rows = await this.dbService.db
      .select({ memory: memories, accountIdentifier: accounts.identifier })
      .from(memories)
      .leftJoin(accounts, eq(memories.accountId, accounts.id))
      .where(eq(memories.id, id));
    return rows.length ? rows[0] : null;
  }

  private toSearchResult(
    row: { memory: typeof memories.$inferSelect; accountIdentifier: string | null },
    score: number,
    weights: SearchResult['weights'],
  ): SearchResult {
    const mem = row.memory;
    return {
      id: mem.id,
      text: mem.text,
      sourceType: mem.sourceType,
      connectorType: mem.connectorType,
      eventTime: mem.eventTime,
      ingestTime: mem.ingestTime,
      createdAt: mem.createdAt,
      factuality: mem.factuality,
      entities: mem.entities,
      metadata: mem.metadata,
      accountIdentifier: row.accountIdentifier,
      score,
      weights,
    };
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
    sortBy?: 'eventTime' | 'ingestTime';
  } = {}) {
    const db = this.dbService.db;
    const limit = params.limit || 50;
    const offset = params.offset || 0;
    const sortCol = params.sortBy === 'ingestTime' ? memories.ingestTime : memories.eventTime;

    // Show memories as soon as embedding is done
    const conditions = [
      eq(memories.embeddingStatus, 'done'),
    ];
    if (params.connectorType) {
      conditions.push(eq(memories.connectorType, params.connectorType));
    }
    if (params.sourceType) {
      conditions.push(eq(memories.sourceType, params.sourceType));
    }

    const where = and(...conditions)!;

    const totalRows = await db.select({ count: sql<number>`COUNT(*)` }).from(memories).where(where);
    const total = totalRows[0]?.count || 0;

    const itemsQuery = db.select({ memory: memories, accountIdentifier: accounts.identifier })
      .from(memories)
      .leftJoin(accounts, eq(memories.accountId, accounts.id))
      .where(where)
      .orderBy(sql`${sortCol} DESC`)
      .limit(limit)
      .offset(offset);
    const rows = await itemsQuery;
    const items = rows.map((r) => ({ ...r.memory, accountIdentifier: r.accountIdentifier }));

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

    return { id, text: data.text, sourceType: data.sourceType, connectorType: data.connectorType, eventTime: now, createdAt: now };
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
    const doneFilter = eq(memories.embeddingStatus, 'done');

    const totalRows = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(memories)
      .where(doneFilter);
    const total = totalRows[0]?.count || 0;

    const sourceRows = await db
      .select({ key: memories.sourceType, count: sql<number>`COUNT(*)` })
      .from(memories)
      .where(doneFilter)
      .groupBy(memories.sourceType);
    const bySource: Record<string, number> = {};
    for (const r of sourceRows) bySource[r.key] = r.count;

    const connectorRows = await db
      .select({ key: memories.connectorType, count: sql<number>`COUNT(*)` })
      .from(memories)
      .where(doneFilter)
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
      .where(doneFilter)
      .groupBy(sql`json_extract(${memories.factuality}, '$.label')`);
    const byFactuality: Record<string, number> = {};
    for (const r of factRows) {
      if (r.label) byFactuality[r.label] = r.count;
    }

    return { total, bySource, byConnector, byFactuality };
  }

  async getGraphData(limit = 500, linkLimit = 2000) {
    const db = this.dbService.db;

    // Fetch linked memories first, then fill with recent
    const allLinks = await db.select().from(memoryLinks).limit(linkLimit);

    const linkedIdSet = new Set<string>();
    for (const link of allLinks) {
      linkedIdSet.add(link.srcMemoryId);
      linkedIdSet.add(link.dstMemoryId);
    }

    // Fetch recent memories — show as soon as embedding is done
    const recentMemories = await db
      .select()
      .from(memories)
      .where(eq(memories.embeddingStatus, 'done'))
      .orderBy(sql`${memories.eventTime} DESC`)
      .limit(limit);

    const memoryIds = new Set(recentMemories.map((m) => m.id));

    // Add any linked memories not already in the recent set (only if done)
    const missingLinkedIds = [...linkedIdSet].filter((id) => !memoryIds.has(id));
    const linkedMemories: Array<typeof recentMemories[0]> = [];
    for (let i = 0; i < missingLinkedIds.length; i += 100) {
      const batch = missingLinkedIds.slice(i, i + 100);
      if (!batch.length) break;
      const rows = await db.select().from(memories)
        .where(and(inArray(memories.id, batch), eq(memories.embeddingStatus, 'done')));
      linkedMemories.push(...rows);
    }

    const allMemories = [...recentMemories, ...linkedMemories];
    for (const m of linkedMemories) memoryIds.add(m.id);

    const relevantLinks = allLinks.filter(
      (l) => memoryIds.has(l.srcMemoryId) && memoryIds.has(l.dstMemoryId),
    );

    // Fetch contacts and identifiers (small tables — fetch all, filter in JS)
    const allMemoryContacts = await db.select().from(memoryContacts);
    const relevantMemoryContacts = allMemoryContacts.filter((mc) => memoryIds.has(mc.memoryId));

    const relevantContactIdSet = new Set(relevantMemoryContacts.map((mc) => mc.contactId));

    const allContacts = await db.select().from(contacts);
    const relevantContacts = allContacts.filter((c) => relevantContactIdSet.has(c.id));

    const allIdentifiers = await db.select().from(contactIdentifiers);
    const relevantIdentifiers = allIdentifiers.filter((i) => relevantContactIdSet.has(i.contactId));

    // Build entity → cluster mapping
    const entityClusters = new Map<string, number>();
    let nextCluster = 0;

    const memoryNodes = allMemories.map((m) => {
      let entities: any[] = [];
      try { entities = JSON.parse(m.entities); } catch {}

      let factLabel = 'UNVERIFIED';
      try { factLabel = JSON.parse(m.factuality).label; } catch {}

      const dominantEntity = entities.find((e: any) => (e.type === 'person' || e.type === 'organization') && e.value);
      let cluster = 0;
      if (dominantEntity) {
        const key = String(dominantEntity.value).toLowerCase();
        if (!entityClusters.has(key)) entityClusters.set(key, nextCluster++);
        cluster = entityClusters.get(key)!;
      }

      const trust = this.getTrustScore(m.connectorType);
      const importance = Math.min(0.3 + entities.length * 0.1 + trust * 0.3, 1.0);
      const entityNames = entities.map((e: any) => e.value || '').filter(Boolean).slice(0, 5);

      let weights: Record<string, number> = {};
      try { weights = JSON.parse(m.weights); } catch {}

      let metadata: Record<string, unknown> = {};
      try { metadata = JSON.parse(m.metadata); } catch {}

      return {
        id: m.id,
        label: m.text.slice(0, 60),
        text: m.text,
        type: m.sourceType,
        connectorType: m.connectorType,
        factuality: factLabel,
        importance,
        cluster,
        nodeType: 'memory' as const,
        entities: entityNames,
        weights,
        eventTime: m.eventTime,
        metadata,
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
      const displayName = c.displayName || 'Unknown';
      const nameKey = displayName.toLowerCase();
      let cluster = 0;
      if (entityClusters.has(nameKey)) cluster = entityClusters.get(nameKey)!;

      const entityType = (c as any).entityType || 'person';
      const nodeType = entityType === 'group' ? 'group' as const : entityType === 'device' ? 'device' as const : 'contact' as const;

      return {
        id: `contact-${c.id}`,
        label: displayName,
        type: nodeType,
        connectorType: connectors[0] || 'manual',
        factuality: 'FACT',
        importance: entityType === 'group' ? 0.9 : entityType === 'device' ? 0.6 : 0.8,
        cluster,
        nodeType,
        connectors,
        entityType,
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
      type: mc.role || 'involves',
      strength: mc.role === 'group' ? 0.9 : 0.7,
    }));

    // Build file/attachment nodes from memories with attachments in metadata.
    // First get the top files by occurrence across ALL memories (not just graph slice).
    const fileCountRows = await db
      .select({
        metadata: memories.metadata,
        connectorType: memories.connectorType,
      })
      .from(memories)
      .where(sql`json_extract(${memories.metadata}, '$.attachments') IS NOT NULL`);

    // Aggregate file counts across all memories
    const fileCounts = new Map<string, { count: number; mimeType: string; connectorType: string }>();
    for (const row of fileCountRows) {
      let meta: any = {};
      try { meta = JSON.parse(row.metadata); } catch { continue; }
      const atts = meta.attachments as Array<{ filename?: string; mimeType?: string }> | undefined;
      if (!atts) continue;
      for (const att of atts) {
        const name = att.filename;
        if (!name) continue;
        const existing = fileCounts.get(name);
        if (existing) {
          existing.count++;
        } else {
          fileCounts.set(name, { count: 1, mimeType: att.mimeType || 'unknown', connectorType: row.connectorType });
        }
      }
    }

    // Take top 200 files by occurrence
    const topFiles = [...fileCounts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 200);

    const fileNameSet = new Set(topFiles.map(([name]) => name));

    const fileNodes = topFiles.map(([name, info]) => ({
      id: `file-${name}`,
      label: name,
      text: '',
      type: 'file' as string,
      connectorType: info.connectorType,
      factuality: 'FACT',
      importance: Math.min(0.4 + info.count * 0.05, 1.0),
      cluster: 0,
      nodeType: 'file' as const,
      entities: [info.mimeType],
      weights: {} as Record<string, number>,
      eventTime: '',
    }));

    // Create edges only for memories in the current graph that have these files
    const fileEdges: typeof edges = [];
    for (const m of allMemories) {
      let meta: any = {};
      try { meta = JSON.parse(m.metadata); } catch { continue; }
      const attachments = meta.attachments as Array<{ filename?: string }> | undefined;
      if (!attachments?.length) continue;
      for (const att of attachments) {
        if (att.filename && fileNameSet.has(att.filename)) {
          fileEdges.push({
            source: m.id,
            target: `file-${att.filename}`,
            type: 'attachment',
            strength: 0.8,
          });
        }
      }
    }

    return {
      nodes: [...memoryNodes, ...contactNodes, ...fileNodes],
      edges: [...edges, ...contactEdges, ...fileEdges],
    };
  }

  private computeWeights(semanticScore: number, mem: any): {
    score: number;
    weights: { semantic: number; rerank: number; recency: number; importance: number; trust: number; final: number };
  } {
    const ageDays = (Date.now() - new Date(mem.eventTime).getTime()) / (1000 * 60 * 60 * 24);
    const recency = Math.exp(-0.015 * ageDays);

    let entityCount = 0;
    try {
      entityCount = JSON.parse(mem.entities).length;
    } catch {}
    const importance = 0.5 + Math.min(entityCount * 0.1, 0.4);
    const trust = this.getTrustScore(mem.connectorType);
    const w = this.getWeights(mem.connectorType);
    const final = w.semantic * semanticScore + w.recency * recency + w.importance * importance + w.trust * trust;

    return {
      score: final,
      weights: { semantic: semanticScore, rerank: 0, recency, importance, trust, final },
    };
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

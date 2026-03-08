import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { eq, sql, and, inArray } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { OllamaService } from './ollama.service';
import { QdrantService, ScoredPoint } from './qdrant.service';
import { ConnectorsService } from '../connectors/connectors.service';
import { PluginRegistry } from '../plugins/plugin-registry';
import { memories, memoryLinks, memoryContacts, contacts, contactIdentifiers, accounts, settings } from '../db/schema';
import { parseNlq } from './nlq-parser';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { removeStopwords } = require('stopword');

interface SearchFilters {
  sourceType?: string;
  connectorType?: string;
  contactId?: string;
  factualityLabel?: string;
  from?: string;
  to?: string;
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
  pinned: number;
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

export interface ResolvedEntities {
  contacts: { id: string; displayName: string }[];
  topicWords: string[];
  topicMatchCount: number;
}

export interface ParsedQuery {
  temporal: { from: string; to: string } | null;
  temporalFallback?: boolean;
  entities: { id: string; displayName: string }[];
  intent: 'recall' | 'browse' | 'find';
  cleanQuery: string;
  sourceType?: string;
}

export interface SearchResponse {
  items: SearchResult[];
  fallback: boolean;
  resolvedEntities?: ResolvedEntities;
  parsed?: ParsedQuery;
}

/** Check if candidate words match as whole-word boundaries in a contact name.
 *  Short words (<=4 chars) require exact match. Longer words allow prefix match at >=80% coverage. */
function nameWordsMatch(contactName: string, candidateWords: string[]): boolean {
  if (!contactName) return false;
  const nameWords = stripAccents(contactName.toLowerCase()).split(/\s+/);
  return candidateWords.every(cw =>
    nameWords.some(nw => {
      if (nw === cw) return true;
      // Only allow prefix matching for longer candidates (5+ chars) with high coverage
      if (cw.length >= 5 && nw.startsWith(cw) && cw.length / nw.length >= 0.8) return true;
      return false;
    }),
  );
}

@Injectable()
export class MemoryService {
  private contactsCache: { data: { id: string; displayName: string }[]; expires: number } | null = null;
  private static CONTACTS_CACHE_TTL = 60_000; // 60s

  constructor(
    private dbService: DbService,
    private ollama: OllamaService,
    private qdrant: QdrantService,
    private connectors: ConnectorsService,
    private pluginRegistry: PluginRegistry,
  ) {}

  /** Invalidate contacts cache (call after contact writes) */
  invalidateContactsCache() {
    this.contactsCache = null;
  }

  private async getCachedContacts(): Promise<{ id: string; displayName: string }[]> {
    if (this.contactsCache && Date.now() < this.contactsCache.expires) {
      return this.contactsCache.data;
    }
    const data = await this.dbService.db
      .select({ id: contacts.id, displayName: contacts.displayName })
      .from(contacts);
    this.contactsCache = { data, expires: Date.now() + MemoryService.CONTACTS_CACHE_TTL };
    return data;
  }

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

  /**
   * Greedy multi-word entity resolution: tries longest spans first against contact names.
   * "assad mansoor car" → contacts: [Assad Mansoor], topicWords: ["car"]
   * Uses word-boundary matching so "car" does NOT match "Ricardo".
   */
  private async resolveEntities(queryWords: string[]): Promise<{
    contacts: { id: string; displayName: string }[];
    topicWords: string[];
    contactIds: string[];
  }> {
    const allContacts = await this.getCachedContacts();

    const resolved: { id: string; displayName: string }[] = [];
    const remaining = [...queryWords];
    const usedIndices = new Set<number>();

    // Try progressively shorter spans starting from each position
    let i = 0;
    while (i < remaining.length) {
      let matched = false;
      for (let spanLen = remaining.length - i; spanLen >= 1; spanLen--) {
        const candidateWords = remaining.slice(i, i + spanLen).map(w => stripAccents(w));

        for (const c of allContacts) {
          if (!nameWordsMatch(c.displayName, candidateWords)) continue;
          // For single-word candidates, require the candidate covers a significant
          // portion of the name (avoid "car" matching "Nomi Car Lift")
          const nameWordCount = (c.displayName || '').trim().split(/\s+/).length;
          if (candidateWords.length === 1 && nameWordCount > 2) continue;
          if (!resolved.some(r => r.id === c.id)) {
            resolved.push(c);
          }
          for (let j = i; j < i + spanLen; j++) usedIndices.add(j);
          matched = true;
          break;
        }
        if (matched) {
          i += spanLen;
          break;
        }
      }
      if (!matched) i++;
    }

    const topicWords = removeStopwords(
      remaining.filter((_, idx) => !usedIndices.has(idx)),
    );
    const contactIds = resolved.map(c => c.id);

    return { contacts: resolved, topicWords, contactIds };
  }

  async search(query: string, filters?: SearchFilters, limit = 20, rerank = false): Promise<SearchResponse> {
    if (!query.trim()) return { items: [], fallback: false };

    // --- NLQ parsing (pure, synchronous) ---
    const nlq = parseNlq(query);
    const effectiveFilters: SearchFilters = { ...filters };

    // Apply temporal filters from NLQ (only if caller didn't provide explicit from/to)
    if (nlq.temporal && !filters?.from && !filters?.to) {
      effectiveFilters.from = nlq.temporal.from;
      effectiveFilters.to = nlq.temporal.to;
    }

    // Apply source type hint from NLQ (only if caller didn't provide explicit sourceType)
    // Map user-friendly NLQ terms to actual DB source_type values
    const SOURCE_TYPE_ALIASES: Record<string, string> = { photo: 'file' };
    if (nlq.sourceTypeHint && !filters?.sourceType) {
      effectiveFilters.sourceType = SOURCE_TYPE_ALIASES[nlq.sourceTypeHint] ?? nlq.sourceTypeHint;
    }

    // Apply intent-based limit: find intent caps at 5
    let effectiveLimit = limit;
    if (nlq.intent === 'find') {
      effectiveLimit = Math.min(limit, 5);
    }

    // Use clean query for embeddings (stripped of temporal tokens)
    const embeddingQuery = nlq.cleanQuery;

    const db = this.dbService.db;

    // If filtering by contactId directly, skip hybrid and just fetch that contact's memories
    if (effectiveFilters.contactId) {
      const vector = await this.ollama.embed(embeddingQuery);
      const qdrantFilter = this.buildQdrantFilter(effectiveFilters);
      const qdrantResults = await this.qdrant.search(vector, effectiveLimit * 3, qdrantFilter);
      const linkedMemoryIds = new Set(
        (await db.select({ memoryId: memoryContacts.memoryId })
          .from(memoryContacts)
          .where(eq(memoryContacts.contactId, effectiveFilters.contactId!))
        ).map((r) => r.memoryId),
      );
      const results: SearchResult[] = [];
      for (const point of qdrantResults) {
        if (!linkedMemoryIds.has(point.id)) continue;
        const row = await this.fetchMemoryRow(point.id);
        if (!row) continue;
        const { score, weights } = this.computeWeights(point.score, 0, row.memory, nlq.intent);
        results.push(this.toSearchResult(row, score, weights));
        if (results.length >= effectiveLimit) break;
      }
      const sorted = results.sort((a, b) => b.score - a.score);
      // Fire afterSearch hook (fire-and-forget)
      void this.pluginRegistry.fireHook('afterSearch', {
        query, resultCount: sorted.length, topScore: sorted[0]?.score,
      });
      return {
        items: sorted,
        fallback: false,
        parsed: {
          temporal: nlq.temporal,
          entities: [],
          intent: nlq.intent,
          cleanQuery: nlq.cleanQuery,
          sourceType: nlq.sourceTypeHint ?? undefined,
        },
      };
    }

    // --- Entity-aware hybrid search ---

    const queryLower = query.toLowerCase();
    const queryWords = queryLower
      .split(/\s+/)
      .map(w => w.replace(/'s$/i, ''))
      .filter((w) => w.length >= 2);

    // Phase 1: Entity resolution (greedy multi-word span matching)
    const entityResult = await this.resolveEntities(queryWords);
    const { contacts: resolvedContacts, topicWords, contactIds } = entityResult;
    const hasContacts = resolvedContacts.length > 0;
    const hasTopics = topicWords.length > 0;

    // Phase 2: Vector search (use clean query for embeddings, apply effectiveFilters)
    const vector = await this.ollama.embed(embeddingQuery);
    const qdrantFilter = this.buildQdrantFilter(effectiveFilters);
    const qdrantResults = await this.qdrant.search(vector, effectiveLimit * 2, Object.keys(qdrantFilter).length ? qdrantFilter : undefined);
    const semanticScores = new Map<string, number>();
    for (const point of qdrantResults) semanticScores.set(point.id, point.score);

    // Phase 3: Search execution based on decomposition
    const textMatchIds = new Set<string>();
    const contactMatchIds = new Set<string>();
    let topicMatchCount = 0;

    if (hasContacts) {
      // Get all memory IDs linked to resolved contacts
      const linked = await db
        .select({ memoryId: memoryContacts.memoryId })
        .from(memoryContacts)
        .where(inArray(memoryContacts.contactId, contactIds));
      const allContactMemoryIds = new Set(linked.map(r => r.memoryId));

      if (hasTopics) {
        // Intersect: contact memories filtered by topic words
        const topicConditions: any[] = [
          inArray(memoryContacts.contactId, contactIds),
        ];
        for (const tw of topicWords) {
          topicConditions.push(sql`LOWER(${memories.text}) LIKE ${'%' + tw + '%'}` as any);
        }
        const filtered = await db
          .select({ memoryId: memoryContacts.memoryId })
          .from(memoryContacts)
          .innerJoin(memories, eq(memories.id, memoryContacts.memoryId))
          .where(and(...topicConditions)!);
        topicMatchCount = filtered.length;
        for (const r of filtered) contactMatchIds.add(r.memoryId);

        // Also boost vector results that belong to the contact
        for (const point of qdrantResults) {
          if (allContactMemoryIds.has(point.id)) contactMatchIds.add(point.id);
        }
      } else {
        // Contact browse: all memories for that contact
        for (const id of allContactMemoryIds) contactMatchIds.add(id);
      }
    }

    if (!hasContacts || hasTopics) {
      // Topic text search using FTS5 (falls back to LIKE if FTS unavailable)
      const searchWords = hasContacts ? topicWords : queryWords;
      if (searchWords.length > 0) {
        try {
          // FTS5 query: each word as a prefix match, AND logic
          const ftsQuery = searchWords.map(w => `"${w}"*`).join(' AND ');
          const ftsMatches = this.dbService.sqlite
            .prepare('SELECT id FROM memories_fts WHERE memories_fts MATCH ? LIMIT ?')
            .all(ftsQuery, limit * 2) as { id: string }[];
          for (const r of ftsMatches) textMatchIds.add(r.id);
        } catch {
          // Fallback to LIKE if FTS table doesn't exist yet
          const textConditions: any[] = [eq(memories.embeddingStatus, 'done')];
          for (const word of searchWords) {
            textConditions.push(sql`LOWER(${memories.text}) LIKE ${'%' + word + '%'}` as any);
          }
          if (effectiveFilters.sourceType) textConditions.push(eq(memories.sourceType, effectiveFilters.sourceType));
          if (effectiveFilters.connectorType) textConditions.push(eq(memories.connectorType, effectiveFilters.connectorType));
          if (effectiveFilters.from) textConditions.push(sql`${memories.eventTime} >= ${effectiveFilters.from}` as any);
          if (effectiveFilters.to) textConditions.push(sql`${memories.eventTime} <= ${effectiveFilters.to}` as any);
          const textMatches = await db
            .select({ id: memories.id })
            .from(memories)
            .where(and(...textConditions)!)
            .limit(limit * 2);
          for (const r of textMatches) textMatchIds.add(r.id);
        }
      }
    }

    const hasExactMatches = textMatchIds.size > 0 || contactMatchIds.size > 0;

    // Collect candidate memory IDs
    const allCandidateIds = new Set<string>();
    for (const id of textMatchIds) allCandidateIds.add(id);
    for (const id of contactMatchIds) allCandidateIds.add(id);
    if (!hasExactMatches) {
      for (const point of qdrantResults) allCandidateIds.add(point.id);
    } else {
      for (const point of qdrantResults) {
        if (textMatchIds.has(point.id) || contactMatchIds.has(point.id)) {
          allCandidateIds.add(point.id);
        }
      }
    }

    if (!allCandidateIds.size) {
      // If temporal filter caused zero results, fall through to temporal fallback below
      if (!(nlq.temporal && effectiveFilters.from)) {
        return {
          items: [],
          fallback: false,
          resolvedEntities: hasContacts ? { contacts: resolvedContacts, topicWords, topicMatchCount } : undefined,
          parsed: {
            temporal: nlq.temporal,
            entities: resolvedContacts.map(c => ({ id: c.id, displayName: c.displayName })),
            intent: nlq.intent,
            cleanQuery: nlq.cleanQuery,
            sourceType: nlq.sourceTypeHint ?? undefined,
          },
        };
      }
    }

    // Batch fetch all candidate rows in one query
    const candidateRows: Array<{ id: string; row: { memory: typeof memories.$inferSelect; accountIdentifier: string | null } }> = [];
    const batchRows = await this.fetchMemoryRowsBatch([...allCandidateIds]);
    for (const [id, row] of batchRows) {
      const mem = row.memory;
      if (effectiveFilters.sourceType && mem.sourceType !== effectiveFilters.sourceType) continue;
      if (effectiveFilters.connectorType && mem.connectorType !== effectiveFilters.connectorType) continue;
      // Apply temporal filters in SQL-fetched rows
      if (effectiveFilters.from && mem.eventTime < effectiveFilters.from) continue;
      if (effectiveFilters.to && mem.eventTime > effectiveFilters.to) continue;
      candidateRows.push({ id, row });
    }

    // Rerank top 15 candidates (opt-in — too slow for default search)
    const rerankScores = new Map<string, number>();
    if (rerank) {
      const sortedCandidates = [...candidateRows].sort(
        (a, b) => (semanticScores.get(b.id) ?? 0) - (semanticScores.get(a.id) ?? 0),
      );
      const rerankCandidates = sortedCandidates.slice(0, 15);
      if (rerankCandidates.length > 0) {
        const rerankTexts = rerankCandidates.map(c => c.row.memory.text);
        const scores = await this.ollama.rerank(query, rerankTexts);
        for (let i = 0; i < rerankCandidates.length; i++) {
          rerankScores.set(rerankCandidates[i].id, scores[i]);
        }
      }
    }

    // Score all candidates
    const results: SearchResult[] = [];
    for (const { id, row } of candidateRows) {
      const semanticScore = semanticScores.get(id) ?? 0;
      const rerankScore = rerankScores.get(id) ?? 0;
      const textBoost = textMatchIds.has(id) ? 0.45 : 0;
      const contactBoost = contactMatchIds.has(id) ? 0.40 : 0;

      const { score, weights } = this.computeWeights(semanticScore, rerankScore, row.memory, nlq.intent);
      const boostedScore = Math.min(score + textBoost + contactBoost, 1.0);
      const boostedWeights = { ...weights, final: boostedScore };

      results.push(this.toSearchResult(row, boostedScore, boostedWeights));
    }

    const MIN_SCORE = 0.35;
    const scored = results.filter((r) => r.score >= MIN_SCORE);
    const finalItems = scored.sort((a, b) => b.score - a.score).slice(0, effectiveLimit);

    // Temporal fallback: if NLQ temporal was applied and zero results, retry without temporal
    let temporalFallback = false;
    let returnItems = finalItems;
    if (nlq.temporal && effectiveFilters.from && finalItems.length === 0) {
      const fallbackFilters = { ...effectiveFilters };
      delete fallbackFilters.from;
      delete fallbackFilters.to;
      const fallbackQdrantFilter = this.buildQdrantFilter(fallbackFilters);
      const fallbackQdrantResults = await this.qdrant.search(vector, effectiveLimit * 2, Object.keys(fallbackQdrantFilter).length ? fallbackQdrantFilter : undefined);
      const fallbackIds = new Set(fallbackQdrantResults.map(p => p.id));
      const fallbackBatch = await this.fetchMemoryRowsBatch([...fallbackIds]);
      const fallbackScores = new Map<string, number>();
      for (const p of fallbackQdrantResults) fallbackScores.set(p.id, p.score);
      const fallbackResults: SearchResult[] = [];
      for (const [fid, frow] of fallbackBatch) {
        if (fallbackFilters.sourceType && frow.memory.sourceType !== fallbackFilters.sourceType) continue;
        if (fallbackFilters.connectorType && frow.memory.connectorType !== fallbackFilters.connectorType) continue;
        const { score, weights } = this.computeWeights(fallbackScores.get(fid) ?? 0, 0, frow.memory, nlq.intent);
        fallbackResults.push(this.toSearchResult(frow, score, weights));
      }
      returnItems = fallbackResults.filter(r => r.score >= MIN_SCORE).sort((a, b) => b.score - a.score).slice(0, effectiveLimit);
      temporalFallback = true;
    }

    // Fire afterSearch hook (fire-and-forget)
    void this.pluginRegistry.fireHook('afterSearch', {
      query, resultCount: returnItems.length, topScore: returnItems[0]?.score,
    });

    return {
      items: returnItems,
      fallback: !hasExactMatches,
      resolvedEntities: hasContacts ? { contacts: resolvedContacts, topicWords, topicMatchCount } : undefined,
      parsed: {
        temporal: nlq.temporal,
        temporalFallback,
        entities: resolvedContacts.map(c => ({ id: c.id, displayName: c.displayName })),
        intent: nlq.intent,
        cleanQuery: nlq.cleanQuery,
        sourceType: nlq.sourceTypeHint ?? undefined,
      },
    };
  }

  private async fetchMemoryRow(id: string) {
    const rows = await this.dbService.db
      .select({ memory: memories, accountIdentifier: accounts.identifier })
      .from(memories)
      .leftJoin(accounts, eq(memories.accountId, accounts.id))
      .where(eq(memories.id, id));
    return rows.length ? rows[0] : null;
  }

  private async fetchMemoryRowsBatch(ids: string[]): Promise<Map<string, { memory: typeof memories.$inferSelect; accountIdentifier: string | null }>> {
    const result = new Map<string, { memory: typeof memories.$inferSelect; accountIdentifier: string | null }>();
    if (!ids.length) return result;
    // SQLite has a variable limit (~999), batch in chunks
    for (let i = 0; i < ids.length; i += 500) {
      const batch = ids.slice(i, i + 500);
      const rows = await this.dbService.db
        .select({ memory: memories, accountIdentifier: accounts.identifier })
        .from(memories)
        .leftJoin(accounts, eq(memories.accountId, accounts.id))
        .where(inArray(memories.id, batch));
      for (const row of rows) {
        result.set(row.memory.id, row);
      }
    }
    return result;
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
      pinned: mem.pinned,
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

    // Always include self-contact in the graph
    const selfRow = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'selfContactId')).limit(1);
    const selfContactId = selfRow[0]?.value;
    if (selfContactId) {
      relevantContactIdSet.add(selfContactId);
      // Add all self-contact memory links as edges (even if memory isn't in graph slice)
      const selfLinks = allMemoryContacts.filter((mc) => mc.contactId === selfContactId && memoryIds.has(mc.memoryId));
      for (const sl of selfLinks) {
        if (!relevantMemoryContacts.some((mc) => mc.memoryId === sl.memoryId && mc.contactId === sl.contactId)) {
          relevantMemoryContacts.push(sl);
        }
      }
    }

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
      links: [...edges, ...contactEdges, ...fileEdges],
    };
  }

  /**
   * Build graph delta for a single memory — lightweight query for WS push.
   * Returns the memory node, its links, associated contact nodes, and contact edges.
   */
  async buildGraphDelta(memoryId: string) {
    const db = this.dbService.db;

    const [mem] = await db.select().from(memories).where(eq(memories.id, memoryId));
    if (!mem || mem.embeddingStatus !== 'done') return null;

    let entities: any[] = [];
    try { entities = JSON.parse(mem.entities); } catch {}
    let factLabel = 'UNVERIFIED';
    try { factLabel = JSON.parse(mem.factuality).label; } catch {}
    let weights: Record<string, number> = {};
    try { weights = JSON.parse(mem.weights); } catch {}
    let metadata: Record<string, unknown> = {};
    try { metadata = JSON.parse(mem.metadata); } catch {}

    const trust = this.getTrustScore(mem.connectorType);
    const importance = Math.min(0.3 + entities.length * 0.1 + trust * 0.3, 1.0);
    const entityNames = entities.map((e: any) => e.value || '').filter(Boolean).slice(0, 5);

    const node = {
      id: mem.id,
      label: mem.text.slice(0, 60),
      text: mem.text,
      type: mem.sourceType,
      connectorType: mem.connectorType,
      factuality: factLabel,
      importance,
      cluster: 0,
      nodeType: 'memory' as const,
      entities: entityNames,
      weights,
      eventTime: mem.eventTime,
      metadata,
    };

    // Links from/to this memory
    const links = await db.select().from(memoryLinks)
      .where(sql`${memoryLinks.srcMemoryId} = ${memoryId} OR ${memoryLinks.dstMemoryId} = ${memoryId}`);
    const graphLinks = links.map((l) => ({
      source: l.srcMemoryId,
      target: l.dstMemoryId,
      type: l.linkType,
      strength: l.strength,
    }));

    // Contact associations
    const mcRows = await db.select().from(memoryContacts).where(eq(memoryContacts.memoryId, memoryId));
    const contactIds = mcRows.map((mc) => mc.contactId);
    const contactNodes: any[] = [];
    const contactEdges = mcRows.map((mc) => ({
      source: `contact-${mc.contactId}`,
      target: memoryId,
      type: mc.role || 'involves',
      strength: mc.role === 'group' ? 0.9 : 0.7,
    }));

    if (contactIds.length) {
      const contactRows = await db.select().from(contacts).where(inArray(contacts.id, contactIds));
      const identRows = await db.select().from(contactIdentifiers).where(inArray(contactIdentifiers.contactId, contactIds));
      const identByContact = new Map<string, string[]>();
      for (const i of identRows) {
        const list = identByContact.get(i.contactId) || [];
        list.push(i.connectorType || 'unknown');
        identByContact.set(i.contactId, list);
      }
      for (const c of contactRows) {
        const connectors = [...new Set(identByContact.get(c.id) || [])];
        const entityType = (c as any).entityType || 'person';
        const nodeType = entityType === 'group' ? 'group' as const : entityType === 'device' ? 'device' as const : 'contact' as const;
        contactNodes.push({
          id: `contact-${c.id}`,
          label: c.displayName || 'Unknown',
          type: nodeType,
          connectorType: connectors[0] || 'manual',
          factuality: 'FACT',
          importance: entityType === 'group' ? 0.9 : entityType === 'device' ? 0.6 : 0.8,
          cluster: 0,
          nodeType,
          connectors,
          entityType,
        });
      }
    }

    return {
      nodes: [node],
      links: graphLinks,
      contacts: contactNodes,
      contactEdges,
    };
  }

  private computeWeights(semanticScore: number, rerankScore: number, mem: any, intent?: 'recall' | 'browse' | 'find'): {
    score: number;
    weights: { semantic: number; rerank: number; recency: number; importance: number; trust: number; final: number };
  } {
    const isPinned = mem.pinned === 1;
    const recallCount = mem.recallCount || 0;

    const ageDays = (Date.now() - new Date(mem.eventTime).getTime()) / (1000 * 60 * 60 * 24);
    // Pinned memories are exempt from recency decay
    const recency = isPinned ? 1.0 : Math.exp(-0.015 * ageDays);

    let entityCount = 0;
    try {
      entityCount = JSON.parse(mem.entities).length;
    } catch {}
    // Base importance + recall boost (capped at +0.2)
    const baseImportance = 0.5 + Math.min(entityCount * 0.1, 0.4);
    const importance = baseImportance + Math.min(recallCount * 0.02, 0.2);
    const trust = this.getTrustScore(mem.connectorType);

    // When reranker is available, use the full 5-weight formula.
    // When unavailable (rerankScore === 0), redistribute rerank weight to semantic.
    // Browse intent boosts recency weight significantly.
    let final: number;
    if (intent === 'browse') {
      final = rerankScore > 0
        ? 0.25 * semanticScore + 0.20 * rerankScore + 0.40 * recency + 0.10 * importance + 0.05 * trust
        : 0.40 * semanticScore + 0.40 * recency + 0.15 * importance + 0.05 * trust;
    } else {
      final = rerankScore > 0
        ? 0.40 * semanticScore + 0.30 * rerankScore + 0.15 * recency + 0.10 * importance + 0.05 * trust
        : 0.70 * semanticScore + 0.15 * recency + 0.10 * importance + 0.05 * trust;
    }

    // Scorer plugin bonus (clamped to +/-0.05, averaged across plugins)
    const scorers = this.pluginRegistry.getScorers();
    if (scorers.length > 0) {
      let pluginBonus = 0;
      for (const scorer of scorers) {
        try { pluginBonus += scorer.score(mem, { semantic: semanticScore, rerank: rerankScore, recency, importance, trust }); } catch { /* ignore */ }
      }
      pluginBonus = Math.max(-0.05, Math.min(0.05, pluginBonus / scorers.length));
      final = Math.max(0, Math.min(1, final + pluginBonus));
    }

    // Pinned memories get a score floor of 0.75
    if (isPinned) final = Math.max(final, 0.75);

    return {
      score: final,
      weights: { semantic: semanticScore, rerank: rerankScore, recency, importance, trust, final },
    };
  }

  /** Phase 9: Temporal query — memories within a date range, optionally filtered */
  async timeline(params: {
    from?: string;
    to?: string;
    connectorType?: string;
    sourceType?: string;
    query?: string;
    limit?: number;
  }) {
    const db = this.dbService.db;
    const limit = params.limit || 50;
    const conditions: any[] = [eq(memories.embeddingStatus, 'done')];

    if (params.from) {
      conditions.push(sql`${memories.eventTime} >= ${params.from}`);
    }
    if (params.to) {
      conditions.push(sql`${memories.eventTime} <= ${params.to}`);
    }
    if (params.connectorType) {
      conditions.push(eq(memories.connectorType, params.connectorType));
    }
    if (params.sourceType) {
      conditions.push(eq(memories.sourceType, params.sourceType));
    }
    if (params.query) {
      const words = params.query.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
      for (const word of words) {
        conditions.push(sql`LOWER(${memories.text}) LIKE ${'%' + word + '%'}`);
      }
    }

    const totalRows = await db.select({ count: sql<number>`COUNT(*)` }).from(memories).where(and(...conditions)!);
    const total = totalRows[0]?.count || 0;

    const rows = await db
      .select({ memory: memories, accountIdentifier: accounts.identifier })
      .from(memories)
      .leftJoin(accounts, eq(memories.accountId, accounts.id))
      .where(and(...conditions)!)
      .orderBy(sql`${memories.eventTime} ASC`)
      .limit(limit);

    const items = rows.map(r => ({ ...r.memory, accountIdentifier: r.accountIdentifier }));
    return { items, total };
  }

  /** Phase 9: Get memories related to a given memory (via links + vector similarity) */
  async getRelated(memoryId: string, limit = 20) {
    const db = this.dbService.db;
    const memory = await this.getById(memoryId);
    if (!memory) return { items: [], source: null };

    // 1. Direct graph links (memoryLinks table)
    const linkedIds = new Set<string>();
    const outLinks = await db.select().from(memoryLinks).where(eq(memoryLinks.srcMemoryId, memoryId));
    const inLinks = await db.select().from(memoryLinks).where(eq(memoryLinks.dstMemoryId, memoryId));
    for (const l of [...outLinks, ...inLinks]) {
      linkedIds.add(l.srcMemoryId === memoryId ? l.dstMemoryId : l.srcMemoryId);
    }

    // 2. Vector similarity (Qdrant recommend)
    const recommended = await this.qdrant.recommend(memoryId, limit);
    for (const r of recommended) linkedIds.add(r.id);

    // 3. Same-contact memories (shared participants)
    const contactLinks = await db
      .select({ contactId: memoryContacts.contactId })
      .from(memoryContacts)
      .where(eq(memoryContacts.memoryId, memoryId));
    const contactIdList = contactLinks.map(c => c.contactId);

    if (contactIdList.length > 0) {
      const coMemories = await db
        .select({ memoryId: memoryContacts.memoryId })
        .from(memoryContacts)
        .where(inArray(memoryContacts.contactId, contactIdList))
        .limit(limit * 2);
      for (const cm of coMemories) {
        if (cm.memoryId !== memoryId) linkedIds.add(cm.memoryId);
      }
    }

    // Fetch and score all related
    linkedIds.delete(memoryId);
    const relatedIds = [...linkedIds].slice(0, limit * 2);
    const items: Array<any> = [];

    for (const id of relatedIds) {
      const row = await this.fetchMemoryRow(id);
      if (!row) continue;
      const mem = row.memory;

      // Score by: graph link > vector similarity > contact co-occurrence
      const graphLink = outLinks.some(l => l.dstMemoryId === id) || inLinks.some(l => l.srcMemoryId === id);
      const vectorScore = recommended.find(r => r.id === id)?.score ?? 0;
      const score = (graphLink ? 0.5 : 0) + vectorScore * 0.3 + 0.2;

      items.push({
        id: mem.id,
        text: mem.text,
        sourceType: mem.sourceType,
        connectorType: mem.connectorType,
        eventTime: mem.eventTime,
        accountIdentifier: row.accountIdentifier,
        score,
        relationship: graphLink ? 'linked' : vectorScore > 0 ? 'similar' : 'co-participant',
      });
    }

    items.sort((a, b) => b.score - a.score);
    return { items: items.slice(0, limit), source: memory };
  }

  /** Canonical entity types */
  getEntityTypes(): string[] {
    return ['person', 'organization', 'location', 'event', 'product', 'topic', 'pet', 'group', 'device', 'other'];
  }

  /** Phase 10: Search entities across all memories */
  async searchEntities(query: string, limit = 50, types?: string[]) {
    const db = this.dbService.db;
    const queryLower = query.toLowerCase();

    // Search in entities JSON column
    const rows = await db
      .select({
        id: memories.id,
        entities: memories.entities,
        connectorType: memories.connectorType,
        sourceType: memories.sourceType,
        eventTime: memories.eventTime,
      })
      .from(memories)
      .where(and(
        eq(memories.embeddingStatus, 'done'),
        sql`LOWER(${memories.entities}) LIKE ${'%' + queryLower + '%'}`,
      ))
      .limit(limit * 5);

    // Extract and aggregate matching entities
    const entityMap = new Map<string, { value: string; type: string; memoryCount: number; memoryIds: string[]; connectors: Set<string> }>();

    for (const row of rows) {
      let entities: any[] = [];
      try { entities = JSON.parse(row.entities); } catch { continue; }

      for (const e of entities) {
        const value = e.value || e.name || e.id;
        if (!value || !String(value).toLowerCase().includes(queryLower)) continue;

        const key = `${e.type}:${String(value).toLowerCase()}`;
        const existing = entityMap.get(key);
        if (existing) {
          existing.memoryCount++;
          if (existing.memoryIds.length < 5) existing.memoryIds.push(row.id);
          existing.connectors.add(row.connectorType);
        } else {
          entityMap.set(key, {
            value: String(value),
            type: e.type || 'unknown',
            memoryCount: 1,
            memoryIds: [row.id],
            connectors: new Set([row.connectorType]),
          });
        }
      }
    }

    // Filter by type if specified
    let entries = [...entityMap.values()];
    if (types && types.length > 0) {
      const typeSet = new Set(types.map(t => t.toLowerCase()));
      entries = entries.filter(e => typeSet.has(e.type.toLowerCase()));
    }

    const entities = entries
      .map(e => ({ ...e, connectors: [...e.connectors] }))
      .sort((a, b) => b.memoryCount - a.memoryCount)
      .slice(0, limit);

    return { entities, total: entities.length };
  }

  /** Phase 10: Get entity details with related memories and co-occurring entities */
  async getEntityGraph(entityValue: string, limit = 30) {
    const db = this.dbService.db;
    const queryLower = entityValue.toLowerCase();

    // Find memories containing this entity
    const rows = await db
      .select({
        id: memories.id,
        text: memories.text,
        entities: memories.entities,
        connectorType: memories.connectorType,
        sourceType: memories.sourceType,
        eventTime: memories.eventTime,
      })
      .from(memories)
      .where(and(
        eq(memories.embeddingStatus, 'done'),
        sql`LOWER(${memories.entities}) LIKE ${'%' + queryLower + '%'}`,
      ))
      .orderBy(sql`${memories.eventTime} DESC`)
      .limit(limit);

    // Collect co-occurring entities
    const coEntities = new Map<string, { value: string; type: string; count: number }>();
    const memoryItems = rows.map(row => {
      let entities: any[] = [];
      try { entities = JSON.parse(row.entities); } catch {}

      for (const e of entities) {
        const val = e.value || e.name || e.id;
        if (!val) continue;
        const key = `${e.type}:${String(val).toLowerCase()}`;
        if (String(val).toLowerCase() === queryLower) continue;
        const existing = coEntities.get(key);
        if (existing) { existing.count++; }
        else { coEntities.set(key, { value: String(val), type: e.type, count: 1 }); }
      }

      return {
        id: row.id,
        text: row.text.slice(0, 200),
        sourceType: row.sourceType,
        connectorType: row.connectorType,
        eventTime: row.eventTime,
      };
    });

    const relatedEntities = [...coEntities.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    // Also check contacts matching this entity
    const matchingContacts = await db
      .select({ id: contacts.id, displayName: contacts.displayName })
      .from(contacts)
      .where(sql`LOWER(${contacts.displayName}) LIKE ${'%' + queryLower + '%'}`)
      .limit(10);

    return {
      entity: entityValue,
      memories: memoryItems,
      relatedEntities,
      contacts: matchingContacts,
      memoryCount: memoryItems.length,
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
    if (filters.from || filters.to) {
      const range: Record<string, string> = {};
      if (filters.from) range.gte = filters.from;
      if (filters.to) range.lte = filters.to;
      must.push({ key: 'event_time', range });
    }

    return must.length ? { must } : {};
  }
}

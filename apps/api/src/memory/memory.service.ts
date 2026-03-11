import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { eq, sql, and, or, inArray, type SQLWrapper } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { AiService } from './ai.service';
import { QdrantService } from './qdrant.service';
import { ConnectorsService } from '../connectors/connectors.service';
import { PluginRegistry } from '../plugins/plugin-registry';
import { CryptoService } from '../crypto/crypto.service';
import { UserKeyService } from '../crypto/user-key.service';
import {
  memories,
  memoryLinks,
  memoryContacts,
  contacts,
  contactIdentifiers,
  accounts,
  settings,
} from '../db/schema';
import { parseNlq } from './nlq-parser';

const MINIMAL_STOPS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'am',
  'do',
  'does',
  'did',
  'has',
  'have',
  'had',
  'i',
  'me',
  'my',
  'we',
  'our',
  'you',
  'your',
  'it',
  'its',
  'he',
  'she',
  'his',
  'her',
  'they',
  'them',
  'their',
  'this',
  'that',
  'of',
  'in',
  'to',
  'for',
  'on',
  'at',
  'by',
  'with',
  'and',
  'or',
  'but',
  'if',
  'so',
  'as',
  'not',
  'no',
]);

const TITLE_PREFIXES = new Set(['dr.', 'dr', 'mr.', 'mr', 'mrs.', 'mrs', 'ms.', 'ms']);

interface SearchFilters {
  sourceType?: string;
  connectorType?: string;
  contactId?: string;
  factualityLabel?: string;
  from?: string;
  to?: string;
  userId?: string;
  memoryBankId?: string;
  memoryBankIds?: string[]; // API key memory bank scoping
  accountIds?: string[]; // User isolation — filter by user's accounts
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
  eventTime: Date;
  ingestTime: Date;
  createdAt: Date;
  factuality: unknown;
  entities: string;
  metadata: string;
  accountIdentifier: string | null;
  pinned: boolean;
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
  return candidateWords.every((cw) =>
    nameWords.some((nw) => {
      if (nw === cw) return true;
      // Only allow prefix matching for longer candidates (5+ chars) with high coverage
      if (cw.length >= 5 && nw.startsWith(cw) && cw.length / nw.length >= 0.8) return true;
      return false;
    }),
  );
}

@Injectable()
export class MemoryService {
  private contactsCache: Map<
    string,
    { data: { id: string; displayName: string; entityType: string }[]; expires: number }
  > = new Map();
  private static CONTACTS_CACHE_TTL = 60_000; // 60s

  constructor(
    private dbService: DbService,
    private ai: AiService,
    private qdrant: QdrantService,
    private connectors: ConnectorsService,
    private pluginRegistry: PluginRegistry,
    private crypto: CryptoService,
    private userKeyService: UserKeyService,
  ) {}

  /**
   * Decrypt memory fields using the correct key based on keyVersion.
   * keyVersion=0 -> APP_SECRET, keyVersion>=1 -> per-user key.
   * Falls back to APP_SECRET if no userId or no user key available.
   */
  private decryptMemoryAuto<
    T extends {
      text: string;
      entities: string;
      claims: string;
      metadata: string;
      keyVersion?: number;
    },
  >(mem: T, userId?: string | null, resolvedKey?: Buffer | null): T {
    const kv = mem.keyVersion ?? 0;
    if (kv >= 1 && userId) {
      const userKey = resolvedKey ?? this.userKeyService.getKey(userId);
      if (userKey) {
        return this.crypto.decryptMemoryFieldsWithKey(mem, userKey);
      }
      // Key not available — return placeholder. User must enter recovery key.
      return {
        ...mem,
        text: '[Encrypted — enter your recovery key to view]',
        entities: '[]',
        claims: '[]',
      };
    }
    return this.crypto.decryptMemoryFields(mem);
  }

  /** Resolve user key once (async) for use in batch decryption. */
  async resolveUserKey(userId?: string | null): Promise<Buffer | null> {
    if (!userId) return null;
    return this.userKeyService.getDek(userId);
  }

  /** Check if user has encrypted memories but no decryption key available. */
  async needsRecoveryKey(userId?: string): Promise<boolean> {
    if (!userId) return false;
    // Try async 2-tier lookup first
    const dek = await this.userKeyService.getDek(userId);
    if (dek) return false;
    // Only flag if there are actually user-encrypted memories (keyVersion >= 1)
    const [row] = await this.dbService.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(memories)
      .where(
        and(
          eq(memories.accountId, sql`(SELECT id FROM accounts WHERE user_id = ${userId} LIMIT 1)`),
          sql`${memories.keyVersion} >= 1`,
        ),
      )
      .limit(1);
    return (row?.count ?? 0) > 0;
  }

  /** @deprecated Use needsRecoveryKey instead */
  async needsRelogin(userId?: string): Promise<boolean> {
    return this.needsRecoveryKey(userId);
  }

  /** Invalidate contacts cache (call after contact writes) */
  invalidateContactsCache(userId?: string) {
    if (userId) {
      this.contactsCache.delete(userId);
    } else {
      this.contactsCache.clear();
    }
  }

  /** Get account IDs belonging to a user — used for data isolation */
  /**
   * Returns account IDs for a user. null = no user filter (internal/system calls).
   * Empty array = user exists but has no accounts (should see zero data).
   */
  async getUserAccountIds(userId?: string): Promise<string[] | null> {
    if (!userId) return null;
    const rows = await this.dbService.withCurrentUser((db) =>
      db.select({ id: accounts.id }).from(accounts).where(eq(accounts.userId, userId)),
    );
    return rows.map((r) => r.id);
  }

  private async getCachedContacts(
    userId?: string,
  ): Promise<{ id: string; displayName: string; entityType: string }[]> {
    const cacheKey = userId || '__none__';
    const cached = this.contactsCache.get(cacheKey);
    if (cached && Date.now() < cached.expires) {
      return cached.data;
    }
    const data = await this.dbService.withCurrentUser((db) =>
      db
        .select({
          id: contacts.id,
          displayName: contacts.displayName,
          entityType: contacts.entityType,
        })
        .from(contacts),
    );
    this.contactsCache.set(cacheKey, {
      data,
      expires: Date.now() + MemoryService.CONTACTS_CACHE_TTL,
    });
    return data;
  }

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
   * Greedy multi-word entity resolution: tries longest spans first against contact names.
   * "assad mansoor car" → contacts: [Assad Mansoor], topicWords: ["car"]
   * Uses word-boundary matching so "car" does NOT match "Ricardo".
   */
  private async resolveEntities(
    queryWords: string[],
    userId?: string,
  ): Promise<{
    contacts: { id: string; displayName: string }[];
    topicWords: string[];
    contactIds: string[];
  }> {
    const allContacts = (await this.getCachedContacts(userId)).filter(
      (c) => c.entityType !== 'group',
    );

    const resolved: { id: string; displayName: string }[] = [];
    const remaining = [...queryWords];
    const usedIndices = new Set<number>();

    // Try progressively shorter spans starting from each position
    let i = 0;
    while (i < remaining.length) {
      let matched = false;
      for (let spanLen = remaining.length - i; spanLen >= 1; spanLen--) {
        const candidateWords = remaining.slice(i, i + spanLen).map((w) => stripAccents(w));

        for (const c of allContacts) {
          if (!nameWordsMatch(c.displayName, candidateWords)) continue;
          // For single-word candidates, require the candidate covers a significant
          // portion of the name (avoid "car" matching "Nomi Car Lift")
          const nameWordsRaw = stripAccents((c.displayName || '').toLowerCase()).split(/\s+/);
          const nameWordCount = nameWordsRaw.length;
          if (candidateWords.length === 1 && nameWordCount > 1) {
            // Only match first real word of multi-word names (prevents "insurance" → "Osama Insurance")
            const nameWordsClean = nameWordsRaw.filter((w) => !TITLE_PREFIXES.has(w));
            const firstNameWord = nameWordsClean[0] || nameWordsRaw[0];
            const cw = candidateWords[0];
            const matchesFirst =
              firstNameWord === cw ||
              (cw.length >= 5 &&
                firstNameWord.startsWith(cw) &&
                cw.length / firstNameWord.length >= 0.8);
            if (!matchesFirst) continue;
          }
          if (!resolved.some((r) => r.id === c.id)) {
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

    const unusedWords = remaining.filter((_, idx) => !usedIndices.has(idx));
    let topicWords = unusedWords.filter((w) => !MINIMAL_STOPS.has(w));
    if (topicWords.length === 0 && unusedWords.length > 0) topicWords = unusedWords;
    const contactIds = resolved.map((c) => c.id);

    return { contacts: resolved, topicWords, contactIds };
  }

  async search(
    query: string,
    filters?: SearchFilters,
    limit = 20,
    rerank = false,
    userId?: string,
    memoryBankId?: string,
    memoryBankIds?: string[],
  ): Promise<SearchResponse> {
    if (!query.trim()) return { items: [], fallback: false };

    // Pre-resolve user decryption key (async 2-tier: memory → Redis)
    const resolvedKey = await this.resolveUserKey(userId);

    // --- User isolation: resolve account IDs ---
    const userAccountIds = await this.getUserAccountIds(userId);

    // --- NLQ parsing (pure, synchronous) ---
    const nlq = parseNlq(query);
    const effectiveFilters: SearchFilters = { ...filters };
    if (userAccountIds !== null) {
      if (userAccountIds.length === 0) return { items: [], fallback: false };
      effectiveFilters.accountIds = userAccountIds;
    }

    // Apply memory bank scoping
    if (memoryBankId) effectiveFilters.memoryBankId = memoryBankId;
    else if (memoryBankIds?.length) effectiveFilters.memoryBankIds = memoryBankIds;

    // Apply temporal filters from NLQ (only if caller didn't provide explicit from/to)
    if (nlq.temporal && !filters?.from && !filters?.to) {
      effectiveFilters.from = nlq.temporal.from;
      effectiveFilters.to = nlq.temporal.to;
    }

    // Apply source type hint from NLQ (only if caller didn't provide explicit sourceType)
    if (nlq.sourceTypeHint && !filters?.sourceType) {
      effectiveFilters.sourceType = nlq.sourceTypeHint;
    }

    // Apply intent-based limit: find intent caps at 5
    let effectiveLimit = limit;
    if (nlq.intent === 'find') {
      effectiveLimit = Math.min(limit, 5);
    }

    // Use clean query for embeddings (stripped of temporal tokens)
    const embeddingQuery = nlq.cleanQuery;

    // If filtering by contactId directly, skip hybrid and just fetch that contact's memories
    if (effectiveFilters.contactId) {
      const vector = await this.ai.embed(embeddingQuery);
      const qdrantFilter = this.buildQdrantFilter(effectiveFilters);
      const qdrantResults = await this.qdrant.search(vector, effectiveLimit * 3, qdrantFilter);
      const linkedMemoryIds = new Set(
        (
          await this.dbService.withCurrentUser((db) =>
            db
              .select({ memoryId: memoryContacts.memoryId })
              .from(memoryContacts)
              .where(eq(memoryContacts.contactId, effectiveFilters.contactId!)),
          )
        ).map((r) => r.memoryId),
      );
      const results: SearchResult[] = [];
      for (const point of qdrantResults) {
        if (!linkedMemoryIds.has(point.id)) continue;
        const row = await this.fetchMemoryRow(point.id);
        if (!row) continue;
        const { score, weights } = this.computeWeights(point.score, 0, row.memory, nlq.intent);
        results.push(this.toSearchResult(row, score, weights, userId, resolvedKey));
        if (results.length >= effectiveLimit) break;
      }
      const sorted = results.sort((a, b) => b.score - a.score);
      // Fire afterSearch hook (fire-and-forget)
      void this.pluginRegistry.fireHook('afterSearch', {
        query,
        resultCount: sorted.length,
        topScore: sorted[0]?.score,
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
      .map((w) => w.replace(/'s$/i, ''))
      .filter((w) => w.length >= 2);

    // Phase 1: Entity resolution (greedy multi-word span matching)
    const entityResult = await this.resolveEntities(queryWords, userId);
    const { contacts: resolvedContacts, topicWords, contactIds } = entityResult;
    const hasContacts = resolvedContacts.length > 0;
    const hasTopics = topicWords.length > 0;

    // Phase 2: Vector search (use clean query for embeddings, apply effectiveFilters)
    const vector = await this.ai.embed(embeddingQuery);
    const qdrantFilter = this.buildQdrantFilter(effectiveFilters);
    const qdrantResults = await this.qdrant.search(
      vector,
      effectiveLimit * 5,
      Object.keys(qdrantFilter).length ? qdrantFilter : undefined,
    );
    const semanticScores = new Map<string, number>();
    for (const point of qdrantResults) semanticScores.set(point.id, point.score);

    // Phase 3: Search execution based on decomposition
    const textMatchIds = new Set<string>();
    const contactMatchIds = new Set<string>();
    let topicMatchCount = 0;

    if (hasContacts) {
      // Get all memory IDs linked to resolved contacts
      const linked = await this.dbService.withCurrentUser((db) =>
        db
          .select({ memoryId: memoryContacts.memoryId })
          .from(memoryContacts)
          .where(inArray(memoryContacts.contactId, contactIds)),
      );
      const allContactMemoryIds = new Set(linked.map((r) => r.memoryId));

      if (hasTopics) {
        // Intersect: contact memories filtered by topic words (+ temporal bounds)
        const topicConditions: SQLWrapper[] = [inArray(memoryContacts.contactId, contactIds)];
        for (const tw of topicWords) {
          topicConditions.push(sql`LOWER(${memories.text}) LIKE ${'%' + tw + '%'}`);
        }
        if (effectiveFilters.from)
          topicConditions.push(sql`${memories.eventTime} >= ${effectiveFilters.from}`);
        if (effectiveFilters.to)
          topicConditions.push(sql`${memories.eventTime} <= ${effectiveFilters.to}`);
        const filtered = await this.dbService.withCurrentUser((db) =>
          db
            .select({ memoryId: memoryContacts.memoryId })
            .from(memoryContacts)
            .innerJoin(memories, eq(memories.id, memoryContacts.memoryId))
            .where(and(...topicConditions)!),
        );
        topicMatchCount = filtered.length;
        for (const r of filtered) contactMatchIds.add(r.memoryId);

        // Also boost vector results that belong to the contact — only if topic intersection found matches
        if (topicMatchCount > 0) {
          for (const point of qdrantResults) {
            if (allContactMemoryIds.has(point.id)) contactMatchIds.add(point.id);
          }
        }
      } else {
        // Contact browse: intersect Qdrant results with contact memories
        for (const point of qdrantResults) {
          if (allContactMemoryIds.has(point.id)) contactMatchIds.add(point.id);
        }
        // Add capped recent contact memories for browse feel (respect temporal bounds)
        const contactBrowseConditions: SQLWrapper[] = [
          inArray(memoryContacts.contactId, contactIds),
        ];
        if (effectiveFilters.from)
          contactBrowseConditions.push(sql`${memories.eventTime} >= ${effectiveFilters.from}`);
        if (effectiveFilters.to)
          contactBrowseConditions.push(sql`${memories.eventTime} <= ${effectiveFilters.to}`);
        const recentContactMems = await this.dbService.withCurrentUser((db) =>
          db
            .select({ memoryId: memoryContacts.memoryId })
            .from(memoryContacts)
            .innerJoin(memories, eq(memories.id, memoryContacts.memoryId))
            .where(and(...contactBrowseConditions)!)
            .orderBy(sql`${memories.eventTime} DESC`)
            .limit(effectiveLimit * 3),
        );
        for (const r of recentContactMems) contactMatchIds.add(r.memoryId);
      }
    }

    if (!hasContacts || hasTopics) {
      // Topic text search using PostgreSQL full-text search (tsvector + tsquery)
      const searchWords = hasContacts ? topicWords : queryWords;
      if (searchWords.length > 0) {
        try {
          // Build temporal suffix for FTS queries
          const temporalFrom = effectiveFilters.from
            ? sql` AND event_time >= ${effectiveFilters.from}`
            : sql``;
          const temporalTo = effectiveFilters.to
            ? sql` AND event_time <= ${effectiveFilters.to}`
            : sql``;

          // PostgreSQL tsquery: each word as prefix match with AND logic
          let tsQuery = searchWords.map((w) => `${w}:*`).join(' & ');
          let ftsResults = await this.dbService.withCurrentUser((db) =>
            db.execute(
              sql`SELECT id FROM memories WHERE to_tsvector('english', text) @@ to_tsquery('english', ${tsQuery})${temporalFrom}${temporalTo} LIMIT ${limit * 2}`,
            ),
          );
          // If AND returns nothing and multi-word, retry with OR
          if (ftsResults.rows.length === 0 && searchWords.length > 1) {
            tsQuery = searchWords.map((w) => `${w}:*`).join(' | ');
            ftsResults = await this.dbService.withCurrentUser((db) =>
              db.execute(
                sql`SELECT id FROM memories WHERE to_tsvector('english', text) @@ to_tsquery('english', ${tsQuery})${temporalFrom}${temporalTo} LIMIT ${limit * 2}`,
              ),
            );
          }
          for (const r of ftsResults.rows as { id: string }[]) textMatchIds.add(r.id);
        } catch {
          // Fallback to LIKE if full-text search fails
          const textConditions: SQLWrapper[] = [eq(memories.pipelineComplete, true)];
          for (const word of searchWords) {
            textConditions.push(sql`LOWER(${memories.text}) LIKE ${'%' + word + '%'}`);
          }
          if (effectiveFilters.sourceType)
            textConditions.push(eq(memories.sourceType, effectiveFilters.sourceType));
          if (effectiveFilters.connectorType)
            textConditions.push(eq(memories.connectorType, effectiveFilters.connectorType));
          if (effectiveFilters.from)
            textConditions.push(sql`${memories.eventTime} >= ${effectiveFilters.from}`);
          if (effectiveFilters.to)
            textConditions.push(sql`${memories.eventTime} <= ${effectiveFilters.to}`);
          const textMatches = await this.dbService.withCurrentUser((db) =>
            db
              .select({ id: memories.id })
              .from(memories)
              .where(and(...textConditions)!)
              .limit(limit * 2),
          );
          for (const r of textMatches) textMatchIds.add(r.id);
        }
      }
    }

    const hasExactMatches = textMatchIds.size > 0 || contactMatchIds.size > 0;

    // Collect candidate memory IDs
    const allCandidateIds = new Set<string>();
    for (const id of textMatchIds) allCandidateIds.add(id);
    for (const id of contactMatchIds) allCandidateIds.add(id);
    // Always include all Qdrant results — FTS/contact boosts handle ranking
    for (const point of qdrantResults) allCandidateIds.add(point.id);

    if (!allCandidateIds.size) {
      // If temporal filter caused zero results, fall through to temporal fallback below
      if (!(nlq.temporal && effectiveFilters.from)) {
        return {
          items: [],
          fallback: false,
          resolvedEntities: hasContacts
            ? { contacts: resolvedContacts, topicWords, topicMatchCount }
            : undefined,
          parsed: {
            temporal: nlq.temporal,
            entities: resolvedContacts.map((c) => ({ id: c.id, displayName: c.displayName })),
            intent: nlq.intent,
            cleanQuery: nlq.cleanQuery,
            sourceType: nlq.sourceTypeHint ?? undefined,
          },
        };
      }
    }

    // Batch fetch all candidate rows in one query
    const candidateRows: Array<{
      id: string;
      row: { memory: typeof memories.$inferSelect; accountIdentifier: string | null };
    }> = [];
    const batchRows = await this.fetchMemoryRowsBatch([...allCandidateIds]);
    for (const [id, row] of batchRows) {
      const mem = row.memory;
      if (effectiveFilters.sourceType && mem.sourceType !== effectiveFilters.sourceType) continue;
      if (effectiveFilters.connectorType && mem.connectorType !== effectiveFilters.connectorType)
        continue;
      // Apply temporal filters in SQL-fetched rows
      if (effectiveFilters.from && mem.eventTime < new Date(effectiveFilters.from)) continue;
      if (effectiveFilters.to && mem.eventTime > new Date(effectiveFilters.to)) continue;
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
        const rerankTexts = rerankCandidates.map((c) => c.row.memory.text);
        const scores = await this.ai.rerank(query, rerankTexts);
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
      const textMultiplier = textMatchIds.has(id) ? 1.3 : 1.0;
      const contactMultiplier = contactMatchIds.has(id) ? 1.25 : 1.0;

      const { score, weights } = this.computeWeights(
        semanticScore,
        rerankScore,
        row.memory,
        nlq.intent,
      );
      const boostedScore = Math.min(score * textMultiplier * contactMultiplier, 1.0);
      const boostedWeights = { ...weights, final: boostedScore };

      results.push(this.toSearchResult(row, boostedScore, boostedWeights, userId, resolvedKey));
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
      const fallbackQdrantResults = await this.qdrant.search(
        vector,
        effectiveLimit * 2,
        Object.keys(fallbackQdrantFilter).length ? fallbackQdrantFilter : undefined,
      );
      const fallbackIds = new Set(fallbackQdrantResults.map((p) => p.id));
      const fallbackBatch = await this.fetchMemoryRowsBatch([...fallbackIds]);
      const fallbackScores = new Map<string, number>();
      for (const p of fallbackQdrantResults) fallbackScores.set(p.id, p.score);
      const fallbackResults: SearchResult[] = [];
      for (const [fid, frow] of fallbackBatch) {
        if (fallbackFilters.sourceType && frow.memory.sourceType !== fallbackFilters.sourceType)
          continue;
        if (
          fallbackFilters.connectorType &&
          frow.memory.connectorType !== fallbackFilters.connectorType
        )
          continue;
        const { score, weights } = this.computeWeights(
          fallbackScores.get(fid) ?? 0,
          0,
          frow.memory,
          nlq.intent,
        );
        fallbackResults.push(this.toSearchResult(frow, score, weights, userId, resolvedKey));
      }
      returnItems = fallbackResults
        .filter((r) => r.score >= MIN_SCORE)
        .sort((a, b) => b.score - a.score)
        .slice(0, effectiveLimit);
      temporalFallback = true;
    }

    // Fire afterSearch hook (fire-and-forget)
    void this.pluginRegistry.fireHook('afterSearch', {
      query,
      resultCount: returnItems.length,
      topScore: returnItems[0]?.score,
    });

    return {
      items: returnItems,
      fallback: !hasExactMatches,
      resolvedEntities: hasContacts
        ? { contacts: resolvedContacts, topicWords, topicMatchCount }
        : undefined,
      parsed: {
        temporal: nlq.temporal,
        temporalFallback,
        entities: resolvedContacts.map((c) => ({ id: c.id, displayName: c.displayName })),
        intent: nlq.intent,
        cleanQuery: nlq.cleanQuery,
        sourceType: nlq.sourceTypeHint ?? undefined,
      },
    };
  }

  private async fetchMemoryRow(id: string) {
    const rows = await this.dbService.withCurrentUser((db) =>
      db
        .select({ memory: memories, accountIdentifier: accounts.identifier })
        .from(memories)
        .leftJoin(accounts, eq(memories.accountId, accounts.id))
        .where(and(eq(memories.id, id), eq(memories.pipelineComplete, true))),
    );
    return rows.length ? rows[0] : null;
  }

  private async fetchMemoryRowsBatch(
    ids: string[],
  ): Promise<
    Map<string, { memory: typeof memories.$inferSelect; accountIdentifier: string | null }>
  > {
    const result = new Map<
      string,
      { memory: typeof memories.$inferSelect; accountIdentifier: string | null }
    >();
    if (!ids.length) return result;
    // Batch in chunks to avoid overly large IN clauses
    for (let i = 0; i < ids.length; i += 500) {
      const batch = ids.slice(i, i + 500);
      const rows = await this.dbService.withCurrentUser((db) =>
        db
          .select({ memory: memories, accountIdentifier: accounts.identifier })
          .from(memories)
          .leftJoin(accounts, eq(memories.accountId, accounts.id))
          .where(and(inArray(memories.id, batch), eq(memories.pipelineComplete, true))),
      );
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
    userId?: string | null,
    resolvedKey?: Buffer | null,
  ): SearchResult {
    const mem = this.decryptMemoryAuto(row.memory, userId, resolvedKey);
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

  async getById(id: string, userId?: string | null) {
    const rows = await this.dbService.withCurrentUser((db) =>
      db.select().from(memories).where(eq(memories.id, id)),
    );
    if (!rows.length) return null;
    const resolvedKey = await this.resolveUserKey(userId);
    return this.decryptMemoryAuto(rows[0], userId, resolvedKey);
  }

  async list(
    params: {
      limit?: number;
      offset?: number;
      connectorType?: string;
      sourceType?: string;
      sortBy?: 'eventTime' | 'ingestTime';
      userId?: string;
      memoryBankId?: string;
      memoryBankIds?: string[];
    } = {},
  ) {
    const limit = params.limit || 50;
    const offset = params.offset || 0;
    const sortCol = params.sortBy === 'ingestTime' ? memories.ingestTime : memories.eventTime;

    // User isolation
    const userAccountIds = await this.getUserAccountIds(params.userId);

    const conditions: SQLWrapper[] = [eq(memories.pipelineComplete, true)];
    if (userAccountIds !== null) {
      if (userAccountIds.length === 0) return { items: [], total: 0 };
      conditions.push(inArray(memories.accountId, userAccountIds));
    }
    if (params.connectorType) {
      conditions.push(eq(memories.connectorType, params.connectorType));
    }
    if (params.sourceType) {
      conditions.push(eq(memories.sourceType, params.sourceType));
    }
    if (params.memoryBankId) {
      conditions.push(eq(memories.memoryBankId, params.memoryBankId));
    } else if (params.memoryBankIds?.length) {
      conditions.push(inArray(memories.memoryBankId, params.memoryBankIds));
    }

    const where = conditions.length > 0 ? and(...conditions)! : undefined;

    const totalRows = await this.dbService.withCurrentUser((db) =>
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(memories)
        .where(where),
    );
    const total = totalRows[0]?.count || 0;

    const rows = await this.dbService.withCurrentUser((db) =>
      db
        .select({ memory: memories, accountIdentifier: accounts.identifier })
        .from(memories)
        .leftJoin(accounts, eq(memories.accountId, accounts.id))
        .where(where)
        .orderBy(sql`${sortCol} DESC`)
        .limit(limit)
        .offset(offset),
    );
    const listKey = await this.resolveUserKey(params.userId);
    const items = rows.map((r) => ({
      ...this.decryptMemoryAuto(r.memory, params.userId, listKey),
      accountIdentifier: r.accountIdentifier,
    }));

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
    const now = new Date();

    await this.dbService.withCurrentUser((db) =>
      db.insert(memories).values({
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
      }),
    );

    return {
      id,
      text: data.text,
      sourceType: data.sourceType,
      connectorType: data.connectorType,
      eventTime: now,
      createdAt: now,
    };
  }

  async delete(id: string) {
    await this.dbService.withCurrentUser(async (db) => {
      await db.transaction(async (tx) => {
        await tx.delete(memoryContacts).where(eq(memoryContacts.memoryId, id));
        await tx
          .delete(memoryLinks)
          .where(or(eq(memoryLinks.srcMemoryId, id), eq(memoryLinks.dstMemoryId, id)));
        await tx.delete(memories).where(eq(memories.id, id));
      });
    });
    try {
      await this.qdrant.remove(id);
    } catch {
      // Qdrant removal is best-effort
    }
  }

  async getStats(userId?: string, memoryBankIds?: string[]) {
    const userAccountIds = await this.getUserAccountIds(userId);
    const conditions: SQLWrapper[] = [eq(memories.pipelineComplete, true)];
    // User isolation
    if (userAccountIds !== null) {
      if (userAccountIds.length === 0)
        return { total: 0, bySource: {}, byConnector: {}, byFactuality: {} };
      conditions.push(inArray(memories.accountId, userAccountIds));
    }
    // Memory bank scoping for stats — if memoryBankIds provided (API key), filter by those banks
    if (memoryBankIds?.length) {
      conditions.push(inArray(memories.memoryBankId, memoryBankIds));
    }
    const doneFilter = and(...conditions)!;

    const totalRows = await this.dbService.withCurrentUser((db) =>
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(memories)
        .where(doneFilter),
    );
    const total = totalRows[0]?.count || 0;

    const sourceRows = await this.dbService.withCurrentUser((db) =>
      db
        .select({ key: memories.sourceType, count: sql<number>`COUNT(*)` })
        .from(memories)
        .where(doneFilter)
        .groupBy(memories.sourceType),
    );
    const bySource: Record<string, number> = {};
    for (const r of sourceRows) bySource[r.key] = r.count;

    const connectorRows = await this.dbService.withCurrentUser((db) =>
      db
        .select({ key: memories.connectorType, count: sql<number>`COUNT(*)` })
        .from(memories)
        .where(doneFilter)
        .groupBy(memories.connectorType),
    );
    const byConnector: Record<string, number> = {};
    for (const r of connectorRows) byConnector[r.key] = r.count;

    // Factuality is stored as JSON, extract label with json_extract
    const factRows = await this.dbService.withCurrentUser((db) =>
      db
        .select({
          label: sql<string>`(${memories.factuality}->>'label')::text`,
          count: sql<number>`COUNT(*)`,
        })
        .from(memories)
        .where(doneFilter)
        .groupBy(sql`(${memories.factuality}->>'label')::text`),
    );
    const byFactuality: Record<string, number> = {};
    for (const r of factRows) {
      if (r.label) byFactuality[r.label] = r.count;
    }

    return { total, bySource, byConnector, byFactuality };
  }

  async getGraphData(
    limit = 500,
    _linkLimit = 2000,
    userId?: string,
    memoryBankId?: string,
    memoryBankIds?: string[],
    filterMemoryIds?: string[],
  ) {
    const userAccountIds = await this.getUserAccountIds(userId);

    // Build memory bank + user isolation filter conditions
    const memoryBankConditions: SQLWrapper[] = [eq(memories.pipelineComplete, true)];
    if (userAccountIds !== null) {
      if (userAccountIds.length === 0) return { nodes: [], links: [] };
      memoryBankConditions.push(inArray(memories.accountId, userAccountIds));
    }
    if (memoryBankId) {
      memoryBankConditions.push(eq(memories.memoryBankId, memoryBankId));
    } else if (memoryBankIds?.length) {
      memoryBankConditions.push(inArray(memories.memoryBankId, memoryBankIds));
    }
    const memoryBankFilter = and(...memoryBankConditions)!;

    // Fetch memories — either specific IDs (search) or recent (preview)
    const recentMemories = filterMemoryIds?.length
      ? await (async () => {
          const rows: Array<typeof memories.$inferSelect> = [];
          for (let i = 0; i < filterMemoryIds.length; i += 500) {
            const batch = filterMemoryIds.slice(i, i + 500);
            const r = await this.dbService.withCurrentUser((db) =>
              db
                .select()
                .from(memories)
                .where(and(memoryBankFilter, inArray(memories.id, batch))),
            );
            rows.push(...r);
          }
          return rows;
        })()
      : await this.dbService.withCurrentUser((db) =>
          db
            .select()
            .from(memories)
            .where(memoryBankFilter)
            .orderBy(sql`${memories.eventTime} DESC`)
            .limit(limit),
        );

    const memoryIds = new Set(recentMemories.map((m) => m.id));

    // Fetch links only for user's memories (batched)
    const memoryIdList = [...memoryIds];
    const allLinks: Array<typeof memoryLinks.$inferSelect> = [];
    for (let i = 0; i < memoryIdList.length; i += 500) {
      const batch = memoryIdList.slice(i, i + 500);
      const srcLinks = await this.dbService.withCurrentUser((db) =>
        db.select().from(memoryLinks).where(inArray(memoryLinks.srcMemoryId, batch)),
      );
      allLinks.push(...srcLinks);
    }

    // Add linked memories not already in the set (only if user-owned and done)
    const linkedIdSet = new Set<string>();
    for (const link of allLinks) {
      if (!memoryIds.has(link.dstMemoryId)) linkedIdSet.add(link.dstMemoryId);
    }
    const missingLinkedIds = [...linkedIdSet];
    const linkedMemories: Array<(typeof recentMemories)[0]> = [];
    for (let i = 0; i < missingLinkedIds.length; i += 100) {
      const batch = missingLinkedIds.slice(i, i + 100);
      if (!batch.length) break;
      // Apply user isolation to linked memories too
      const linkedConditions: SQLWrapper[] = [
        inArray(memories.id, batch),
        eq(memories.pipelineComplete, true),
      ];
      if (userAccountIds !== null && userAccountIds.length > 0) {
        linkedConditions.push(inArray(memories.accountId, userAccountIds));
      }
      const rows = await this.dbService.withCurrentUser((db) =>
        db
          .select()
          .from(memories)
          .where(and(...linkedConditions)),
      );
      linkedMemories.push(...rows);
    }

    const allMemories = [...recentMemories, ...linkedMemories];
    for (const m of linkedMemories) memoryIds.add(m.id);

    const relevantLinks = allLinks.filter(
      (l) => memoryIds.has(l.srcMemoryId) && memoryIds.has(l.dstMemoryId),
    );

    // Fetch contacts and identifiers — scope to user's memories only
    const memoryIdArray = [...memoryIds];
    const allMemoryContacts: Array<typeof memoryContacts.$inferSelect> = [];
    for (let i = 0; i < memoryIdArray.length; i += 500) {
      const batch = memoryIdArray.slice(i, i + 500);
      const rows = await this.dbService.withCurrentUser((db) =>
        db.select().from(memoryContacts).where(inArray(memoryContacts.memoryId, batch)),
      );
      allMemoryContacts.push(...rows);
    }
    const relevantMemoryContacts = allMemoryContacts;

    const relevantContactIdSet = new Set(relevantMemoryContacts.map((mc) => mc.contactId));

    // Always include self-contact in the graph
    const selfRow = await this.dbService.withCurrentUser((db) =>
      db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, 'selfContactId'))
        .limit(1),
    );
    const selfContactId = selfRow[0]?.value;
    if (selfContactId) {
      relevantContactIdSet.add(selfContactId);
      // Add all self-contact memory links as edges (even if memory isn't in graph slice)
      const selfLinks = allMemoryContacts.filter(
        (mc) => mc.contactId === selfContactId && memoryIds.has(mc.memoryId),
      );
      for (const sl of selfLinks) {
        if (
          !relevantMemoryContacts.some(
            (mc) => mc.memoryId === sl.memoryId && mc.contactId === sl.contactId,
          )
        ) {
          relevantMemoryContacts.push(sl);
        }
      }
    }

    const contactIdArray = [...relevantContactIdSet];
    const relevantContacts: Array<typeof contacts.$inferSelect> = [];
    for (let i = 0; i < contactIdArray.length; i += 500) {
      const batch = contactIdArray.slice(i, i + 500);
      const rows = await this.dbService.withCurrentUser((db) =>
        db.select().from(contacts).where(inArray(contacts.id, batch)),
      );
      relevantContacts.push(...rows);
    }

    const relevantIdentifiers: Array<typeof contactIdentifiers.$inferSelect> = [];
    for (let i = 0; i < contactIdArray.length; i += 500) {
      const batch = contactIdArray.slice(i, i + 500);
      const rows = await this.dbService.withCurrentUser((db) =>
        db.select().from(contactIdentifiers).where(inArray(contactIdentifiers.contactId, batch)),
      );
      relevantIdentifiers.push(...rows);
    }

    // Build entity → cluster mapping
    const entityClusters = new Map<string, number>();
    let nextCluster = 0;

    const graphKey = await this.resolveUserKey(userId);
    const memoryNodes = allMemories.map((raw) => {
      const m = this.decryptMemoryAuto(raw, userId, graphKey);
      let entities: Array<{ type?: string; value?: string; name?: string }> = [];
      try {
        entities = JSON.parse(m.entities);
      } catch {
        /* empty */
      }

      const fact = m.factuality as Record<string, unknown> | null;
      const factLabel = fact?.label || 'UNVERIFIED';

      const dominantEntity = entities.find(
        (e) => (e.type === 'person' || e.type === 'organization') && e.value,
      );
      let cluster = 0;
      if (dominantEntity) {
        const key = String(dominantEntity.value).toLowerCase();
        if (!entityClusters.has(key)) entityClusters.set(key, nextCluster++);
        cluster = entityClusters.get(key)!;
      }

      const trust = this.getTrustScore(m.connectorType);
      const importance = Math.min(0.3 + entities.length * 0.1 + trust * 0.3, 1.0);
      const entityNames = entities
        .map((e) => e.value || '')
        .filter(Boolean)
        .slice(0, 5);

      const weights: Record<string, number> = (m.weights as Record<string, number>) || {};

      let metadata: Record<string, unknown> = {};
      try {
        metadata = JSON.parse(m.metadata);
      } catch {
        /* empty */
      }

      // Build thumbnail data URL for photo nodes (avoids per-node HTTP requests)
      const thumbnailDataUrl =
        m.sourceType === 'photo' && metadata.thumbnailBase64
          ? `data:image/jpeg;base64,${metadata.thumbnailBase64}`
          : undefined;

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
        thumbnailDataUrl,
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

      const entityType = c.entityType || 'person';
      const nodeType =
        entityType === 'group'
          ? ('group' as const)
          : entityType === 'device'
            ? ('device' as const)
            : ('contact' as const);

      const avatars = (c.avatars as Array<{ url: string; source: string }>) || [];
      const preferredIdx = c.preferredAvatarIndex ?? 0;
      const preferred = avatars[preferredIdx] ?? avatars[0];
      // Use data URI directly if available, fall back to proxy for legacy URL-based avatars
      const avatarUrl = preferred
        ? preferred.url.startsWith('data:')
          ? preferred.url
          : `/api/people/${c.id}/avatar`
        : undefined;

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
        avatarUrl,
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

    // Build file/attachment nodes from memories in the current graph slice.
    // Extract from already-decrypted allMemories to avoid json_extract on encrypted metadata.
    const fileCounts = new Map<
      string,
      { count: number; mimeType: string; connectorType: string }
    >();
    for (const raw of allMemories) {
      const m = this.decryptMemoryAuto(raw, userId, graphKey);
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(m.metadata);
      } catch {
        continue;
      }
      const atts = meta.attachments as Array<{ filename?: string; mimeType?: string }> | undefined;
      if (!atts) continue;
      for (const att of atts) {
        const name = att.filename;
        if (!name) continue;
        const existing = fileCounts.get(name);
        if (existing) {
          existing.count++;
        } else {
          fileCounts.set(name, {
            count: 1,
            mimeType: att.mimeType || 'unknown',
            connectorType: m.connectorType,
          });
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
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(this.crypto.decrypt(m.metadata) ?? m.metadata);
      } catch {
        continue;
      }
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
    const [rawMem] = await this.dbService.withCurrentUser((db) =>
      db.select().from(memories).where(eq(memories.id, memoryId)),
    );
    if (!rawMem || !rawMem.pipelineComplete) return null;
    // buildGraphDelta is a WS fire-and-forget with no userId context; use auto-detect
    const mem = this.decryptMemoryAuto(rawMem);

    let entities: Array<{ type?: string; value?: string; name?: string }> = [];
    try {
      entities = JSON.parse(mem.entities);
    } catch {
      /* empty */
    }
    const fact = mem.factuality as Record<string, unknown> | null;
    const factLabel = fact?.label || 'UNVERIFIED';
    const weights: Record<string, number> = (mem.weights as Record<string, number>) || {};
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(mem.metadata);
    } catch {
      /* empty */
    }

    const trust = this.getTrustScore(mem.connectorType);
    const importance = Math.min(0.3 + entities.length * 0.1 + trust * 0.3, 1.0);
    const entityNames = entities
      .map((e) => e.value || '')
      .filter(Boolean)
      .slice(0, 5);

    const thumbnailDataUrl =
      mem.sourceType === 'photo' && metadata.thumbnailBase64
        ? `data:image/jpeg;base64,${metadata.thumbnailBase64}`
        : undefined;

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
      thumbnailDataUrl,
    };

    // Links from/to this memory
    const links = await this.dbService.withCurrentUser((db) =>
      db
        .select()
        .from(memoryLinks)
        .where(
          sql`${memoryLinks.srcMemoryId} = ${memoryId} OR ${memoryLinks.dstMemoryId} = ${memoryId}`,
        ),
    );
    const graphLinks = links.map((l) => ({
      source: l.srcMemoryId,
      target: l.dstMemoryId,
      type: l.linkType,
      strength: l.strength,
    }));

    // Contact associations
    const mcRows = await this.dbService.withCurrentUser((db) =>
      db.select().from(memoryContacts).where(eq(memoryContacts.memoryId, memoryId)),
    );
    const contactIds = mcRows.map((mc) => mc.contactId);
    const contactNodes: Array<Record<string, unknown>> = [];
    const contactEdges = mcRows.map((mc) => ({
      source: `contact-${mc.contactId}`,
      target: memoryId,
      type: mc.role || 'involves',
      strength: mc.role === 'group' ? 0.9 : 0.7,
    }));

    if (contactIds.length) {
      const contactRows = await this.dbService.withCurrentUser((db) =>
        db.select().from(contacts).where(inArray(contacts.id, contactIds)),
      );
      const identRows = await this.dbService.withCurrentUser((db) =>
        db
          .select()
          .from(contactIdentifiers)
          .where(inArray(contactIdentifiers.contactId, contactIds)),
      );
      const identByContact = new Map<string, string[]>();
      for (const i of identRows) {
        const list = identByContact.get(i.contactId) || [];
        list.push(i.connectorType || 'unknown');
        identByContact.set(i.contactId, list);
      }
      for (const c of contactRows) {
        const connectors = [...new Set(identByContact.get(c.id) || [])];
        const entityType = c.entityType || 'person';
        const nodeType =
          entityType === 'group'
            ? ('group' as const)
            : entityType === 'device'
              ? ('device' as const)
              : ('contact' as const);
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

  private computeWeights(
    semanticScore: number,
    rerankScore: number,
    mem: {
      pinned: boolean | null;
      recallCount: number | null;
      eventTime: Date;
      entities: string;
      text: string;
      connectorType: string;
    },
    intent?: 'recall' | 'browse' | 'find',
  ): {
    score: number;
    weights: {
      semantic: number;
      rerank: number;
      recency: number;
      importance: number;
      trust: number;
      final: number;
    };
  } {
    const isPinned = !!mem.pinned;
    const recallCount = mem.recallCount || 0;

    const ageDays = (Date.now() - new Date(mem.eventTime).getTime()) / (1000 * 60 * 60 * 24);
    // Pinned memories are exempt from recency decay
    const recency = isPinned ? 1.0 : Math.exp(-0.005 * ageDays);

    let entityCount = 0;
    try {
      entityCount = JSON.parse(mem.entities).length;
    } catch {
      /* empty */
    }
    // Importance: base + entity boost + text length signal + recall boost
    let importance = 0.3;
    importance += Math.min(entityCount * 0.1, 0.3);
    const textLen = (mem.text || '').length;
    if (textLen > 500) importance += 0.15;
    else if (textLen > 200) importance += 0.1;
    else if (textLen > 50) importance += 0.05;
    importance += Math.min(recallCount * 0.02, 0.2);
    importance = Math.min(importance, 1.0);
    const trust = this.getTrustScore(mem.connectorType);

    // Per-connector weight scaling (photos=lower semantic, locations=higher recency)
    const connectorWeights = this.getWeights(mem.connectorType);
    const semScale = connectorWeights.semantic / 0.4;
    const recScale = connectorWeights.recency / 0.25;

    // When reranker is available, use the full 5-weight formula.
    // When unavailable (rerankScore === 0), redistribute rerank weight to semantic.
    // Browse intent boosts recency weight significantly.
    let final: number;
    if (intent === 'browse') {
      final =
        rerankScore > 0
          ? Math.min(0.25 * semScale, 0.5) * semanticScore +
            0.2 * rerankScore +
            Math.min(0.4 * recScale, 0.6) * recency +
            0.1 * importance +
            0.05 * trust
          : Math.min(0.4 * semScale, 0.6) * semanticScore +
            Math.min(0.4 * recScale, 0.6) * recency +
            0.15 * importance +
            0.05 * trust;
    } else {
      final =
        rerankScore > 0
          ? Math.min(0.4 * semScale, 0.7) * semanticScore +
            0.3 * rerankScore +
            Math.min(0.15 * recScale, 0.4) * recency +
            0.1 * importance +
            0.05 * trust
          : Math.min(0.7 * semScale, 0.85) * semanticScore +
            Math.min(0.15 * recScale, 0.4) * recency +
            0.1 * importance +
            0.05 * trust;
    }

    // Scorer plugin bonus (clamped to +/-0.05, averaged across plugins)
    const scorers = this.pluginRegistry.getScorers();
    if (scorers.length > 0) {
      let pluginBonus = 0;
      for (const scorer of scorers) {
        try {
          pluginBonus += scorer.score(mem, {
            semantic: semanticScore,
            rerank: rerankScore,
            recency,
            importance,
            trust,
          });
        } catch {
          /* ignore */
        }
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
    userId?: string;
    memoryBankId?: string;
    memoryBankIds?: string[];
  }) {
    const limit = params.limit || 50;
    const userAccountIds = await this.getUserAccountIds(params.userId);
    const conditions: SQLWrapper[] = [eq(memories.pipelineComplete, true)];
    if (userAccountIds !== null) {
      if (userAccountIds.length === 0) return [];
      conditions.push(inArray(memories.accountId, userAccountIds));
    }
    if (params.memoryBankId) {
      conditions.push(eq(memories.memoryBankId, params.memoryBankId));
    } else if (params.memoryBankIds?.length) {
      conditions.push(inArray(memories.memoryBankId, params.memoryBankIds));
    }

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
      const words = params.query
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length >= 2);
      for (const word of words) {
        conditions.push(sql`LOWER(${memories.text}) LIKE ${'%' + word + '%'}`);
      }
    }

    const totalRows = await this.dbService.withCurrentUser((db) =>
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(memories)
        .where(and(...conditions)!),
    );
    const total = totalRows[0]?.count || 0;

    const rows = await this.dbService.withCurrentUser((db) =>
      db
        .select({ memory: memories, accountIdentifier: accounts.identifier })
        .from(memories)
        .leftJoin(accounts, eq(memories.accountId, accounts.id))
        .where(and(...conditions)!)
        .orderBy(sql`${memories.eventTime} ASC`)
        .limit(limit),
    );

    const timelineKey = await this.resolveUserKey(params.userId);
    const items = rows.map((r) => ({
      ...this.decryptMemoryAuto(r.memory, params.userId, timelineKey),
      accountIdentifier: r.accountIdentifier,
    }));
    return { items, total };
  }

  /** Phase 9: Get memories related to a given memory (via links + vector similarity) */
  async getRelated(memoryId: string, limit = 20) {
    const memory = await this.getById(memoryId);
    if (!memory) return { items: [], source: null };

    // 1. Direct graph links (memoryLinks table)
    const linkedIds = new Set<string>();
    const outLinks = await this.dbService.withCurrentUser((db) =>
      db.select().from(memoryLinks).where(eq(memoryLinks.srcMemoryId, memoryId)),
    );
    const inLinks = await this.dbService.withCurrentUser((db) =>
      db.select().from(memoryLinks).where(eq(memoryLinks.dstMemoryId, memoryId)),
    );
    for (const l of [...outLinks, ...inLinks]) {
      linkedIds.add(l.srcMemoryId === memoryId ? l.dstMemoryId : l.srcMemoryId);
    }

    // 2. Vector similarity (Qdrant recommend)
    const recommended = await this.qdrant.recommend(memoryId, limit);
    for (const r of recommended) linkedIds.add(r.id);

    // 3. Same-contact memories (shared participants)
    const contactLinks = await this.dbService.withCurrentUser((db) =>
      db
        .select({ contactId: memoryContacts.contactId })
        .from(memoryContacts)
        .where(eq(memoryContacts.memoryId, memoryId)),
    );
    const contactIdList = contactLinks.map((c) => c.contactId);

    if (contactIdList.length > 0) {
      const coMemories = await this.dbService.withCurrentUser((db) =>
        db
          .select({ memoryId: memoryContacts.memoryId })
          .from(memoryContacts)
          .where(inArray(memoryContacts.contactId, contactIdList))
          .limit(limit * 2),
      );
      for (const cm of coMemories) {
        if (cm.memoryId !== memoryId) linkedIds.add(cm.memoryId);
      }
    }

    // Fetch and score all related
    linkedIds.delete(memoryId);
    const relatedIds = [...linkedIds].slice(0, limit * 2);
    const items: Array<Record<string, unknown>> = [];

    for (const id of relatedIds) {
      const row = await this.fetchMemoryRow(id);
      if (!row) continue;
      const mem = row.memory;

      // Score by: graph link > vector similarity > contact co-occurrence
      const graphLink =
        outLinks.some((l) => l.dstMemoryId === id) || inLinks.some((l) => l.srcMemoryId === id);
      const vectorScore = recommended.find((r) => r.id === id)?.score ?? 0;
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

    items.sort((a, b) => (b.score as number) - (a.score as number));
    return { items: items.slice(0, limit), source: memory };
  }

  /** Canonical entity types */
  getEntityTypes(): string[] {
    return [
      'person',
      'organization',
      'location',
      'event',
      'product',
      'topic',
      'pet',
      'group',
      'device',
      'other',
    ];
  }

  /** Phase 10: Search entities across all memories */
  async searchEntities(query: string, limit = 50, types?: string[]) {
    const queryLower = query.toLowerCase();

    // Search in entities JSON column
    const rows = await this.dbService.withCurrentUser((db) =>
      db
        .select({
          id: memories.id,
          entities: memories.entities,
          connectorType: memories.connectorType,
          sourceType: memories.sourceType,
          eventTime: memories.eventTime,
        })
        .from(memories)
        .where(
          and(
            eq(memories.pipelineComplete, true),
            sql`LOWER(${memories.entities}) LIKE ${'%' + queryLower + '%'}`,
          ),
        )
        .limit(limit * 5),
    );

    // Extract and aggregate matching entities
    const entityMap = new Map<
      string,
      {
        value: string;
        type: string;
        memoryCount: number;
        memoryIds: string[];
        connectors: Set<string>;
      }
    >();

    for (const row of rows) {
      let entities: Array<{ type?: string; value?: string; name?: string }> = [];
      try {
        entities = JSON.parse(row.entities);
      } catch {
        continue;
      }

      for (const e of entities) {
        const value = e.value || e.name || (e as Record<string, unknown>).id;
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
      const typeSet = new Set(types.map((t) => t.toLowerCase()));
      entries = entries.filter((e) => typeSet.has(e.type.toLowerCase()));
    }

    const entities = entries
      .map((e) => ({ ...e, connectors: [...e.connectors] }))
      .sort((a, b) => b.memoryCount - a.memoryCount)
      .slice(0, limit);

    return { entities, total: entities.length };
  }

  /** Phase 10: Get entity details with related memories and co-occurring entities */
  async getEntityGraph(entityValue: string, limit = 30) {
    const queryLower = entityValue.toLowerCase();

    // Find memories containing this entity
    const rows = await this.dbService.withCurrentUser((db) =>
      db
        .select({
          id: memories.id,
          text: memories.text,
          entities: memories.entities,
          connectorType: memories.connectorType,
          sourceType: memories.sourceType,
          eventTime: memories.eventTime,
        })
        .from(memories)
        .where(
          and(
            eq(memories.pipelineComplete, true),
            sql`LOWER(${memories.entities}) LIKE ${'%' + queryLower + '%'}`,
          ),
        )
        .orderBy(sql`${memories.eventTime} DESC`)
        .limit(limit),
    );

    // Collect co-occurring entities
    const coEntities = new Map<string, { value: string; type: string; count: number }>();
    const memoryItems = rows.map((row) => {
      let entities: Array<{ type?: string; value?: string; name?: string }> = [];
      try {
        entities = JSON.parse(row.entities);
      } catch {
        /* empty */
      }

      for (const e of entities) {
        const val = e.value || e.name || (e as Record<string, unknown>).id;
        if (!val) continue;
        const key = `${e.type}:${String(val).toLowerCase()}`;
        if (String(val).toLowerCase() === queryLower) continue;
        const existing = coEntities.get(key);
        if (existing) {
          existing.count++;
        } else {
          coEntities.set(key, { value: String(val), type: e.type || 'unknown', count: 1 });
        }
      }

      return {
        id: row.id,
        text: row.text.slice(0, 200),
        sourceType: row.sourceType,
        connectorType: row.connectorType,
        eventTime: row.eventTime,
      };
    });

    const relatedEntities = [...coEntities.values()].sort((a, b) => b.count - a.count).slice(0, 20);

    // Also check contacts matching this entity
    const matchingContacts = await this.dbService.withCurrentUser((db) =>
      db
        .select({ id: contacts.id, displayName: contacts.displayName })
        .from(contacts)
        .where(sql`LOWER(${contacts.displayName}) LIKE ${'%' + queryLower + '%'}`)
        .limit(10),
    );

    return {
      entity: entityValue,
      memories: memoryItems,
      relatedEntities,
      contacts: matchingContacts,
      memoryCount: memoryItems.length,
    };
  }

  private buildQdrantFilter(filters: SearchFilters): Record<string, unknown> {
    const must: Array<Record<string, unknown>> = [];

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
    // User scoping — filter by memory_bank_id if present in Qdrant payload
    if (filters.memoryBankId) {
      must.push({ key: 'memory_bank_id', match: { value: filters.memoryBankId } });
    } else if (filters.memoryBankIds?.length) {
      // API key scoped to specific memory banks
      must.push({ key: 'memory_bank_id', match: { any: filters.memoryBankIds } });
    }
    // User isolation — filter by account_id
    if (filters.accountIds?.length) {
      must.push({ key: 'account_id', match: { any: filters.accountIds } });
    }

    return must.length ? { must } : {};
  }
}

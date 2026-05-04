import { Injectable, Logger } from '@nestjs/common';
import { eq, sql, and, desc, inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { DbService } from '../db/db.service';
import { MemoryService } from '../memory/memory.service';
import { AiService } from '../memory/ai.service';
import { PgSearchService } from '../memory/pg-search.service';
import { PeopleService, PersonWithIdentifiers } from '../people/people.service';
import { ConfigService } from '../config/config.service';
import { memories, people, memoryPeople } from '../db/schema';

// ── Helpers ──────────────────────────────────────────────────────────

function safeParse<T>(json: string | unknown | null | undefined, fallback: T): T {
  if (json == null) return fallback;
  if (typeof json !== 'string') return json as T;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

function relativeTime(d: Date | string): string {
  const diff = Date.now() - new Date(d).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

function inferBroadQueryWindow(query: string): { from?: string; to?: string } | null {
  const lower = query.toLowerCase();
  const now = new Date();
  const broadIntent =
    /\b(what happened|life|activity|digest|summary|summarize|recap|overview|recently|lately)\b/.test(
      lower,
    );
  const days =
    lower.match(/\blast\s+(\d+)\s+(day|days)\b/)?.[1] ??
    lower.match(/\bover\s+the\s+last\s+(\d+)\s+(day|days)\b/)?.[1];
  const weeks =
    lower.match(/\blast\s+(\d+)\s+(week|weeks)\b/)?.[1] ??
    lower.match(/\bover\s+the\s+last\s+(\d+)\s+(week|weeks)\b/)?.[1];
  const inferredDays = days ? Number(days) : weeks ? Number(weeks) * 7 : null;
  if (broadIntent && inferredDays) {
    return {
      from: new Date(now.getTime() - inferredDays * 86400000).toISOString(),
      to: now.toISOString(),
    };
  }
  if (broadIntent) {
    return { from: new Date(now.getTime() - 14 * 86400000).toISOString(), to: now.toISOString() };
  }
  return null;
}

export interface EnrichedMemory {
  id: string;
  text: string;
  sourceType: string;
  connectorType: string;
  eventTime: Date;
  eventTimeRelative: string;
  factuality: { label: string; confidence: number; rationale: string };
  entities: Array<{ type: string; value: string }>;
  weights: Record<string, number>;
  metadata: Record<string, unknown>;
  contacts: Array<{ id: string; displayName: string; role: string }>;
  score?: number;
}

// ── Service ──────────────────────────────────────────────────────────

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private dbService: DbService,
    private memoryService: MemoryService,
    private ai: AiService,
    private searchIndex: PgSearchService,
    private peopleService: PeopleService,
    private config: ConfigService,
  ) {}

  // ── ask ────────────────────────────────────────────────────────────

  async ask(
    query: string,
    options?: {
      filters?: {
        sourceType?: string;
        connectorType?: string;
        contactId?: string;
        from?: string;
        to?: string;
        fromMe?: boolean;
      };
      limit?: number;
      userId?: string;
      conversationId?: string;
    },
  ): Promise<{
    results: EnrichedMemory[];
    query: string;
    answer?: string;
    conversationId?: string;
    parsed?: {
      temporal: { from: string; to: string } | null;
      temporalFallback?: boolean;
      intent: string;
      cleanQuery: string;
    };
  }> {
    const limit = options?.limit ?? 20;

    // Try conversation-powered search first
    try {
      if (options?.filters?.fromMe !== undefined) {
        throw new Error('fromMe requires decrypted metadata filtering');
      }
      const vector = await this.ai.embed(query);
      const filter = options?.filters ? this.buildSearchFilter(options.filters) : undefined;
      const result = await this.searchIndex.conversationSearch(
        query,
        vector,
        limit,
        'botmem-chat',
        options?.conversationId,
        filter,
      );

      if (result.conversation?.answer) {
        const enriched = await Promise.all(
          result.results.map((r) => this.enrichMemory(r.id, r.score, options?.userId)),
        );
        const grouped = this.groupByThread(enriched.filter(Boolean) as EnrichedMemory[]);
        return {
          results: grouped,
          query,
          answer: result.conversation.answer,
          conversationId: result.conversation.conversationId,
        };
      }
    } catch (err) {
      this.logger.debug(`Conversation search failed, falling back to regular search: ${err}`);
    }

    const broadWindow = inferBroadQueryWindow(query);
    if (broadWindow && !options?.filters?.contactId) {
      const digest = await this.answerBroadTimelineQuery(query, {
        ...broadWindow,
        ...options?.filters,
        limit: Math.max(limit, 120),
        userId: options?.userId,
      });
      if (digest) return digest;
    }

    let searchResponse: Awaited<ReturnType<MemoryService['search']>>;
    try {
      searchResponse = await this.memoryService.search(
        query,
        options?.filters,
        limit,
        options?.userId,
      );
    } catch (err) {
      this.logger.warn(`Search failed for agent ask, trying timeline digest: ${err}`);
      const digest = await this.answerBroadTimelineQuery(query, {
        ...(broadWindow || {}),
        ...options?.filters,
        limit: Math.max(limit, 120),
        userId: options?.userId,
      });
      if (digest) return digest;
      throw err;
    }

    const enriched = await Promise.all(
      searchResponse.items.map((r) => this.enrichMemory(r.id, r.score, options?.userId)),
    );

    // Group by thread (same sourceId prefix for emails, or same sourceId for conversations)
    const grouped = this.groupByThread(enriched.filter(Boolean) as EnrichedMemory[]);

    return { results: grouped, query, parsed: searchResponse.parsed };
  }

  private async answerBroadTimelineQuery(
    query: string,
    params: {
      from?: string;
      to?: string;
      sourceType?: string;
      connectorType?: string;
      fromMe?: boolean;
      limit: number;
      userId?: string;
    },
  ): Promise<{
    results: EnrichedMemory[];
    query: string;
    answer?: string;
    parsed?: {
      temporal: { from: string; to: string } | null;
      temporalFallback?: boolean;
      intent: string;
      cleanQuery: string;
    };
  } | null> {
    const timeline = await this.memoryService.timeline(params);
    const enriched: EnrichedMemory[] = [];
    for (const item of timeline.items.slice(0, params.limit)) {
      const memory = await this.enrichMemory(item.id, undefined, params.userId);
      if (memory) enriched.push(memory);
    }
    if (!enriched.length) return null;

    const memoryLines = enriched
      .slice(0, 80)
      .map(
        (memory) =>
          `[${memory.eventTime.toISOString()}] [${memory.connectorType}/${memory.sourceType}] ${
            memory.text
          }`,
      )
      .join('\n');
    let answer: string | undefined;
    try {
      answer = await this.ai.generate(
        [
          'Summarize this broad personal-memory timeline for the user.',
          'Use only the provided memories. Prefer chronology, current/latest state, and user-authored actions.',
          'Flag uncertainty instead of inventing missing facts.',
          '',
          `Question: ${query}`,
          '',
          'Timeline:',
          memoryLines,
        ].join('\n'),
      );
    } catch (err) {
      this.logger.warn(`Timeline digest generation failed, returning memories only: ${err}`);
      answer =
        'I found timeline memories for this broad query, but summarization is unavailable. Use the returned results for a narrower follow-up.';
    }

    return {
      results: enriched,
      query,
      answer,
      parsed: {
        temporal: params.from && params.to ? { from: params.from, to: params.to } : null,
        temporalFallback: !params.from || !params.to,
        intent: 'summarize',
        cleanQuery: query,
      },
    };
  }

  // ── timeline ───────────────────────────────────────────────────────

  async timeline(
    options: {
      contactId?: string;
      connectorType?: string;
      sourceType?: string;
      days?: number;
      limit?: number;
      userId?: string;
    } = {},
  ): Promise<{ results: Record<string, EnrichedMemory[]>; totalCount: number }> {
    return this.dbService.withCurrentUser(async (db) => {
      const days = options.days ?? 7;
      const limit = options.limit ?? 100;
      const cutoff = new Date(Date.now() - days * 86400000);

      const conditions = [sql`${memories.eventTime} >= ${cutoff}`];
      if (options.connectorType) {
        conditions.push(eq(memories.connectorType, options.connectorType));
      }
      if (options.sourceType) {
        conditions.push(eq(memories.sourceType, options.sourceType));
      }
      // IDOR fix: scope to user's accounts
      if (options.userId) {
        const userAccountIds = await this.memoryService.getUserAccountIds(options.userId);
        if (userAccountIds !== null) {
          if (userAccountIds.length === 0) return { results: {}, totalCount: 0 };
          conditions.push(inArray(memories.accountId, userAccountIds));
        }
      }

      let memoryIds: Set<string> | null = null;
      if (options.contactId) {
        const rows = await db
          .select({ memoryId: memoryPeople.memoryId })
          .from(memoryPeople)
          .where(eq(memoryPeople.personId, options.contactId));
        memoryIds = new Set(rows.map((r) => r.memoryId));
      }

      const rows = await db
        .select()
        .from(memories)
        .where(and(...conditions))
        .orderBy(desc(memories.eventTime))
        .limit(limit);

      let filtered = rows;
      if (memoryIds) {
        filtered = rows.filter((r) => memoryIds!.has(r.id));
      }

      const enriched: EnrichedMemory[] = [];
      for (const row of filtered) {
        const e = await this.enrichMemory(row.id, undefined, options.userId);
        if (e) enriched.push(e);
      }

      // Group by date
      const grouped: Record<string, EnrichedMemory[]> = {};
      for (const mem of enriched) {
        const dateKey = mem.eventTime.toISOString().slice(0, 10); // YYYY-MM-DD
        if (!grouped[dateKey]) grouped[dateKey] = [];
        grouped[dateKey].push(mem);
      }

      return { results: grouped, totalCount: enriched.length };
    });
  }

  // ── remember ───────────────────────────────────────────────────────

  async remember(
    text: string,
    metadata?: Record<string, unknown>,
    _userId?: string,
  ): Promise<EnrichedMemory> {
    const id = randomUUID();
    const now = new Date();

    await this.dbService.withCurrentUser(async (db) => {
      await db.insert(memories).values({
        id,
        accountId: null,
        connectorType: 'agent',
        sourceType: 'note',
        sourceId: `agent-${id}`,
        text,
        eventTime: now,
        ingestTime: now,
        metadata: JSON.stringify(metadata || {}),
        embeddingStatus: 'pending',
        createdAt: now,
      });
    });

    // Generate embedding immediately
    try {
      const vector = await this.ai.embed(text);
      await this.searchIndex.ensureCollection(vector.length);
      await this.searchIndex.upsert(id, vector, {
        memory_id: id,
        user_id: _userId,
        source_type: 'note',
        connector_type: 'agent',
        event_time: now,
      });
      await this.dbService.withCurrentUser(async (db) => {
        await db.update(memories).set({ embeddingStatus: 'done' }).where(eq(memories.id, id));
      });
    } catch (err) {
      this.logger.warn(`Failed to embed new memory ${id}: ${err}`);
    }

    return (await this.enrichMemory(id, undefined, _userId))!;
  }

  // ── forget ─────────────────────────────────────────────────────────

  async forget(memoryId: string, userId?: string): Promise<{ deleted: boolean }> {
    // IDOR fix: verify memory belongs to user
    const existing = await this.memoryService.getById(memoryId, userId);
    if (!existing) return { deleted: false };

    await this.memoryService.delete(memoryId);
    // Also clean up memory_contacts links
    await this.dbService.withCurrentUser(async (db) => {
      await db.delete(memoryPeople).where(eq(memoryPeople.memoryId, memoryId));
    });

    return { deleted: true };
  }

  // ── context ────────────────────────────────────────────────────────

  async context(
    contactId: string,
    userId?: string,
  ): Promise<{
    contact: PersonWithIdentifiers;
    identifiersByType: Record<string, string[]>;
    recentMemories: EnrichedMemory[];
    stats: {
      totalMemories: number;
      byConnector: Record<string, number>;
      dateRange: { earliest: Date; latest: Date } | null;
    };
  } | null> {
    // IDOR fix: verify contact belongs to user
    const contact = userId
      ? await this.peopleService.getByIdForUser(contactId, userId).catch(() => null)
      : await this.peopleService.getById(contactId);
    if (!contact) return null;

    // Identifiers grouped by type
    const identifiersByType: Record<string, string[]> = {};
    for (const ident of contact.identifiers) {
      if (!identifiersByType[ident.identifierType]) identifiersByType[ident.identifierType] = [];
      identifiersByType[ident.identifierType].push(ident.identifierValue);
    }

    return this.dbService.withCurrentUser(async (db) => {
      // Get all memories for this contact
      const memRows = await db
        .select({ memoryId: memoryPeople.memoryId })
        .from(memoryPeople)
        .where(eq(memoryPeople.personId, contactId));

      const memoryIdSet = memRows.map((r) => r.memoryId);
      const totalMemories = memoryIdSet.length;

      // Fetch recent 50 memories with full data
      const recentRows = memoryIdSet.length
        ? await db
            .select()
            .from(memories)
            .where(
              sql`${memories.id} IN (${sql.join(
                memoryIdSet.map((id) => sql`${id}`),
                sql`, `,
              )})`,
            )
            .orderBy(desc(memories.eventTime))
            .limit(50)
        : [];

      const recentMemories: EnrichedMemory[] = [];
      for (const row of recentRows) {
        const e = await this.enrichMemory(row.id, undefined, userId);
        if (e) recentMemories.push(e);
      }

      // Stats: by connector
      const byConnector: Record<string, number> = {};
      for (const row of recentRows) {
        byConnector[row.connectorType] = (byConnector[row.connectorType] || 0) + 1;
      }

      // If we have more memories than the 50 we fetched, get full connector breakdown
      if (totalMemories > 50 && memoryIdSet.length) {
        const connectorCounts = await db
          .select({
            connectorType: memories.connectorType,
            count: sql<number>`COUNT(*)`,
          })
          .from(memories)
          .where(
            sql`${memories.id} IN (${sql.join(
              memoryIdSet.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          )
          .groupBy(memories.connectorType);
        for (const row of connectorCounts) {
          byConnector[row.connectorType] = row.count;
        }
      }

      // Date range
      let dateRange: { earliest: Date; latest: Date } | null = null;
      if (recentRows.length) {
        const allTimes = recentRows
          .map((r) => r.eventTime)
          .sort((a, b) => a.getTime() - b.getTime());
        dateRange = {
          earliest: allTimes[0],
          latest: allTimes[allTimes.length - 1],
        };

        // If there are more memories, get the true earliest
        if (totalMemories > 50 && memoryIdSet.length) {
          const earliestRow = await db
            .select({ eventTime: memories.eventTime })
            .from(memories)
            .where(
              sql`${memories.id} IN (${sql.join(
                memoryIdSet.map((id) => sql`${id}`),
                sql`, `,
              )})`,
            )
            .orderBy(memories.eventTime)
            .limit(1);
          if (earliestRow.length) dateRange!.earliest = earliestRow[0].eventTime;
        }
      }

      return {
        contact,
        identifiersByType,
        recentMemories,
        stats: { totalMemories, byConnector, dateRange },
      };
    });
  }

  // ── summarize ──────────────────────────────────────────────────────

  async summarize(
    query: string,
    maxResults = 10,
    userId?: string,
  ): Promise<{ summary: string | null; memories: EnrichedMemory[]; sourceIds: string[] }> {
    const { items: searchResults } = await this.memoryService.search(
      query,
      undefined,
      maxResults,
      userId,
    );

    const enriched: EnrichedMemory[] = [];
    for (const r of searchResults) {
      const e = await this.enrichMemory(r.id, r.score, userId);
      if (e) enriched.push(e);
    }

    const sourceIds = enriched.map((m) => m.id);

    if (enriched.length === 0) {
      return { summary: 'No memories found matching your query.', memories: [], sourceIds: [] };
    }

    // Build prompt
    const memoriesText = enriched
      .map(
        (m) =>
          `[${m.eventTime.toISOString().slice(0, 10)}] [${m.connectorType}/${m.sourceType}] ${m.text}`,
      )
      .join('\n\n');

    const prompt = `Based on the following personal memories, answer the question concisely.
Question: ${query}

Memories:
${memoriesText}

Answer based ONLY on the memories above. If the information isn't in the memories, say so.`;

    // Try Ollama, fall back to returning just memories
    let summary: string | null = null;
    try {
      summary = await this.ai.generate(prompt);
    } catch (err) {
      this.logger.warn(`Ollama summarize failed, returning memories only: ${err}`);
    }

    return { summary, memories: enriched, sourceIds };
  }

  // ── status ─────────────────────────────────────────────────────────

  async status(userId?: string): Promise<{
    memories: {
      total: number;
      byConnector: Record<string, number>;
      bySource: Record<string, number>;
    };
    contacts: { total: number };
    embedding: { backend: string; model: string };
  }> {
    const memStats = await this.memoryService.getStats(userId);

    // IDOR fix: scope contact count to user
    const contactCount = await this.dbService.withCurrentUser((db) =>
      userId
        ? db
            .select({ count: sql<number>`COUNT(*)` })
            .from(people)
            .where(eq(people.userId, userId))
        : db.select({ count: sql<number>`COUNT(*)` }).from(people),
    );

    return {
      memories: {
        total: memStats.total,
        byConnector: memStats.byConnector,
        bySource: memStats.bySource,
      },
      contacts: {
        total: contactCount[0]?.count || 0,
      },
      embedding: {
        backend: this.config.aiBackend,
        model:
          this.config.aiBackend === 'openrouter'
            ? this.config.openrouterEmbedModel
            : this.config.ollamaEmbedModel,
      },
    };
  }

  // ── Private helpers ────────────────────────────────────────────────

  private async enrichMemory(
    memoryId: string,
    score?: number,
    userId?: string,
  ): Promise<EnrichedMemory | null> {
    const mem = await this.memoryService.getById(memoryId, userId);
    if (!mem) return null;

    const peopleMap = await this.memoryService.getPeopleForMemories([memoryId]);

    return {
      id: mem.id,
      text: mem.text,
      sourceType: mem.sourceType,
      connectorType: mem.connectorType,
      eventTime: mem.eventTime,
      eventTimeRelative: relativeTime(mem.eventTime),
      factuality: safeParse(mem.factuality, {
        label: 'UNVERIFIED',
        confidence: 0.5,
        rationale: '',
      }),
      entities: safeParse(mem.entities, []),
      weights: safeParse(mem.weights, {}),
      metadata: safeParse(mem.metadata, {}),
      contacts: (peopleMap.get(memoryId) || []).map((p) => ({
        id: p.personId,
        displayName: p.displayName,
        role: p.role,
      })),
      ...(score !== undefined ? { score } : {}),
    };
  }

  private buildSearchFilter(filters: {
    sourceType?: string;
    connectorType?: string;
    contactId?: string;
    from?: string;
    to?: string;
    fromMe?: boolean;
  }): Record<string, unknown> {
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
    // contactId filtering not supported at vector level — handled post-search
    return must.length ? { must } : {};
  }

  private groupByThread(results: EnrichedMemory[]): EnrichedMemory[] {
    // Sort by score (descending) but group adjacent memories from the same thread
    // Thread key: for emails, use metadata.threadId; otherwise use sourceId prefix
    const threadMap = new Map<string, EnrichedMemory[]>();
    const noThread: EnrichedMemory[] = [];

    for (const mem of results) {
      const meta = mem.metadata as Record<string, unknown> | null;
      const threadId = String(meta?.threadId || meta?.emailThreadKey || meta?.thread_id || '');
      if (threadId) {
        const existing = threadMap.get(threadId) || [];
        existing.push(mem);
        threadMap.set(threadId, existing);
      } else {
        noThread.push(mem);
      }
    }

    // Flatten: thread groups first (sorted by best score in group), then ungrouped
    const threadGroups = Array.from(threadMap.values());
    threadGroups.sort((a, b) => {
      const bestA = Math.max(...a.map((m) => m.score ?? 0));
      const bestB = Math.max(...b.map((m) => m.score ?? 0));
      return bestB - bestA;
    });

    const grouped: EnrichedMemory[] = [];
    for (const group of threadGroups) {
      // Sort within thread by eventTime ascending (chronological)
      group.sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime());
      if (group.length > 1) {
        const latest = group[group.length - 1];
        const threadMeta = latest.metadata as Record<string, unknown>;
        const threadId = String(
          threadMeta.threadId || threadMeta.emailThreadKey || threadMeta.thread_id || '',
        );
        const thread = {
          id: threadId,
          latestState: latest.text,
          firstSeenAt: group[0].eventTime.toISOString(),
          lastSeenAt: latest.eventTime.toISOString(),
          messageCount: group.length,
          memoryIds: group.map((m) => m.id),
        };
        for (const memory of group) {
          memory.metadata = { ...memory.metadata, thread };
        }
      }
      grouped.push(...group);
    }
    grouped.push(...noThread);

    return grouped;
  }
}

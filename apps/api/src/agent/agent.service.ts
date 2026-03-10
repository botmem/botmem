import { Injectable, Logger } from '@nestjs/common';
import { eq, sql, and, desc } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { DbService } from '../db/db.service';
import { MemoryService } from '../memory/memory.service';
import { AiService } from '../memory/ai.service';
import { QdrantService } from '../memory/qdrant.service';
import { ContactsService, ContactWithIdentifiers } from '../contacts/contacts.service';
import { ConfigService } from '../config/config.service';
import { memories, contacts, memoryContacts } from '../db/schema';

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
    private qdrant: QdrantService,
    private contactsService: ContactsService,
    private config: ConfigService,
  ) {}

  // ── ask ────────────────────────────────────────────────────────────

  async ask(
    query: string,
    options?: {
      filters?: { sourceType?: string; connectorType?: string; contactId?: string };
      limit?: number;
      userId?: string;
    },
  ): Promise<{ results: EnrichedMemory[]; query: string; parsed?: { temporal: { from: string; to: string } | null; temporalFallback?: boolean; intent: string; cleanQuery: string } }> {
    const limit = options?.limit ?? 20;
    const searchResponse = await this.memoryService.search(
      query,
      options?.filters,
      limit,
      false,
      options?.userId,
    );

    const enriched = await Promise.all(searchResponse.items.map((r) => this.enrichMemory(r.id, r.score, options?.userId)));

    // Group by thread (same sourceId prefix for emails, or same sourceId for conversations)
    const grouped = this.groupByThread(enriched.filter(Boolean) as EnrichedMemory[]);

    return { results: grouped, query, parsed: searchResponse.parsed };
  }

  // ── timeline ───────────────────────────────────────────────────────

  async timeline(
    options: {
      contactId?: string;
      connectorType?: string;
      sourceType?: string;
      days?: number;
      limit?: number;
    } = {},
  ): Promise<{ results: Record<string, EnrichedMemory[]>; totalCount: number }> {
    const db = this.dbService.db;
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

    let memoryIds: Set<string> | null = null;
    if (options.contactId) {
      const rows = await db
        .select({ memoryId: memoryContacts.memoryId })
        .from(memoryContacts)
        .where(eq(memoryContacts.contactId, options.contactId));
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
      const e = await this.enrichMemory(row.id);
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
  }

  // ── remember ───────────────────────────────────────────────────────

  async remember(text: string, metadata?: Record<string, unknown>): Promise<EnrichedMemory> {
    const id = randomUUID();
    const now = new Date();

    await this.dbService.db.insert(memories).values({
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

    // Generate embedding immediately
    try {
      const vector = await this.ai.embed(text);
      await this.qdrant.ensureCollection(vector.length);
      await this.qdrant.upsert(id, vector, {
        memory_id: id,
        source_type: 'note',
        connector_type: 'agent',
        event_time: now,
      });
      await this.dbService.db
        .update(memories)
        .set({ embeddingStatus: 'done' })
        .where(eq(memories.id, id));
    } catch (err) {
      this.logger.warn(`Failed to embed new memory ${id}: ${err}`);
    }

    return (await this.enrichMemory(id))!;
  }

  // ── forget ─────────────────────────────────────────────────────────

  async forget(memoryId: string): Promise<{ deleted: boolean }> {
    const existing = await this.memoryService.getById(memoryId);
    if (!existing) return { deleted: false };

    await this.memoryService.delete(memoryId);
    // Also clean up memory_contacts links
    await this.dbService.db.delete(memoryContacts).where(eq(memoryContacts.memoryId, memoryId));

    return { deleted: true };
  }

  // ── context ────────────────────────────────────────────────────────

  async context(contactId: string): Promise<{
    contact: ContactWithIdentifiers;
    identifiersByType: Record<string, string[]>;
    recentMemories: EnrichedMemory[];
    stats: {
      totalMemories: number;
      byConnector: Record<string, number>;
      dateRange: { earliest: Date; latest: Date } | null;
    };
  } | null> {
    const contact = await this.contactsService.getById(contactId);
    if (!contact) return null;

    // Identifiers grouped by type
    const identifiersByType: Record<string, string[]> = {};
    for (const ident of contact.identifiers) {
      if (!identifiersByType[ident.identifierType]) identifiersByType[ident.identifierType] = [];
      identifiersByType[ident.identifierType].push(ident.identifierValue);
    }

    // Get all memories for this contact
    const db = this.dbService.db;
    const memRows = await db
      .select({ memoryId: memoryContacts.memoryId })
      .from(memoryContacts)
      .where(eq(memoryContacts.contactId, contactId));

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
      const e = await this.enrichMemory(row.id);
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
      const allTimes = recentRows.map((r) => r.eventTime).sort((a, b) => a.getTime() - b.getTime());
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
  }

  // ── summarize ──────────────────────────────────────────────────────

  async summarize(
    query: string,
    maxResults = 10,
    userId?: string,
  ): Promise<{ summary: string | null; memories: EnrichedMemory[]; sourceIds: string[] }> {
    const { items: searchResults } = await this.memoryService.search(query, undefined, maxResults, false, userId);

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

  async status(): Promise<{
    memories: {
      total: number;
      byConnector: Record<string, number>;
      bySource: Record<string, number>;
    };
    contacts: { total: number };
    embedding: { backend: string; model: string };
  }> {
    const memStats = await this.memoryService.getStats();

    const contactCount = await this.dbService.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(contacts);

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
        model: this.config.aiBackend === 'openrouter' ? this.config.openrouterEmbedModel : this.config.ollamaEmbedModel,
      },
    };
  }

  // ── Private helpers ────────────────────────────────────────────────

  private async enrichMemory(memoryId: string, score?: number, userId?: string): Promise<EnrichedMemory | null> {
    const db = this.dbService.db;

    const mem = await this.memoryService.getById(memoryId, userId);
    if (!mem) return null;

    // Fetch linked contacts
    const mcRows = await db
      .select({
        contactId: memoryContacts.contactId,
        role: memoryContacts.role,
        displayName: contacts.displayName,
      })
      .from(memoryContacts)
      .innerJoin(contacts, eq(memoryContacts.contactId, contacts.id))
      .where(eq(memoryContacts.memoryId, memoryId));

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
      contacts: mcRows.map((r) => ({
        id: r.contactId,
        displayName: r.displayName,
        role: r.role,
      })),
      ...(score !== undefined ? { score } : {}),
    };
  }

  private groupByThread(results: EnrichedMemory[]): EnrichedMemory[] {
    // Sort by score (descending) but group adjacent memories from the same thread
    // Thread key: for emails, use metadata.threadId; otherwise use sourceId prefix
    const threadMap = new Map<string, EnrichedMemory[]>();
    const noThread: EnrichedMemory[] = [];

    for (const mem of results) {
      const threadId = (mem.metadata as any)?.threadId || (mem.metadata as any)?.thread_id;
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
      grouped.push(...group);
    }
    grouped.push(...noThread);

    return grouped;
  }
}

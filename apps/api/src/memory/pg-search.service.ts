import { Injectable, Logger } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { Traced } from '../tracing/traced.decorator';

export interface ScoredPoint {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

export const MEMORY_INDEX_SCHEMA_VERSION = 3;
const PGVECTOR_INDEXED_DIMENSION = 3072;

type FilterInput = string | Record<string, unknown> | undefined;

type SearchFilters = {
  connectorTypes?: string[];
  sourceTypes?: string[];
  factualityLabels?: string[];
  personNames?: string[];
  pinned?: boolean;
  accountIds?: string[];
  memoryBankId?: string;
  memoryBankIds?: string[];
  from?: string;
  to?: string;
  userIds?: string[];
};

type SearchRow = {
  id: string;
  score: number | string | null;
  semantic_score: number | string | null;
  lexical_score: number | string | null;
  connector_type: string;
  source_type: string;
  factuality_label: string | null;
  people: unknown;
};

@Injectable()
export class PgSearchService {
  private readonly logger = new Logger(PgSearchService.name);
  private activeSearchQueries = 0;
  private readonly searchQueue: Array<() => void> = [];
  private readonly maxConcurrentSearchQueries = Math.max(
    1,
    Number.parseInt(process.env.PG_SEARCH_CONCURRENCY ?? '2', 10) || 2,
  );

  constructor(private readonly dbService: DbService) {}

  async ensureCollection(_vectorSize?: number): Promise<void> {
    await this.dbService.systemDb((db) =>
      db.execute(sql`SELECT 1 FROM memory_search_index LIMIT 1`),
    );
  }

  async upsert(
    memoryId: string,
    vector: number[],
    payload: Record<string, unknown>,
  ): Promise<void> {
    const accountId = stringOrNull(payload.account_id);
    const userId =
      stringOrNull(payload.user_id) ??
      (accountId ? await this.resolveAccountUserId(accountId) : null);
    if (!userId) {
      this.logger.warn(`[pg-search] Skipping index for ${memoryId}: user_id not available`);
      return;
    }
    if (!(await this.memoryExists(memoryId))) {
      this.logger.warn(`[pg-search] Skipping index for ${memoryId}: memory row not found`);
      return;
    }

    const text = stringOrEmpty(payload.text);
    const entitiesText = stringOrEmpty(payload.entities_text);
    const searchText = [
      text,
      entitiesText,
      ...stringArray(payload.people),
      ...stringArray(payload.person_aliases),
      ...stringArray(payload.locations),
      stringOrEmpty(payload.location_text),
      ...stringArray(payload.organizations),
      ...stringArray(payload.thread_ids),
      ...stringArray(payload.transaction_tokens),
    ]
      .filter(Boolean)
      .join(' ');
    const embedding = toPgVectorLiteral(vector);
    const now = new Date();

    await this.dbService.systemDb((db) =>
      db.execute(sql`
        INSERT INTO memory_search_index (
          memory_id,
          user_id,
          account_id,
          memory_bank_id,
          connector_type,
          source_type,
          event_time,
          factuality_label,
          pinned,
          importance,
          recall_count,
          text,
          entities_text,
          people,
          person_ids,
          person_aliases,
          locations,
          location_text,
          organizations,
          thread_ids,
          transaction_tokens,
          search_tokens,
          embedding,
          embedding_dimension,
          updated_at
        )
        VALUES (
          ${memoryId},
          ${userId},
          ${accountId},
          ${stringOrNull(payload.memory_bank_id)},
          ${stringOrEmpty(payload.connector_type)},
          ${stringOrEmpty(payload.source_type)},
          ${dateFromPayload(payload.event_time)},
          ${stringOrNull(payload.factuality_label)},
          ${booleanOrFalse(payload.pinned)},
          ${numberOrDefault(payload.importance, 0.5)},
          ${numberOrDefault(payload.recall_count, 0)},
          ${text},
          ${entitiesText},
          ${JSON.stringify(stringArray(payload.people))}::jsonb,
          ${JSON.stringify(stringArray(payload.person_ids))}::jsonb,
          ${JSON.stringify(stringArray(payload.person_aliases))}::jsonb,
          ${JSON.stringify(stringArray(payload.locations))}::jsonb,
          ${stringOrEmpty(payload.location_text)},
          ${JSON.stringify(stringArray(payload.organizations))}::jsonb,
          ${JSON.stringify(stringArray(payload.thread_ids))}::jsonb,
          ${JSON.stringify(stringArray(payload.transaction_tokens))}::jsonb,
          to_tsvector('english', ${searchText}),
          ${embedding ? sql`${embedding}::vector` : sql`NULL`},
          ${vector.length || null},
          ${now}
        )
        ON CONFLICT (memory_id) DO UPDATE SET
          user_id = EXCLUDED.user_id,
          account_id = EXCLUDED.account_id,
          memory_bank_id = EXCLUDED.memory_bank_id,
          connector_type = EXCLUDED.connector_type,
          source_type = EXCLUDED.source_type,
          event_time = EXCLUDED.event_time,
          factuality_label = EXCLUDED.factuality_label,
          pinned = EXCLUDED.pinned,
          importance = EXCLUDED.importance,
          recall_count = EXCLUDED.recall_count,
          text = EXCLUDED.text,
          entities_text = EXCLUDED.entities_text,
          people = EXCLUDED.people,
          person_ids = EXCLUDED.person_ids,
          person_aliases = EXCLUDED.person_aliases,
          locations = EXCLUDED.locations,
          location_text = EXCLUDED.location_text,
          organizations = EXCLUDED.organizations,
          thread_ids = EXCLUDED.thread_ids,
          transaction_tokens = EXCLUDED.transaction_tokens,
          search_tokens = EXCLUDED.search_tokens,
          embedding = EXCLUDED.embedding,
          embedding_dimension = EXCLUDED.embedding_dimension,
          updated_at = EXCLUDED.updated_at
      `),
    );
  }

  @Traced('pg-search.hybrid')
  async hybridSearch(
    query: string,
    vector: number[],
    limit: number,
    filterBy?: FilterInput,
    facetBy?: string,
  ): Promise<{
    results: ScoredPoint[];
    facetCounts: Array<{ field_name: string; counts: Array<{ value: string; count: number }> }>;
    found: number;
  }> {
    const rows = await this.queryRows(query, vector, limit, filterBy, {
      semanticWeight: 0.55,
      lexicalWeight: 0.35,
    });
    return {
      results: rows.map(toPoint),
      facetCounts: facetBy ? buildFacetCounts(rows, facetBy) : [],
      found: rows.length,
    };
  }

  async textSearch(
    query: string,
    limit: number,
    filterBy?: FilterInput,
    _queryBy?: string,
  ): Promise<ScoredPoint[]> {
    const rows = await this.queryRows(query, [], limit, filterBy, {
      semanticWeight: 0,
      lexicalWeight: 1,
    });
    return rows.map(toPoint);
  }

  async search(vector: number[], limit: number, filter?: FilterInput): Promise<ScoredPoint[]> {
    const rows = await this.queryRows('', vector, limit, filter, {
      semanticWeight: 1,
      lexicalWeight: 0,
    });
    return rows.map(toPoint);
  }

  async recommend(memoryId: string, limit: number, filter?: FilterInput): Promise<ScoredPoint[]> {
    const releaseSearchSlot = await this.acquireSearchSlot();
    const filters = this.parseFilters(filter);
    const conditions = [
      sql`target.memory_id != ${memoryId}`,
      sql`target.embedding IS NOT NULL`,
      sql`target.embedding_dimension = ${PGVECTOR_INDEXED_DIMENSION}`,
      ...this.filterConditions(filters, 'target'),
    ];
    try {
      const source = await this.dbService.systemDb((db) =>
        db.execute(sql`
          SELECT embedding::text AS embedding
          FROM memory_search_index
          WHERE memory_id = ${memoryId}
            AND embedding IS NOT NULL
            AND embedding_dimension = ${PGVECTOR_INDEXED_DIMENSION}
          LIMIT 1
        `),
      );
      const sourceEmbedding = (source.rows[0] as { embedding?: string } | undefined)?.embedding;
      if (!sourceEmbedding) return [];

      const rows = await this.dbService.systemDb((db) =>
        db.execute(sql`
          SELECT
            target.memory_id AS id,
            GREATEST(0, 1 - (target.embedding::halfvec(3072) <=> ${sourceEmbedding}::halfvec(3072))) AS score,
            GREATEST(0, 1 - (target.embedding::halfvec(3072) <=> ${sourceEmbedding}::halfvec(3072))) AS semantic_score,
            0 AS lexical_score,
            target.connector_type,
            target.source_type,
            target.factuality_label,
            target.people
          FROM memory_search_index target
          WHERE ${sql.join(conditions, sql` AND `)}
          ORDER BY target.embedding::halfvec(3072) <=> ${sourceEmbedding}::halfvec(3072) ASC
          LIMIT ${Math.max(1, limit)}
        `),
      );
      return ((rows.rows ?? []) as SearchRow[]).map(toPoint);
    } finally {
      releaseSearchSlot();
    }
  }

  async conversationSearch(
    query: string,
    vector: number[],
    limit: number,
    _conversationModelId: string,
    _conversationId?: string,
    filter?: FilterInput,
  ): Promise<{
    results: ScoredPoint[];
    conversation?: { answer: string; conversationId: string };
  }> {
    const { results } = await this.hybridSearch(query, vector, limit, filter);
    return { results };
  }

  async remove(id: string): Promise<void> {
    await this.dbService.systemDb((db) =>
      db.execute(sql`DELETE FROM memory_search_index WHERE memory_id = ${id}`),
    );
  }

  async getCollectionInfo(): Promise<{
    pointsCount: number;
    indexedVectorsCount: number;
    status: string;
  }> {
    const result = await this.dbService.systemDb((db) =>
      db.execute(sql`
        SELECT
          COUNT(*)::int AS points_count,
          COUNT(embedding)::int AS indexed_vectors_count
        FROM memory_search_index
      `),
    );
    const row = (result.rows[0] ?? {}) as { points_count?: number; indexed_vectors_count?: number };
    return {
      pointsCount: row.points_count ?? 0,
      indexedVectorsCount: row.indexed_vectors_count ?? 0,
      status: 'ready',
    };
  }

  async getSchemaStatus(): Promise<{
    collection: string;
    currentVersion: number;
    expectedVersion: number;
    status: 'missing' | 'current' | 'stale';
    missingFields: string[];
  }> {
    const result = await this.dbService.systemDb((db) =>
      db.execute(sql`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'memory_search_index'
      `),
    );
    const fields = new Set(
      (result.rows as Array<{ column_name: string }>).map((r) => r.column_name),
    );
    const required = ['memory_id', 'user_id', 'search_tokens', 'embedding', 'embedding_dimension'];
    const missingFields = required.filter((field) => !fields.has(field));
    return {
      collection: 'memory_search_index',
      currentVersion: missingFields.length ? 0 : MEMORY_INDEX_SCHEMA_VERSION,
      expectedVersion: MEMORY_INDEX_SCHEMA_VERSION,
      status: fields.size === 0 ? 'missing' : missingFields.length ? 'stale' : 'current',
      missingFields,
    };
  }

  async pointExists(id: string): Promise<boolean> {
    const result = await this.dbService.systemDb((db) =>
      db.execute(sql`SELECT 1 FROM memory_search_index WHERE memory_id = ${id} LIMIT 1`),
    );
    return (result.rows?.length ?? 0) > 0;
  }

  private async memoryExists(id: string): Promise<boolean> {
    const result = await this.dbService.systemDb((db) =>
      db.execute(sql`SELECT 1 FROM memories WHERE id = ${id} LIMIT 1`),
    );
    return (result.rows?.length ?? 0) > 0;
  }

  async setPayload(
    payload: Record<string, unknown>,
    filter: Record<string, unknown>,
  ): Promise<void> {
    const filters = this.parseFilters(filter);
    if (!filters.accountIds?.length && !filters.memoryBankId && !filters.memoryBankIds?.length)
      return;
    const sets: SQL[] = [];
    if (typeof payload.pinned === 'boolean') sets.push(sql`pinned = ${payload.pinned}`);
    if (typeof payload.importance === 'number') sets.push(sql`importance = ${payload.importance}`);
    if (!sets.length) return;
    await this.dbService.systemDb((db) =>
      db.execute(sql`
        UPDATE memory_search_index SET ${sql.join(sets, sql`, `)}, updated_at = now()
        WHERE ${sql.join(this.filterConditions(filters), sql` AND `)}
      `),
    );
  }

  buildFilterString(filters: SearchFilters): string {
    return JSON.stringify({ kind: 'pg-search-filter', filters });
  }

  buildLegacyFilter(filter: Record<string, unknown>): string {
    const converted: SearchFilters = {};
    const must = (filter as { must?: Array<Record<string, unknown>> }).must ?? [];
    for (const clause of must) {
      const key = String(clause.key ?? '');
      const match = clause.match as { value?: unknown; any?: unknown[] } | undefined;
      const range = clause.range as { gte?: string; lte?: string } | undefined;
      if (key === 'source_type' && match?.value) converted.sourceTypes = [String(match.value)];
      if (key === 'connector_type' && match?.value)
        converted.connectorTypes = [String(match.value)];
      if (key === 'account_id' && match?.any) converted.accountIds = match.any.map(String);
      if (key === 'memory_bank_id' && match?.value) converted.memoryBankId = String(match.value);
      if (key === 'memory_bank_id' && match?.any) converted.memoryBankIds = match.any.map(String);
      if (key === 'event_time' && range) {
        converted.from = range.gte;
        converted.to = range.lte;
      }
    }
    return this.buildFilterString(converted);
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.ensureCollection();
      return true;
    } catch {
      return false;
    }
  }

  private async queryRows(
    query: string,
    vector: number[],
    limit: number,
    filterBy: FilterInput,
    weights: { semanticWeight: number; lexicalWeight: number },
  ): Promise<SearchRow[]> {
    const releaseSearchSlot = await this.acquireSearchSlot();
    const filters = this.parseFilters(filterBy);
    const conditions = this.filterConditions(filters);
    const q = query.trim();
    if (vector.length) {
      conditions.push(sql`embedding IS NOT NULL`);
      conditions.push(sql`embedding_dimension = ${vector.length}`);
    }
    if (!vector.length && q) {
      conditions.push(sql`search_tokens @@ websearch_to_tsquery('english', ${q})`);
    }
    if (!conditions.length) conditions.push(sql`TRUE`);
    const vectorLiteral = toPgVectorLiteral(vector);
    const candidateLimit = Math.max(Math.max(1, limit) * 20, 100);
    const fallbackCandidateConditions = [...conditions];
    if (vectorLiteral && q) {
      fallbackCandidateConditions.push(sql`search_tokens @@ websearch_to_tsquery('english', ${q})`);
    }
    try {
      if (vectorLiteral && vector.length === PGVECTOR_INDEXED_DIMENSION) {
        const result = await this.dbService.systemDb((db) =>
          db.execute(sql`
            WITH candidates AS (
              SELECT *
              FROM memory_search_index
              WHERE ${sql.join(conditions, sql` AND `)}
              ORDER BY embedding::halfvec(3072) <=> ${vectorLiteral}::halfvec(3072) ASC
              LIMIT ${candidateLimit}
            )
            SELECT
              memory_id AS id,
              (
                ${weights.semanticWeight} * GREATEST(0, 1 - (embedding::halfvec(3072) <=> ${vectorLiteral}::halfvec(3072)) ) +
                ${weights.lexicalWeight} * ${
                  q ? sql`ts_rank_cd(search_tokens, websearch_to_tsquery('english', ${q}))` : sql`0`
                } +
                0.07 * importance +
                0.05 * CASE WHEN pinned THEN 1 ELSE 0 END +
                0.03 * ${recencyScoreSql()}
              ) AS score,
              GREATEST(0, 1 - (embedding::halfvec(3072) <=> ${vectorLiteral}::halfvec(3072))) AS semantic_score,
              ${q ? sql`ts_rank_cd(search_tokens, websearch_to_tsquery('english', ${q}))` : sql`0`}
                AS lexical_score,
              connector_type,
              source_type,
              factuality_label,
              people
            FROM candidates
            ORDER BY score DESC, event_time DESC
            LIMIT ${Math.max(1, limit)}
          `),
        );
        return (result.rows ?? []) as SearchRow[];
      }

      const result = await this.dbService.systemDb((db) =>
        db.execute(sql`
          WITH candidates AS (
            SELECT *
            FROM memory_search_index
            WHERE ${sql.join(fallbackCandidateConditions, sql` AND `)}
            ORDER BY ${
              q
                ? sql`ts_rank_cd(search_tokens, websearch_to_tsquery('english', ${q})) DESC, event_time DESC`
                : sql`event_time DESC`
            }
            -- ponytail: bound non-indexed fallback; add a matching vector index if semantic recall suffers.
            LIMIT ${candidateLimit}
          )
          SELECT
            memory_id AS id,
            (
              ${weights.semanticWeight} * ${
                vectorLiteral
                  ? sql`GREATEST(0, 1 - (embedding <=> ${vectorLiteral}::vector))`
                  : sql`0`
              } +
              ${weights.lexicalWeight} * ${
                q ? sql`ts_rank_cd(search_tokens, websearch_to_tsquery('english', ${q}))` : sql`0`
              } +
              0.07 * importance +
              0.05 * CASE WHEN pinned THEN 1 ELSE 0 END +
              0.03 * ${recencyScoreSql()}
            ) AS score,
            ${
              vectorLiteral
                ? sql`GREATEST(0, 1 - (embedding <=> ${vectorLiteral}::vector))`
                : sql`0`
            } AS semantic_score,
            ${q ? sql`ts_rank_cd(search_tokens, websearch_to_tsquery('english', ${q}))` : sql`0`}
              AS lexical_score,
            connector_type,
            source_type,
            factuality_label,
            people
          FROM candidates
          ORDER BY score DESC, event_time DESC
          LIMIT ${Math.max(1, limit)}
        `),
      );
      return (result.rows ?? []) as SearchRow[];
    } finally {
      releaseSearchSlot();
    }
  }

  private async acquireSearchSlot(): Promise<() => void> {
    if (this.activeSearchQueries < this.maxConcurrentSearchQueries) {
      this.activeSearchQueries++;
      return () => this.releaseSearchSlot();
    }
    return new Promise<() => void>((resolve) =>
      this.searchQueue.push(() => resolve(() => this.releaseSearchSlot())),
    );
  }

  private releaseSearchSlot() {
    const next = this.searchQueue.shift();
    if (next) {
      next();
      return;
    }
    this.activeSearchQueries = Math.max(0, this.activeSearchQueries - 1);
  }

  private parseFilters(input: FilterInput): SearchFilters {
    if (!input) return {};
    if (typeof input === 'object') {
      const encoded = this.buildLegacyFilter(input);
      return this.parseFilters(encoded);
    }
    const filters: SearchFilters = {};
    for (const chunk of input.split(' && ').filter(Boolean)) {
      try {
        const parsed = JSON.parse(chunk) as { filters?: SearchFilters };
        Object.assign(filters, parsed.filters ?? {});
      } catch {
        // Ignore legacy raw filter strings that are not emitted by PgSearchService.
      }
    }
    return filters;
  }

  private filterConditions(filters: SearchFilters, alias?: 'source' | 'target'): SQL[] {
    const p = (column: string) => (alias ? sql.raw(`${alias}.${column}`) : sql.raw(column));
    const conditions: SQL[] = [];
    if (filters.userIds?.length) conditions.push(inList(p('user_id'), filters.userIds));
    if (filters.accountIds?.length) conditions.push(inList(p('account_id'), filters.accountIds));
    if (filters.connectorTypes?.length) {
      conditions.push(inList(p('connector_type'), filters.connectorTypes));
    }
    if (filters.sourceTypes?.length) conditions.push(inList(p('source_type'), filters.sourceTypes));
    if (filters.factualityLabels?.length) {
      conditions.push(inList(p('factuality_label'), filters.factualityLabels));
    }
    if (filters.memoryBankId)
      conditions.push(sql`${p('memory_bank_id')} = ${filters.memoryBankId}`);
    if (filters.memoryBankIds?.length) {
      conditions.push(inList(p('memory_bank_id'), filters.memoryBankIds));
    }
    if (filters.pinned === true) conditions.push(sql`${p('pinned')} = true`);
    if (filters.from) conditions.push(sql`${p('event_time')} >= ${new Date(filters.from)}`);
    if (filters.to) conditions.push(sql`${p('event_time')} <= ${new Date(filters.to)}`);
    if (filters.personNames?.length) {
      const clauses = filters.personNames.map(
        (name) => sql`${p('people')} ? ${name} OR ${p('person_aliases')} ? ${name}`,
      );
      conditions.push(sql`(${sql.join(clauses, sql` OR `)})`);
    }
    return conditions;
  }

  private async resolveAccountUserId(accountId: string): Promise<string | null> {
    const result = await this.dbService.systemDb((db) =>
      db.execute(sql`SELECT user_id FROM accounts WHERE id = ${accountId} LIMIT 1`),
    );
    const row = result.rows[0] as { user_id?: string | null } | undefined;
    return row?.user_id ?? null;
  }
}

function inList(column: SQL, values: string[]): SQL {
  return sql`${column} IN (${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )})`;
}

function toPoint(row: SearchRow): ScoredPoint {
  return {
    id: row.id,
    score: clamp(Number(row.score ?? row.semantic_score ?? row.lexical_score ?? 0)),
    payload: {
      connector_type: row.connector_type,
      source_type: row.source_type,
      factuality_label: row.factuality_label,
      people: Array.isArray(row.people) ? row.people : [],
    },
  };
}

function buildFacetCounts(rows: SearchRow[], facetBy: string) {
  return facetBy.split(',').map((field) => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const value =
        field === 'connector_type'
          ? row.connector_type
          : field === 'source_type'
            ? row.source_type
            : field === 'factuality_label'
              ? row.factuality_label
              : field === 'people'
                ? row.people
                : null;
      const values = Array.isArray(value) ? value : value ? [value] : [];
      for (const item of values) counts.set(String(item), (counts.get(String(item)) ?? 0) + 1);
    }
    return {
      field_name: field,
      counts: [...counts.entries()].map(([value, count]) => ({ value, count })),
    };
  });
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter(Boolean);
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function stringOrNull(value: unknown): string | null {
  const text = stringOrEmpty(value);
  return text ? text : null;
}

function booleanOrFalse(value: unknown): boolean {
  return typeof value === 'boolean' ? value : false;
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function dateFromPayload(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string') return new Date(value);
  return new Date();
}

function recencyScoreSql(): SQL {
  return sql`
    EXP(
      GREATEST(
        -50.0::double precision,
        LEAST(
          0.0::double precision,
          -0.015::double precision * (
            EXTRACT(EPOCH FROM (now() - event_time))::double precision / 86400.0::double precision
          )
        )
      )
    )
  `;
}

function toPgVectorLiteral(vector: number[]): string | null {
  if (!vector.length) return null;
  return `[${vector.map(toPgVectorComponent).join(',')}]`;
}

function toPgVectorComponent(value: number): string {
  if (!Number.isFinite(value)) return '0';
  // pgvector stores float4 values. Subnormal values below float4 range carry no
  // practical embedding signal and can be rejected while parsing numeric literals.
  if (Math.abs(value) < 1e-38) return '0';
  return value.toExponential(8);
}

function clamp(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(1, score));
}

# Phase 22: PostgreSQL Migration - Research

**Researched:** 2026-03-09
**Domain:** PostgreSQL migration (SQLite removal), Drizzle ORM pg driver, full-text search
**Confidence:** HIGH

## Summary

This phase replaces SQLite (better-sqlite3) entirely with PostgreSQL across the codebase. The migration touches DbService, schema.ts, ConfigService, docker-compose.yml, memory.service.ts FTS queries, health checks, test helpers, and several services that use `this.dbService.sqlite` directly. The codebase currently has 3 direct `sqlite` property usages (db.service.ts itself, memory.service.ts FTS queries, health.controller.ts probe) plus the Drizzle schema imports from `drizzle-orm/sqlite-core`.

Drizzle ORM 0.38.x (currently installed) supports PostgreSQL via `drizzle-orm/node-postgres` with the `pg` driver. The schema rewrite from `sqliteTable` to `pgTable` is mechanical but must account for type differences: SQLite `integer` booleans become `boolean()`, SQLite `text` JSON becomes `jsonb()`, and SQLite `text` timestamps become `timestamp({ withTimezone: true })`. Full-text search moves from FTS5 virtual tables with triggers to PostgreSQL tsvector generated columns with GIN indexes, plus pg_trgm for fuzzy matching.

**Primary recommendation:** Use `drizzle-orm/node-postgres` with `pg` Pool, rewrite schema.ts to use `pgTable` with native Postgres types, replace FTS5 with a tsvector generated column + GIN index on memories.text, and add pg_trgm for fuzzy search. Keep the OnModuleInit auto-create pattern using raw SQL for table creation (CREATE TABLE IF NOT EXISTS), since Drizzle migrations are not used in this project.

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions

- PostgreSQL only -- no dual-driver, no SQLite fallback
- Remove better-sqlite3 dependency entirely
- Use drizzle-orm/node-postgres (or drizzle-orm/postgres-js)
- DB_DRIVER env var removed -- DATABASE_URL is the only config needed
- Startup fails fast if DATABASE_URL is missing (OnModuleInit validation, consistent with Phase 34 pattern)
- Single schema file for PostgreSQL (replaces schema.ts)
- Use native Postgres types: serial, text[], jsonb, timestamp with timezone
- Auto-create tables on startup (OnModuleInit pattern, CREATE TABLE IF NOT EXISTS)
- No Drizzle migration step required -- tables created automatically on first run
- SQLite is for nobody -- Postgres everywhere (open-core + prod-core)
- Same codebase, same driver, just different DATABASE_URL values
- Docker Compose includes Postgres service alongside Redis + Qdrant
- Fresh deployments get bootstrap: run migrations + create Qdrant collection
- tsvector + GIN index for standard full-text search (replaces FTS5)
- pg_trgm for fuzzy/partial matching (additional capability over old SQLite FTS)
- Always combine both: tsvector first, trigram fallback -- single search endpoint
- English + Arabic language support (tsvector configured with both dictionaries)
- pg_trgm handles any script automatically
- Drizzle query builder only -- no raw SQL escape hatch
- Dialect-specific SQL (FTS, transactions) handled inside DbService
- Application code is Postgres-native, not dialect-agnostic

### Claude's Discretion

- Specific Postgres Docker image version
- Connection pooling strategy (pgBouncer vs native pool)
- Index strategy beyond FTS (when to add indexes)
- Transaction isolation level choices

### Deferred Ideas (OUT OF SCOPE)

- PostgreSQL RLS policies (Phase 23) -- depends on this phase completing first
- Connection pooling optimization -- can tune after initial migration works
  </user_constraints>

<phase_requirements>

## Phase Requirements

| ID    | Description                                                                 | Research Support                                                                                                                   |
| ----- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| DB-01 | PostgreSQL schema mirrors SQLite schema with identical logical structure    | Schema rewrite from sqliteTable to pgTable with native PG types (jsonb, boolean, timestamp w/tz). All 16 tables mapped.            |
| DB-02 | Shared database interface abstracts over SQLite and PostgreSQL              | OVERRIDDEN by user decision: no abstraction layer. Application code is Postgres-native. DbService exposes `drizzle` instance only. |
| DB-03 | Conditional DbService initializes correct driver based on DB_DRIVER env var | OVERRIDDEN by user decision: no DB_DRIVER, no conditional. Single Postgres driver via DATABASE_URL. Fail fast if missing.          |
| DB-04 | SQLite FTS5 ported to PostgreSQL tsvector + GIN index for full-text search  | tsvector generated column + GIN index on memories.text. pg_trgm extension for fuzzy matching. Drizzle sql`` template for queries.  |

</phase_requirements>

## Standard Stack

### Core

| Library     | Version                     | Purpose                           | Why Standard                                                          |
| ----------- | --------------------------- | --------------------------------- | --------------------------------------------------------------------- |
| drizzle-orm | ^0.38.0 (installed: 0.38.4) | ORM / query builder               | Already in use, supports Postgres natively via node-postgres driver   |
| pg          | ^8.13.0                     | PostgreSQL client (node-postgres) | Most mature Node.js PG driver, native Pool, well-supported by Drizzle |
| @types/pg   | ^8.11.0                     | TypeScript types for pg           | Required dev dependency                                               |

### Supporting

| Library     | Version             | Purpose                     | When to Use                                                    |
| ----------- | ------------------- | --------------------------- | -------------------------------------------------------------- |
| drizzle-kit | ^0.30.0 (installed) | Schema introspection / push | Optional -- for verifying schema matches DB during development |

### Remove

| Library               | Reason                       |
| --------------------- | ---------------------------- |
| better-sqlite3        | SQLite driver being replaced |
| @types/better-sqlite3 | Types for removed driver     |

### Alternatives Considered

| Instead of         | Could Use              | Tradeoff                                                                                                                                                       |
| ------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pg (node-postgres) | postgres (postgres.js) | postgres.js uses prepared statements by default which can conflict with pgBouncer; pg is more mature, has pg-native for perf boost. **Recommendation: use pg** |

**Installation:**

```bash
pnpm --filter @botmem/api add pg
pnpm --filter @botmem/api add -D @types/pg
pnpm --filter @botmem/api remove better-sqlite3 @types/better-sqlite3
```

## Architecture Patterns

### Recommended Changes

```
apps/api/src/
  db/
    schema.ts          # REWRITE: sqliteTable -> pgTable with PG types
    db.service.ts      # REWRITE: pg Pool + drizzle-orm/node-postgres, raw SQL table creation
  config/
    config.service.ts  # MODIFY: dbPath -> databaseUrl, add validation
  memory/
    memory.service.ts  # MODIFY: FTS5 queries -> tsvector/tsquery + pg_trgm
  health.controller.ts # MODIFY: sqlite probe -> pg pool probe
  __tests__/helpers/
    db.helper.ts       # REWRITE: in-memory SQLite -> test Postgres or pg-mem
```

### Pattern 1: DbService with pg Pool

**What:** DbService creates a pg Pool on init, wraps it with Drizzle, auto-creates tables via raw SQL.
**When to use:** Always -- this is the single database entry point.

```typescript
// Source: Drizzle ORM official docs + project OnModuleInit pattern
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { ConfigService } from '../config/config.service';
import * as schema from './schema';

@Injectable()
export class DbService implements OnModuleInit {
  private readonly logger = new Logger(DbService.name);
  private pool!: Pool;
  public db!: NodePgDatabase<typeof schema>;

  constructor(private config: ConfigService) {}

  async onModuleInit() {
    this.pool = new Pool({
      connectionString: this.config.databaseUrl,
      max: 20, // connection pool size
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    this.db = drizzle(this.pool, { schema });
    await this.createTables();
    this.logger.log('PostgreSQL connected and tables ensured');
  }

  /** Expose pool for health checks */
  async healthCheck(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
      return true;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  private async createTables() {
    const client = await this.pool.connect();
    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS users ( ... );
        CREATE TABLE IF NOT EXISTS accounts ( ... );
        -- ... all tables with Postgres-native types
      `);
    } finally {
      client.release();
    }
  }
}
```

### Pattern 2: Schema with pgTable and Native Types

**What:** Complete schema rewrite using Drizzle's pg-core types.
**Key type mappings from SQLite to PostgreSQL:**

| SQLite Type                          | PostgreSQL Type                                   | Drizzle Function    |
| ------------------------------------ | ------------------------------------------------- | ------------------- |
| `text('id').primaryKey()`            | `text('id').primaryKey()`                         | Same                |
| `text('email').unique()`             | `text('email').unique()`                          | Same                |
| `integer('onboarded').default(0)`    | `boolean('onboarded').default(false)`             | `boolean()`         |
| `integer('pinned').default(0)`       | `boolean('pinned').default(false)`                | `boolean()`         |
| `integer('items_synced').default(0)` | `integer('items_synced').default(0)`              | Same                |
| `real('strength')`                   | `doublePrecision('strength')`                     | `doublePrecision()` |
| `real('confidence')`                 | `doublePrecision('confidence')`                   | `doublePrecision()` |
| `text('created_at')`                 | `timestamp('created_at', { withTimezone: true })` | `timestamp()`       |
| `text('entities').default('[]')`     | `jsonb('entities').default([])`                   | `jsonb()`           |
| `text('metadata').default('{}')`     | `jsonb('metadata').default({})`                   | `jsonb()`           |
| `text('factuality').default(...)`    | `jsonb('factuality').default(...)`                | `jsonb()`           |
| `text('weights').default(...)`       | `jsonb('weights').default(...)`                   | `jsonb()`           |
| `text('avatars').default('[]')`      | `jsonb('avatars').default([])`                    | `jsonb()`           |

```typescript
// Source: Drizzle ORM pg-core docs
import {
  pgTable,
  text,
  integer,
  boolean,
  doublePrecision,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const memories = pgTable(
  'memories',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').references(() => accounts.id),
    memoryBankId: text('memory_bank_id'),
    connectorType: text('connector_type').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    text: text('text').notNull(),
    eventTime: timestamp('event_time', { withTimezone: true }).notNull(),
    ingestTime: timestamp('ingest_time', { withTimezone: true }).notNull(),
    factuality: jsonb('factuality').notNull().default({
      label: 'UNVERIFIED',
      confidence: 0.5,
      rationale: 'Pending evaluation',
    }),
    weights: jsonb('weights').notNull().default({
      semantic: 0,
      rerank: 0,
      recency: 0,
      importance: 0.5,
      trust: 0.5,
      final: 0,
    }),
    entities: jsonb('entities').notNull().default([]),
    claims: jsonb('claims').notNull().default([]),
    metadata: jsonb('metadata').notNull().default({}),
    embeddingStatus: text('embedding_status').notNull().default('pending'),
    pinned: boolean('pinned').notNull().default(false),
    recallCount: integer('recall_count').notNull().default(0),
    enrichedAt: timestamp('enriched_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('idx_memories_embedding_status').on(table.embeddingStatus),
    index('idx_memories_event_time').on(table.eventTime),
    index('idx_memories_connector_type').on(table.connectorType),
    index('idx_memories_memory_bank_id').on(table.memoryBankId),
    uniqueIndex('idx_memories_source_dedup').on(table.sourceId, table.connectorType),
    // FTS: GIN index on tsvector of text column
    index('idx_memories_fts').using('gin', sql`to_tsvector('english', ${table.text})`),
    // Trigram index for fuzzy search
    index('idx_memories_trgm').using('gin', sql`${table.text} gin_trgm_ops`),
  ],
);
```

### Pattern 3: Full-Text Search (tsvector + pg_trgm)

**What:** Replace FTS5 with PostgreSQL native FTS.
**Key differences from SQLite FTS5:**

- No separate virtual table -- uses indexes on the actual table
- No triggers needed -- GIN index auto-updates
- tsvector handles stemming, stop words, language-aware tokenization
- pg_trgm handles fuzzy matching, typo tolerance

```typescript
// Source: Drizzle ORM PostgreSQL FTS guide
import { sql } from 'drizzle-orm';

// tsvector search (exact word matching with stemming)
const ftsQuery = searchWords.map((w) => `${w}:*`).join(' & ');
const ftsResults = await db
  .select({ id: memories.id })
  .from(memories)
  .where(sql`to_tsvector('english', ${memories.text}) @@ to_tsquery('english', ${ftsQuery})`)
  .limit(limit * 2);

// pg_trgm fuzzy search (fallback for partial/typo matching)
const trgmResults = await db
  .select({ id: memories.id })
  .from(memories)
  .where(sql`${memories.text} % ${searchTerm}`) // similarity operator
  .limit(limit * 2);

// Combined: tsvector first, trigram fallback
const tsvectorMatches = await db
  .select({
    id: memories.id,
    rank: sql`ts_rank(to_tsvector('english', ${memories.text}), to_tsquery('english', ${ftsQuery}))`,
  })
  .from(memories)
  .where(sql`to_tsvector('english', ${memories.text}) @@ to_tsquery('english', ${ftsQuery})`)
  .orderBy(
    sql`ts_rank(to_tsvector('english', ${memories.text}), to_tsquery('english', ${ftsQuery})) DESC`,
  )
  .limit(limit * 2);
```

### Pattern 4: Multi-language tsvector (English + Arabic)

**What:** Support both English and Arabic full-text search.

```sql
-- In table creation or as a generated column:
-- Use 'simple' config for Arabic (no stemmer), 'english' for English
-- Combine both with concatenation:
CREATE INDEX idx_memories_fts_multi ON memories USING gin (
  (to_tsvector('english', text) || to_tsvector('simple', text))
);

-- Query with both:
WHERE (to_tsvector('english', text) || to_tsvector('simple', text))
  @@ to_tsquery('simple', 'search_term')
```

Note: PostgreSQL does not have a built-in Arabic dictionary. The `simple` configuration tokenizes without stemming, which works for Arabic script. For advanced Arabic stemming, a custom dictionary (e.g., Apertium-based) would be needed, but `simple` + pg_trgm covers the common use case.

### Anti-Patterns to Avoid

- **Keeping SQLite code paths:** Do not leave any `better-sqlite3` imports or fallback paths. Clean removal.
- **Using Drizzle migrations for table creation:** The project pattern is OnModuleInit raw SQL. Do not introduce `drizzle-kit push` or `drizzle-kit migrate` as a startup step.
- **Storing JSON as text:** With Postgres, use `jsonb()` type directly -- no more `JSON.parse()` on read.
- **Using `integer` for booleans:** Postgres has native `boolean` type. Use it.
- **Keeping ISO string timestamps:** Use `timestamp({ withTimezone: true })` and store Date objects. However, be aware this changes the application-layer interface from ISO strings to Date objects -- all services reading/writing timestamps need updating.

## Don't Hand-Roll

| Problem            | Don't Build                                   | Use Instead                                  | Why                                                            |
| ------------------ | --------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------- |
| Full-text search   | Custom LIKE queries or app-level tokenization | PostgreSQL tsvector + GIN + pg_trgm          | Handles stemming, stop words, ranking, multi-language natively |
| Connection pooling | Manual connection management                  | pg Pool (built into node-postgres)           | Handles connection lifecycle, idle timeout, max connections    |
| JSON querying      | Parsing text columns in app code              | PostgreSQL jsonb operators via Drizzle sql`` | Native indexing, querying, and validation                      |
| Boolean storage    | Integer 0/1 with app-level casting            | PostgreSQL boolean type                      | Type safety, no casting needed                                 |

## Common Pitfalls

### Pitfall 1: Timestamp Type Mismatch

**What goes wrong:** SQLite stores timestamps as ISO 8601 text strings. Postgres timestamp returns Date objects via node-postgres. All application code that reads/writes timestamps will break if not updated.
**Why it happens:** Different driver return types.
**How to avoid:** Two options: (A) Keep timestamps as `text` type in Postgres to minimize app-layer changes, or (B) switch to `timestamp({ withTimezone: true })` and update all services. Option B is cleaner but more work. The CONTEXT.md specifies native Postgres types, so go with option B and update all timestamp handling.
**Warning signs:** Tests passing with strings but failing with Date objects.

### Pitfall 2: JSONB Default Serialization

**What goes wrong:** With SQLite, JSON columns are text and defaults are strings like `'[]'`. With Postgres jsonb, defaults are native objects `[]`. Code that does `JSON.parse(row.entities)` will fail because entities is already an object.
**Why it happens:** jsonb returns parsed objects, not strings.
**How to avoid:** Remove all `JSON.parse()` calls on jsonb columns. Add `.$type<T>()` for type safety. Search the codebase for `JSON.parse` on columns that become jsonb.
**Warning signs:** `SyntaxError: Unexpected token o in JSON.parse`.

### Pitfall 3: SQLite-specific SQL in Services

**What goes wrong:** Some services use `this.dbService.sqlite.prepare()` directly for raw queries (memory.service.ts FTS, health.controller.ts).
**Why it happens:** SQLite's synchronous API was used directly.
**How to avoid:** Audit all `this.dbService.sqlite` usages and replace with Drizzle queries or pool queries. Only 3 files use it directly: db.service.ts (self), memory.service.ts, health.controller.ts.
**Warning signs:** TypeScript errors when `sqlite` property is removed from DbService.

### Pitfall 4: Test Infrastructure

**What goes wrong:** Test helper creates in-memory SQLite DB. No equivalent for Postgres.
**Why it happens:** SQLite `:memory:` is convenient for tests.
**How to avoid:** Options: (A) Use a test Postgres container (docker compose up before tests), (B) Use pg-mem for in-memory Postgres emulation, (C) Mock DbService entirely. **Recommendation: Option A** -- use a test Postgres instance. Add a `TEST_DATABASE_URL` env var. The test helper creates/drops a test database per suite.
**Warning signs:** Tests failing in CI without Postgres.

### Pitfall 5: Encrypted Fields are Already Strings

**What goes wrong:** The encryption migration (migrateEncryption, migrateMemoryEncryption) stores encrypted data as `iv:data:tag` strings. If those columns become jsonb, encrypted values will fail to insert.
**Why it happens:** Encrypted data is opaque ciphertext, not valid JSON.
**How to avoid:** Keep encrypted columns as `text` type, not jsonb. Specifically: `authContext` (accounts), `credentials` (connector_credentials), and encrypted memory fields (text, entities, claims, metadata) are stored as encrypted strings. However -- the memories columns are encrypted at rest and decrypted on read. After decryption, entities/claims/metadata ARE JSON. **Decision point:** If we use jsonb for these columns, the encryption at rest needs to encrypt the entire row or use Postgres-level encryption (pgcrypto) instead of application-level. **Recommendation:** Keep `text` type for columns that are encrypted at rest (authContext, credentials). For memory columns (text, entities, claims, metadata) that are encrypted, keep as `text` since the encrypted ciphertext is not valid JSON. The jsonb benefits only apply if data is stored unencrypted.
**Warning signs:** Insert failures on jsonb columns with encrypted string values.

### Pitfall 6: Boolean Conversion from Integer

**What goes wrong:** Existing data and all application code treats booleans as 0/1 integers. Postgres boolean is true/false.
**Why it happens:** SQLite has no boolean type.
**How to avoid:** Search for `=== 0`, `=== 1`, `.default(0)`, `.default(1)` on boolean-semantic fields (pinned, onboarded, is_default). Update all comparisons to use true/false.
**Warning signs:** Condition checks like `if (user.onboarded)` may work differently.

## Code Examples

### ConfigService databaseUrl

```typescript
// Source: Project convention (Phase 34 OnModuleInit pattern)
get databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('FATAL: DATABASE_URL environment variable is required');
  }
  return url;
}
```

### Docker Compose Postgres Service

```yaml
# Recommendation: postgres:17-alpine for small image size
services:
  postgres:
    image: postgres:17-alpine
    ports:
      - '5432:5432'
    environment:
      POSTGRES_USER: botmem
      POSTGRES_PASSWORD: botmem
      POSTGRES_DB: botmem
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U botmem -d botmem']
      interval: 5s
      timeout: 3s
      retries: 5
      start_period: 5s
```

### Health Check Probe (Postgres)

```typescript
// Replace SQLite probe with Pool query
private async probePostgres(): Promise<boolean> {
  try {
    return await this.db.healthCheck();
  } catch {
    return false;
  }
}
```

## State of the Art

| Old Approach                         | Current Approach                | When Changed   | Impact                                           |
| ------------------------------------ | ------------------------------- | -------------- | ------------------------------------------------ |
| SQLite FTS5 virtual table + triggers | PostgreSQL tsvector + GIN index | This migration | No separate FTS table, no triggers, auto-indexed |
| JSON stored as text, parsed in app   | jsonb native type               | This migration | Query JSON in SQL, no parse/stringify overhead   |
| Integer booleans (0/1)               | Native boolean                  | This migration | Type-safe, no casting                            |
| ISO string timestamps                | timestamp with timezone         | This migration | Native date operations, timezone awareness       |
| Synchronous SQLite API               | Async pg Pool                   | This migration | All DB operations become async                   |
| File-based DB (./data/botmem.db)     | Network DB (DATABASE_URL)       | This migration | Requires running Postgres instance               |

## Open Questions

1. **Encrypted memory columns: text vs jsonb**
   - What we know: Memory text, entities, claims, metadata are encrypted at rest as `iv:data:tag` strings. This is incompatible with jsonb.
   - What's unclear: Whether to keep app-level encryption with text columns or move to Postgres-level encryption (pgcrypto).
   - Recommendation: Keep these as `text` type since they store encrypted ciphertext. The jsonb benefits are lost when data is encrypted anyway. Non-encrypted jsonb columns (factuality, weights) can use jsonb.

2. **Test strategy without in-memory SQLite**
   - What we know: Current tests use `better-sqlite3` in-memory DB. Postgres has no equivalent.
   - What's unclear: Whether to require a test Postgres instance or use pg-mem.
   - Recommendation: Require a test Postgres instance via Docker. Add `TEST_DATABASE_URL` to .env.example. Tests create/drop a unique database per test suite.

3. **Data migration from existing SQLite**
   - What we know: User said "existing dev data can be deleted without issues."
   - What's unclear: Whether production needs data migration.
   - Recommendation: No data migration script needed per user's data policy. Fresh start with Postgres.

## Validation Architecture

### Test Framework

| Property           | Value                                         |
| ------------------ | --------------------------------------------- |
| Framework          | Vitest 3                                      |
| Config file        | apps/api/vitest.config.ts (or vite.config.ts) |
| Quick run command  | `pnpm --filter @botmem/api test`              |
| Full suite command | `pnpm test`                                   |

### Phase Requirements -> Test Map

| Req ID | Behavior                                       | Test Type   | Automated Command                             | File Exists?                        |
| ------ | ---------------------------------------------- | ----------- | --------------------------------------------- | ----------------------------------- |
| DB-01  | PG schema has all 16 tables with correct types | integration | `pnpm --filter @botmem/api vitest run db`     | No -- Wave 0                        |
| DB-02  | N/A (overridden -- no abstraction layer)       | --          | --                                            | --                                  |
| DB-03  | N/A (overridden -- no conditional driver)      | --          | --                                            | --                                  |
| DB-04  | tsvector FTS returns matching memories         | integration | `pnpm --filter @botmem/api vitest run memory` | Partial (existing tests use SQLite) |

### Sampling Rate

- **Per task commit:** `pnpm --filter @botmem/api test`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `apps/api/src/__tests__/helpers/db.helper.ts` -- rewrite for Postgres (pg Pool or test container)
- [ ] `apps/api/src/db/__tests__/schema.test.ts` -- verify all tables created with correct PG types
- [ ] `apps/api/src/memory/__tests__/fts.test.ts` -- verify tsvector + pg_trgm search
- [ ] Test Postgres instance setup (Docker or TEST_DATABASE_URL)
- [ ] Update all existing tests that import from db.helper.ts

## Sources

### Primary (HIGH confidence)

- [Drizzle ORM PostgreSQL setup](https://orm.drizzle.team/docs/get-started-postgresql) - node-postgres driver, Pool setup, drizzle() initialization
- [Drizzle ORM PostgreSQL column types](https://orm.drizzle.team/docs/column-types/pg) - pgTable, text, integer, boolean, jsonb, timestamp, uuid
- [Drizzle ORM PostgreSQL FTS guide](https://orm.drizzle.team/docs/guides/postgresql-full-text-search) - tsvector, GIN index, ts_rank, tsquery functions
- [Drizzle ORM Generated Columns FTS](https://orm.drizzle.team/docs/guides/full-text-search-with-generated-columns) - tsvector generated column pattern
- [PostgreSQL official docs: Text Search](https://www.postgresql.org/docs/current/textsearch-tables.html) - tsvector, tsquery, GIN indexes

### Secondary (MEDIUM confidence)

- [NestJS + Drizzle + PostgreSQL tutorial](https://wanago.io/2024/05/20/api-nestjs-drizzle-orm-postgresql/) - NestJS integration pattern
- [Drizzle ORM PostgreSQL extensions](https://orm.drizzle.team/docs/extensions/pg) - Extension handling (pg_trgm not documented but works via raw SQL)

### Tertiary (LOW confidence)

- Multi-language tsvector (Arabic) - based on PostgreSQL docs for `simple` config, not verified with Drizzle specifically

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH - drizzle-orm/node-postgres is well-documented, pg is mature
- Architecture: HIGH - OnModuleInit pattern already established, schema rewrite is mechanical
- Pitfalls: HIGH - identified from direct code analysis of current SQLite usage
- FTS: MEDIUM - tsvector with Drizzle sql``is documented; Arabic language support via`simple` config needs validation
- Encrypted columns: MEDIUM - the text vs jsonb decision for encrypted fields needs careful implementation

**Research date:** 2026-03-09
**Valid until:** 2026-04-09 (stable domain, Drizzle 0.38.x API unlikely to break)

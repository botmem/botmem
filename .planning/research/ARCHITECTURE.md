# Botmem v2.0 — Security, Auth & Encryption Architecture

Research findings and concrete recommendations for adding multi-user auth, dual-database support, row-level security, client-side encryption, and memory banks to the existing NestJS 11 + Drizzle ORM codebase.

**Researched:** 2026-03-08
**Confidence:** HIGH (analysis based on direct codebase reading of all relevant files)

---

## Table of Contents

1. [Auth Guard Design](#1-auth-guard-design)
2. [Dual-Driver Database](#2-dual-driver-database)
3. [RLS Policy Structure](#3-rls-policy-structure)
4. [Key Derivation Flow](#4-key-derivation-flow)
5. [Auth Provider Abstraction](#5-auth-provider-abstraction)
6. [API Key Authentication](#6-api-key-authentication)
7. [Memory Bank Data Model](#7-memory-bank-data-model)

---

## 1. Auth Guard Design

### Current State

The codebase has **zero auth guards**. Every controller (MemoryController, AccountsController, AuthController, VersionController) is fully open. The WebSocket gateway at `/events` accepts all connections without authentication. The `auth/` module handles connector OAuth flows (Gmail, Slack), not user identity. There are no decorators, no middleware, no guards — the `apps/api/src/auth/guards/` directory does not exist.

### Recommendation: Global Guard + @Public() Decorator

Use NestJS's `APP_GUARD` to apply a JWT guard globally, then opt out specific routes with a custom `@Public()` decorator. This is the standard NestJS pattern and requires no changes to existing controllers — they become protected by default.

```
Request Flow:

  HTTP Request
       |
       v
  [Global JwtAuthGuard]
       |
       +-- Has @Public() metadata? --> Skip auth, proceed
       |
       +-- Has Bearer token? --> Validate
       |       |
       |       +-- JWT? --> Verify signature, extract userId
       |       |
       |       +-- API Key? --> Look up in api_keys table (see section 6)
       |
       +-- No token --> 401 Unauthorized
       |
       v
  req.user = { userId, email, ... }
       |
       v
  Controller handler
```

### File Structure

```
apps/api/src/
  auth/
    guards/
      jwt-auth.guard.ts        # Global guard (APP_GUARD)
    decorators/
      public.decorator.ts      # @Public() to skip auth
      current-user.decorator.ts # @CurrentUser() param decorator
    providers/
      auth-provider.interface.ts
      local-auth.provider.ts
      firebase-auth.provider.ts
    auth-provider.service.ts   # Wraps the active provider
    auth.controller.ts         # EXISTING — connector OAuth flows
    auth.service.ts            # EXISTING — connector OAuth orchestration
    user-auth.controller.ts    # NEW — signup/login/refresh/api-keys
    auth.module.ts             # Updated — registers guard globally
```

### Implementation Details

**@Public() decorator** — sets Reflector metadata to bypass the guard:

```typescript
// decorators/public.decorator.ts
import { SetMetadata } from '@nestjs/common';
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
```

**JwtAuthGuard** — global guard that checks `@Public()` first:

```typescript
// guards/jwt-auth.guard.ts
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private authProviderService: AuthProviderService, // see section 5
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const token = this.extractToken(request);
    if (!token) throw new UnauthorizedException();

    const user = await this.authProviderService.validateToken(token);
    request.user = user;
    return true;
  }

  private extractToken(request: any): string | null {
    const auth = request.headers?.authorization;
    if (!auth) return null;
    const [scheme, token] = auth.split(' ');
    return scheme === 'Bearer' ? token : null;
  }
}
```

**Registration** — in `AuthModule`, provide as `APP_GUARD`:

```typescript
providers: [
  { provide: APP_GUARD, useClass: JwtAuthGuard },
],
```

### Routes That Need @Public()

| Route | Reason |
|---|---|
| `GET /api/version` | Health check, no auth needed |
| `GET /api/auth/:type/callback` | OAuth redirect from Google/Slack — browser redirect, no Bearer token |
| `POST /api/auth/signup` | User registration (no token yet) |
| `POST /api/auth/login` | User login (no token yet) |
| `POST /api/auth/refresh` | Token refresh (uses refresh token, not access token) |

Note: `POST /api/auth/:type/initiate` (connector OAuth) should **require** user auth in v2.0 — connector accounts are owned by users.

### WebSocket Auth

The current `EventsGateway` uses raw `ws` (not Socket.IO) via NestJS's `WsAdapter`. NestJS guards can apply to WebSocket gateways, but the `ws` adapter passes the HTTP upgrade request, not a normal request object.

**Recommended approach**: Authenticate on the HTTP upgrade request. The token is passed as a query parameter (`ws://host/events?token=xxx`). Validate in `handleConnection`:

```typescript
@WebSocketGateway({ path: '/events' })
export class EventsGateway implements OnGatewayConnection {
  constructor(private authProvider: AuthProviderService) {}

  async handleConnection(client: WebSocket, req: IncomingMessage) {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    if (!token) { client.close(4001, 'Missing token'); return; }

    try {
      const user = await this.authProvider.validateToken(token);
      (client as any).__user = user; // attach for later use in subscriptions
    } catch {
      client.close(4003, 'Invalid token');
    }
  }
}
```

The `handleSubscribe` method should then scope channel subscriptions to the user — a user can only subscribe to channels that belong to their own jobs/accounts.

### CLI Access

The `packages/cli` (`botmem` command) needs to authenticate. Two options coexist:

1. **API Key** (recommended for CLI/agents) — user generates a key in the web UI, passes via `--api-key` flag or `BOTMEM_API_KEY` env var. The guard treats it as a Bearer token and resolves it to a user (see section 6).
2. **JWT login flow** — `botmem login` could open a browser for OAuth, receive a JWT, store it in `~/.botmem/credentials.json`. More complex, better UX for interactive use.

The guard checks the token format to distinguish JWT from API key (API keys start with `bmk_`).

---

## 2. Dual-Driver Database

### Current State

`DbService` is tightly coupled to better-sqlite3:

- Imports `Database` from `better-sqlite3` directly
- Calls `this.sqlite.pragma('journal_mode = WAL')`
- Uses raw `.exec()` for DDL (the entire `createTables()` method is raw SQL)
- Exposes `BetterSQLite3Database<typeof schema>` as its public type
- Services throughout the codebase call `.get()` (synchronous, SQLite-only) and `.all()` (synchronous) and `.run()` (synchronous)

These synchronous methods do not exist on Drizzle's PostgreSQL driver, which is fully async.

### Schema Divergence Points

| Feature | SQLite (current) | PostgreSQL |
|---|---|---|
| Column types | `text()`, `integer()`, `real()` | `text()`, `integer()`, `doublePrecision()`, `uuid()`, `timestamp()`, `jsonb()`, `boolean()` |
| JSON storage | `text` column, `JSON.parse()` at app layer | `jsonb` — queryable, indexable |
| UUID PKs | `text('id')` + `crypto.randomUUID()` | `uuid('id').defaultRandom()` |
| Timestamps | `text` (ISO strings) | `timestamp('...', { withTimezone: true })` |
| FTS | `FTS5` virtual table + triggers | `tsvector` + `GIN` index + `to_tsvector()`/`plainto_tsquery()` |
| Boolean | `integer` (0/1) | native `boolean` |
| Unique dedup | `UNIQUE INDEX` (same) | `UNIQUE INDEX` (same) |

### Recommended Architecture

Two schema files, one shared interface, conditional driver initialization.

```
apps/api/src/db/
  schema.ts              # SQLite schema (existing, unchanged)
  schema.pg.ts           # PostgreSQL schema (new — adds user_id, bank_id, uses PG types)
  db.interface.ts        # Shared type alias for the Drizzle instance
  db.service.ts          # Conditional factory — reads DB_DRIVER env var
  drivers/
    sqlite.driver.ts     # SQLite-specific init (current createTables logic)
    postgres.driver.ts   # PostgreSQL-specific init (migrations via drizzle-kit)
  migrations/
    sqlite/              # Drizzle Kit SQLite migrations
    pg/                  # Drizzle Kit PostgreSQL migrations
```

### Shared Database Type

The key insight is that Drizzle's query builder API (`.select().from().where()`) is **identical** across SQLite and PostgreSQL drivers. The divergence is only in:

1. Schema definitions (column type constructors) — two schema files
2. Synchronous vs async result access — standardize on async
3. Raw SQL (DDL, FTS, pragmas) — driver-specific code

```typescript
// db.interface.ts
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as sqliteSchema from './schema';
import type * as pgSchema from './schema.pg';

// Union type — services use this, don't care which driver
export type BotmemDb = BetterSQLite3Database<typeof sqliteSchema> | NodePgDatabase<typeof pgSchema>;

export type DbDriver = 'sqlite' | 'postgres';
```

### Solving the Sync/Async Problem

The current codebase uses `.get()` (sync) extensively — at least in `AuthService`, `AccountsService`, `MemoryService`, `ContactsService`. PostgreSQL's Drizzle driver is fully async. The fix is mechanical:

```typescript
// Before (SQLite-only, sync):
const row = db.select().from(accounts).where(eq(accounts.id, id)).get();

// After (works with both, async):
const [row] = await db.select().from(accounts).where(eq(accounts.id, id)).limit(1);

// Before (sync):
const rows = db.select().from(memories).where(...).all();

// After (async):
const rows = await db.select().from(memories).where(...);

// Before (sync):
db.insert(accounts).values({...}).run();

// After (async):
await db.insert(accounts).values({...});
```

This refactor touches every service file but is straightforward — search for `.get()`, `.all()`, `.run()` and convert. The SQLite Drizzle driver supports both sync and async, so the async versions work for both drivers.

### Conditional Driver Initialization

```typescript
// db.service.ts
@Injectable()
export class DbService implements OnModuleInit {
  public db!: BotmemDb;
  public driverType!: DbDriver;

  constructor(private config: ConfigService) {}

  async onModuleInit() {
    this.driverType = this.config.dbDriver;

    if (this.driverType === 'postgres') {
      const { Pool } = await import('pg');
      const { drizzle } = await import('drizzle-orm/node-postgres');
      const pgSchema = await import('./schema.pg');
      const pool = new Pool({ connectionString: this.config.databaseUrl });
      this.db = drizzle(pool, { schema: pgSchema });
      // Run Drizzle Kit migrations
      await this.runPgMigrations();
    } else {
      const Database = (await import('better-sqlite3')).default;
      const { drizzle } = await import('drizzle-orm/better-sqlite3');
      const sqliteSchema = await import('./schema');
      mkdirSync(dirname(this.config.dbPath), { recursive: true });
      const sqlite = new Database(this.config.dbPath);
      sqlite.pragma('journal_mode = WAL');
      this.db = drizzle(sqlite, { schema: sqliteSchema });
      this.createSqliteTables(sqlite);
    }
  }

  /** Wrap query in user context for RLS (Postgres only) */
  async withUserContext<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    if (this.driverType !== 'postgres') return fn();
    // See section 3 for implementation
  }
}
```

### ConfigService Additions

```typescript
get dbDriver(): 'sqlite' | 'postgres' {
  return (process.env.DB_DRIVER as 'sqlite' | 'postgres') || 'sqlite';
}

get databaseUrl(): string {
  return process.env.DATABASE_URL || 'postgres://botmem:botmem@localhost:5432/botmem';
}
```

### PostgreSQL Schema File (schema.pg.ts)

```typescript
import { pgTable, uuid, text, integer, doublePrecision,
         timestamp, jsonb, boolean } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  authProvider: text('auth_provider').notNull().default('local'),
  passwordHash: text('password_hash'),
  kdfSalt: text('kdf_salt'),          // for client-side key derivation
  encryptedDek: text('encrypted_dek'), // wrapped data encryption key
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const memoryBanks = pgTable('memory_banks', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  isDefault: boolean('is_default').notNull().default(false),
  isEncrypted: boolean('is_encrypted').notNull().default(false),
  settings: jsonb('settings').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable('accounts', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  connectorType: text('connector_type').notNull(),
  identifier: text('identifier').notNull(),
  status: text('status').notNull().default('disconnected'),
  schedule: text('schedule').notNull().default('manual'),
  authContext: text('auth_context'),
  lastCursor: text('last_cursor'),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  itemsSynced: integer('items_synced').notNull().default(0),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const memories = pgTable('memories', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  bankId: uuid('bank_id').references(() => memoryBanks.id),
  accountId: uuid('account_id').references(() => accounts.id),
  connectorType: text('connector_type').notNull(),
  sourceType: text('source_type').notNull(),
  sourceId: text('source_id').notNull(),
  text: text('text').notNull(),
  eventTime: timestamp('event_time', { withTimezone: true }).notNull(),
  ingestTime: timestamp('ingest_time', { withTimezone: true }).notNull(),
  factuality: jsonb('factuality').notNull()
    .default({ label: 'UNVERIFIED', confidence: 0.5, rationale: 'Pending evaluation' }),
  weights: jsonb('weights').notNull()
    .default({ semantic: 0, rerank: 0, recency: 0, importance: 0.5, trust: 0.5, final: 0 }),
  entities: jsonb('entities').notNull().default([]),
  claims: jsonb('claims').notNull().default([]),
  metadata: jsonb('metadata').notNull().default({}),
  embeddingStatus: text('embedding_status').notNull().default('pending'),
  pinned: boolean('pinned').notNull().default(false),
  recallCount: integer('recall_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const contacts = pgTable('contacts', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  displayName: text('display_name').notNull(),
  entityType: text('entity_type').notNull().default('person'),
  avatars: jsonb('avatars').notNull().default([]),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ... remaining tables follow the same pattern: add userId where needed,
// use PG types (uuid, timestamp, jsonb, boolean), keep structure identical

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  keyPrefix: text('key_prefix').notNull(),
  scopes: jsonb('scopes').notNull().default(['*']),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

### Migration Strategy

Replace the current raw `.exec()` DDL in `DbService.createTables()` with Drizzle Kit migrations:

```
drizzle.sqlite.config.ts   # points to schema.ts, outputs to migrations/sqlite/
drizzle.pg.config.ts        # points to schema.pg.ts, outputs to migrations/pg/
```

The current `createTables()` + `ALTER TABLE` migration approach moves to versioned SQL files managed by `drizzle-kit generate` and applied by `drizzle-kit migrate`. This is a one-time migration from manual DDL to managed migrations.

---

## 3. RLS Policy Structure

### When RLS Applies

RLS is **PostgreSQL-only**. When `DB_DRIVER=sqlite`, data isolation is enforced at the application layer via Drizzle query filters (`.where(eq(table.userId, currentUserId))`). When `DB_DRIVER=postgres`, RLS provides a database-level safety net on top of application-level filters.

### Setting User Context Per Request

PostgreSQL RLS reads session-level variables. The app must set `app.current_user_id` at the start of every request. Since this needs the userId extracted by the auth guard, it runs **after** the guard, making it an **interceptor** (not middleware):

```
Request lifecycle with RLS:

  [JwtAuthGuard extracts userId]
       |
       v
  [RlsInterceptor]
       |
       +-- Is Postgres? --> Begin transaction
       |                     SET LOCAL app.current_user_id = 'uuid';
       |                     Execute handler inside transaction
       |                     Commit/rollback
       |
       +-- Is SQLite? --> Pass through (no RLS)
       |
       v
  [Controller handler runs inside RLS-scoped transaction]
```

### NestJS Interceptor Implementation

```typescript
// interceptors/rls.interceptor.ts
@Injectable()
export class RlsInterceptor implements NestInterceptor {
  constructor(private dbService: DbService) {}

  async intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest();
    const userId = request.user?.userId;

    if (!userId || this.dbService.driverType !== 'postgres') {
      return next.handle();
    }

    // Wrap the entire request handler in a transaction with RLS context
    return from(
      this.dbService.withUserContext(userId, () =>
        firstValueFrom(next.handle()),
      ),
    );
  }
}
```

**DbService.withUserContext** (Postgres driver):

```typescript
async withUserContext<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  if (this.driverType !== 'postgres') return fn();

  return (this.db as NodePgDatabase).transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.current_user_id = ${userId}`);
    // Replace this.db temporarily so all queries in fn() use the tx
    const originalDb = this.db;
    this.db = tx as any;
    try {
      return await fn();
    } finally {
      this.db = originalDb;
    }
  });
}
```

`SET LOCAL` is scoped to the current transaction — it auto-resets on commit/rollback. No risk of leaking user context between requests.

### RLS Policy Definitions

```sql
-- Enable RLS on all user-scoped tables (run once during migration)
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories FORCE ROW LEVEL SECURITY;

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;

ALTER TABLE memory_banks ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_banks FORCE ROW LEVEL SECURITY;

ALTER TABLE raw_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_events FORCE ROW LEVEL SECURITY;

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;

-- Policy: memories — user sees only their own
CREATE POLICY memories_isolation ON memories
  FOR ALL
  USING (user_id = current_setting('app.current_user_id')::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id')::uuid);

-- Policy: accounts — user sees only their own
CREATE POLICY accounts_isolation ON accounts
  FOR ALL
  USING (user_id = current_setting('app.current_user_id')::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id')::uuid);

-- Policy: contacts — user sees only their own
CREATE POLICY contacts_isolation ON contacts
  FOR ALL
  USING (user_id = current_setting('app.current_user_id')::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id')::uuid);

-- Policy: memory_banks — user sees only their own
CREATE POLICY banks_isolation ON memory_banks
  FOR ALL
  USING (user_id = current_setting('app.current_user_id')::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id')::uuid);

-- Policy: raw_events — scoped through account ownership (no direct user_id column)
CREATE POLICY raw_events_isolation ON raw_events
  FOR ALL
  USING (account_id IN (
    SELECT id FROM accounts
    WHERE user_id = current_setting('app.current_user_id')::uuid
  ));

-- Policy: jobs — scoped through account ownership
CREATE POLICY jobs_isolation ON jobs
  FOR ALL
  USING (account_id IN (
    SELECT id FROM accounts
    WHERE user_id = current_setting('app.current_user_id')::uuid
  ));

-- Policy: api_keys — user sees only their own
CREATE POLICY api_keys_isolation ON api_keys
  FOR ALL
  USING (user_id = current_setting('app.current_user_id')::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id')::uuid);
```

**Tables WITHOUT RLS** (global/system tables):
- `settings` — app-wide configuration, not user-scoped
- `connector_credentials` — shared OAuth client configs (clientId/clientSecret per connector type)
- `users` — the users table itself (auth queries need to look up any user by email)

### RLS + Drizzle ORM Interaction

Drizzle is transparent to RLS. It sends standard SQL queries, and PostgreSQL applies RLS policies before returning results. As long as:

1. `app.current_user_id` is set (via the interceptor) before any query
2. All queries run inside the transaction started by the interceptor
3. The database role has `FORCE ROW LEVEL SECURITY` enabled

Then Drizzle queries like `db.select().from(memories).where(...)` automatically return only the current user's rows. No changes to Drizzle query code needed for RLS (but application-level userId filters are still recommended as defense-in-depth).

### Background Workers (BullMQ Processors)

BullMQ processors run outside HTTP request context — there is no guard, no interceptor. They must set RLS context manually. Every job payload must include `userId`:

```typescript
// In SyncProcessor, EmbedProcessor, EnrichProcessor:
async process(job: Job<{ rawEventId: string; userId: string }>) {
  await this.dbService.withUserContext(job.data.userId, async () => {
    // All queries here are RLS-scoped to this user
    // ... existing processor logic
  });
}
```

This means the sync trigger in `JobsService.triggerSync()` must pass `userId` into the BullMQ job data. The userId comes from `req.user` in the controller that initiates the sync.

### SQLite Fallback (Application-Level Isolation)

For single-user SQLite, the simplest approach is to skip user filtering entirely (one user = all data is theirs). For multi-user SQLite (unlikely but possible), add `.where(eq(table.userId, userId))` to every query. A helper function avoids repetition:

```typescript
// db/scoping.ts
export function userScope(userId: string) {
  return (table: { userId: any }) => eq(table.userId, userId);
}

// Usage in services:
const rows = await db.select().from(memories)
  .where(and(userScope(userId)(memories), ...otherFilters));
```

---

## 4. Key Derivation Flow

### Architecture Overview

Client-side encryption means the server never sees plaintext memory content. The encryption key is derived from the user's password on the client, used to encrypt/decrypt in the browser, and never sent to the server.

```
Key Derivation + Encryption Flow:

  [User enters password in browser]
       |
       v
  [Argon2id(password, salt)]
  Parameters: t=3 iterations, m=64MB memory, p=4 parallelism
       |
       v
  masterKey (256 bits) -- lives in browser memory ONLY, never persisted
       |
       v
  [HKDF-SHA256(masterKey, "botmem-data-encryption")]
       |
       v
  DEK (Data Encryption Key, 256 bits)
       |
       +----> Encrypt/decrypt memory text+metadata
       |        AES-256-GCM per field
       |        Each encryption: random 12-byte IV + 16-byte auth tag
       |        Stored: { ct: base64(ciphertext), iv: base64(iv), tag: base64(tag) }
       |
       +----> Wrapped (encrypted) with masterKey for server storage
                wrappedDek = AES-256-GCM(masterKey, dek)
                Server stores wrappedDek — cannot unwrap without masterKey
```

### Where Keys Live

| Key | Location | Lifetime | Who Can Access |
|---|---|---|---|
| Password | User's brain | N/A | User only |
| Salt | Server DB (`users.kdf_salt`) | Permanent, per-user | Server + client |
| Master Key | Browser memory (`CryptoKey`) | Current session only | Client JS only |
| DEK | Browser memory (unwrapped from server) | Current session only | Client JS only |
| Wrapped DEK | Server DB (`users.encrypted_dek`) | Until password change | Server stores, cannot unwrap |
| Per-field IV | Stored alongside ciphertext | Per-encryption | Public (safe by design) |

### First-Time Setup Flow

```
1. User creates account with password
2. Browser:
   a. salt = crypto.getRandomValues(new Uint8Array(32))
   b. masterKey = argon2id(password, salt, {t:3, m:65536, p:4})
   c. dek = crypto.getRandomValues(new Uint8Array(32))
   d. wrappedDek = AES-256-GCM.encrypt(masterKey, dek)
3. Browser sends to server: { salt: base64(salt), wrappedDek: base64(wrappedDek) }
4. Server stores salt and wrappedDek in users table
5. Browser keeps masterKey and dek in memory for the session
```

### Login Flow

```
1. User enters password
2. Browser:
   a. Fetch { salt, wrappedDek } from GET /api/auth/me/key-material
   b. masterKey = argon2id(password, base64decode(salt), {t:3, m:65536, p:4})
   c. dek = AES-256-GCM.decrypt(masterKey, base64decode(wrappedDek))
   d. If decryption fails: wrong password (wrappedDek integrity check fails)
3. Browser keeps dek in memory for the session
```

### Password Change Flow (No Re-encryption of Memories)

```
1. User enters oldPassword + newPassword
2. Browser:
   a. Fetch { salt: oldSalt, wrappedDek } from server
   b. oldMasterKey = argon2id(oldPassword, oldSalt)
   c. dek = AES-256-GCM.decrypt(oldMasterKey, wrappedDek)
   d. newSalt = crypto.getRandomValues(32)
   e. newMasterKey = argon2id(newPassword, newSalt)
   f. newWrappedDek = AES-256-GCM.encrypt(newMasterKey, dek)
3. Browser sends: { newSalt, newWrappedDek } to PUT /api/auth/me/key-material
4. Server updates salt and wrappedDek

The DEK is unchanged. All existing encrypted memories remain readable
because they were encrypted with the DEK, not the masterKey.
```

### What Gets Encrypted (Per Field)

| Field | Encrypted? | Reason |
|---|---|---|
| `memories.text` | YES | Primary content, contains PII |
| `memories.entities` | YES | Contains names, locations, amounts |
| `memories.claims` | YES | Contains extracted factual statements |
| `memories.metadata` | YES (selective keys) | May contain subject lines, filenames |
| `memories.factuality` | No | Server needs for filtering |
| `memories.weights` | No | Server needs for scoring/ranking |
| `memories.eventTime` | No | Server needs for temporal queries |
| `memories.sourceType` | No | Server needs for filtering |
| `memories.connectorType` | No | Server needs for filtering |
| `memories.embeddingStatus` | No | Pipeline tracking |
| `contacts.displayName` | YES | PII — names |
| `contacts.metadata` | YES | PII — phone numbers, etc |
| `accounts.authContext` | Already encrypted at rest | OAuth tokens (existing) |

### Impact on Search and Pipeline

With client-side encryption, the server cannot:
- Generate embeddings (it never sees plaintext)
- Run enrichment (entity extraction, factuality classification)
- Perform FTS search

**Two modes of operation based on bank encryption setting:**

```
Unencrypted bank (default):
  Full pipeline — server receives plaintext, embeds, enriches, indexes

Encrypted bank (opt-in):
  Client encrypts before upload
  Client generates embedding (ONNX/WASM nomic-embed-text in browser)
  Client sends: { ciphertext, embedding vector }
  Server stores ciphertext + upserts vector to Qdrant
  Server CANNOT enrich, extract entities, or classify factuality
  Search: vector search works (embedding is not encrypted)
          FTS does NOT work (text is ciphertext)
          Decryption happens client-side after results are returned
```

### Browser Implementation Libraries

- **Argon2id**: `hash-wasm` (pure WASM, 2KB gzipped, no native deps)
- **AES-256-GCM**: Web Crypto API (`crypto.subtle.encrypt/decrypt`) — native, zero dependencies
- **HKDF**: Web Crypto API (`crypto.subtle.deriveKey` with HKDF algorithm)
- **Embedding in browser**: `@xenova/transformers` (ONNX Runtime Web) for `nomic-embed-text` — ~50MB model download, cached in IndexedDB

### API Endpoints for Key Material

```typescript
@Controller('auth/me')
export class UserAuthController {
  @Get('key-material')   // Returns { salt, wrappedDek } for the current user
  @Put('key-material')   // Updates { salt, wrappedDek } on password change
}
```

---

## 5. Auth Provider Abstraction

### Current State

There is no user authentication system. The `auth/` module handles connector OAuth flows only (Gmail, Slack, WhatsApp). There is no `users` table, no login endpoint, no JWT signing.

### Strategy Pattern

```
AUTH_PROVIDER env var selects the implementation:

  ConfigService.authProvider
       |
       +-- "local" (default)
       |     LocalAuthProvider
       |     - Argon2id password hashing
       |     - JWT signing with HS256 (secret from JWT_SECRET env)
       |     - Refresh tokens in refresh_tokens table
       |     - Full control, no external dependencies
       |
       +-- "firebase"
             FirebaseAuthProvider
             - Firebase Admin SDK verifies ID tokens
             - User created in local DB on first login (JIT provisioning)
             - No password storage, no JWT signing (Firebase handles it)
             - Refresh handled by Firebase client SDK
```

### Interface

```typescript
// auth/providers/auth-provider.interface.ts
export interface AuthUser {
  userId: string;
  email: string;
  displayName: string;
  provider: 'local' | 'firebase';
}

export interface AuthProvider {
  /** Validate a Bearer token (JWT or API key). Returns the user. Throws on invalid. */
  validateToken(token: string): Promise<AuthUser>;

  /** Create a new user account. Returns user + tokens. */
  createUser(email: string, password: string, displayName: string): Promise<{
    user: AuthUser;
    accessToken: string;
    refreshToken: string;
  }>;

  /** Authenticate with email/password. Returns tokens. */
  login(email: string, password: string): Promise<{
    user: AuthUser;
    accessToken: string;
    refreshToken: string;
  }>;

  /** Exchange a refresh token for new access + refresh tokens. */
  refresh(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
  }>;

  /** Revoke a refresh token (logout). */
  revoke(refreshToken: string): Promise<void>;
}
```

### LocalAuthProvider (Detailed)

```typescript
@Injectable()
export class LocalAuthProvider implements AuthProvider {
  constructor(
    private dbService: DbService,
    private jwtService: JwtService,
  ) {}

  async validateToken(token: string): Promise<AuthUser> {
    // API key check (see section 6)
    if (token.startsWith('bmk_')) {
      return this.validateApiKey(token);
    }

    // JWT verification
    try {
      const payload = this.jwtService.verify(token);
      return {
        userId: payload.sub,
        email: payload.email,
        displayName: payload.name,
        provider: 'local',
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  async createUser(email: string, password: string, displayName: string) {
    // Check for existing user
    const existing = await this.dbService.db
      .select().from(users).where(eq(users.email, email)).limit(1);
    if (existing.length) throw new ConflictException('Email already registered');

    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const userId = crypto.randomUUID();

    await this.dbService.db.insert(users).values({
      id: userId, email, displayName, passwordHash, authProvider: 'local',
      createdAt: new Date().toISOString(),
    });

    // Create default memory bank
    await this.dbService.db.insert(memoryBanks).values({
      id: crypto.randomUUID(),
      userId, name: 'Personal', isDefault: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const tokens = this.generateTokens(userId, email, displayName);
    return { user: { userId, email, displayName, provider: 'local' as const }, ...tokens };
  }

  async login(email: string, password: string) {
    const [user] = await this.dbService.db
      .select().from(users).where(eq(users.email, email)).limit(1);
    if (!user || !user.passwordHash) throw new UnauthorizedException('Invalid credentials');
    if (!await argon2.verify(user.passwordHash, password)) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const tokens = this.generateTokens(user.id, user.email, user.displayName);
    return {
      user: { userId: user.id, email: user.email, displayName: user.displayName, provider: 'local' as const },
      ...tokens,
    };
  }

  private generateTokens(userId: string, email: string, name: string) {
    const accessToken = this.jwtService.sign(
      { sub: userId, email, name },
      { expiresIn: '15m' },
    );
    const refreshToken = crypto.randomUUID();
    // Store refresh token with expiry (e.g., 30 days)
    // ... insert into refresh_tokens table
    return { accessToken, refreshToken };
  }
}
```

### FirebaseAuthProvider

```typescript
@Injectable()
export class FirebaseAuthProvider implements AuthProvider {
  private firebaseApp: admin.app.App;

  constructor(private dbService: DbService, private config: ConfigService) {
    this.firebaseApp = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: config.firebaseProjectId,
        clientEmail: config.firebaseClientEmail,
        privateKey: config.firebasePrivateKey,
      }),
    });
  }

  async validateToken(token: string): Promise<AuthUser> {
    // API key passthrough
    if (token.startsWith('bmk_')) {
      return this.validateApiKey(token);
    }

    const decoded = await this.firebaseApp.auth().verifyIdToken(token);
    const user = await this.ensureUserExists(decoded.uid, decoded.email!, decoded.name || decoded.email!);
    return { userId: user.id, email: user.email, displayName: user.displayName, provider: 'firebase' };
  }

  /** JIT provisioning — create local user record on first Firebase login */
  private async ensureUserExists(firebaseUid: string, email: string, displayName: string) {
    const [existing] = await this.dbService.db
      .select().from(users).where(eq(users.id, firebaseUid)).limit(1);
    if (existing) return existing;

    await this.dbService.db.insert(users).values({
      id: firebaseUid, email, displayName, authProvider: 'firebase',
      createdAt: new Date().toISOString(),
    });
    // Create default memory bank
    await this.dbService.db.insert(memoryBanks).values({
      id: crypto.randomUUID(),
      userId: firebaseUid, name: 'Personal', isDefault: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return { id: firebaseUid, email, displayName };
  }

  // login/createUser throw — these happen client-side with Firebase SDK
  async login() { throw new BadRequestException('Use Firebase client SDK for login'); }
  async createUser() { throw new BadRequestException('Use Firebase client SDK for signup'); }
  async refresh() { throw new BadRequestException('Use Firebase client SDK for token refresh'); }
  async revoke() { /* Firebase handles token revocation */ }
}
```

### Provider Registration (AuthModule)

```typescript
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.jwtSecret,
        signOptions: { expiresIn: config.jwtExpiresIn },
      }),
    }),
  ],
  providers: [
    // Factory that selects the right provider based on env var
    {
      provide: 'AUTH_PROVIDER',
      useFactory: (config: ConfigService, db: DbService, jwt: JwtService) => {
        if (config.authProvider === 'firebase') {
          return new FirebaseAuthProvider(db, config);
        }
        return new LocalAuthProvider(db, jwt);
      },
      inject: [ConfigService, DbService, JwtService],
    },
    // Convenience wrapper so other modules inject AuthProviderService
    AuthProviderService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  controllers: [AuthController, UserAuthController],
  exports: [AuthProviderService],
})
export class AuthModule {}
```

**AuthProviderService** simply delegates to the injected `AUTH_PROVIDER`:

```typescript
@Injectable()
export class AuthProviderService {
  constructor(@Inject('AUTH_PROVIDER') private provider: AuthProvider) {}

  validateToken(token: string) { return this.provider.validateToken(token); }
  createUser(...args: any[]) { return this.provider.createUser(...args); }
  login(...args: any[]) { return this.provider.login(...args); }
  refresh(rt: string) { return this.provider.refresh(rt); }
  revoke(rt: string) { return this.provider.revoke(rt); }
}
```

### ConfigService Additions

```typescript
get authProvider(): 'local' | 'firebase' {
  return (process.env.AUTH_PROVIDER as any) || 'local';
}

get jwtSecret(): string {
  return process.env.JWT_SECRET || 'change-me-in-production';
}

get jwtExpiresIn(): string {
  return process.env.JWT_EXPIRES_IN || '15m';
}

get firebaseProjectId(): string {
  return process.env.FIREBASE_PROJECT_ID || '';
}

get firebaseClientEmail(): string {
  return process.env.FIREBASE_CLIENT_EMAIL || '';
}

get firebasePrivateKey(): string {
  return (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
}
```

---

## 6. API Key Authentication

### Design

API keys coexist with JWT tokens in the same `Bearer` header. The guard distinguishes them by format prefix:

```
Token Classification in JwtAuthGuard:

  Bearer <token>
       |
       +-- starts with "bmk_" --> API Key path
       |       |
       |       v
       |   hash = SHA-256(token)
       |   lookup api_keys table by key_hash
       |       |
       |       v
       |   Found? --> Check expiry, resolve userId, return AuthUser
       |   Not found? --> 401 Unauthorized
       |
       +-- otherwise --> JWT path
               |
               v
           jwtService.verify(token) --> extract sub, email, name
```

### API Key Format

```
bmk_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2

Prefix:  bmk_           (4 chars — identifies as botmem API key)
Random:  44 chars        (crypto.randomBytes(33).toString('base64url'))
Total:   48 chars
```

The prefix makes it easy for the guard to detect without attempting JWT verification, and easy for secret scanning tools (e.g., GitHub's push protection) to identify leaked keys.

### Database Schema

```sql
-- In schema.pg.ts (already shown above)
-- For SQLite, add to schema.ts:
export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),  -- in SQLite, just text; single user anyway
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  keyPrefix: text('key_prefix').notNull(),
  scopes: text('scopes').notNull().default('["*"]'),
  lastUsedAt: text('last_used_at'),
  expiresAt: text('expires_at'),
  createdAt: text('created_at').notNull(),
});
```

**Security**: The full API key is shown exactly once at creation time. The server stores only the SHA-256 hash. On each request, the guard hashes the incoming key and matches against stored hashes.

### Guard Integration

Inside `JwtAuthGuard.canActivate()`:

```typescript
private async resolveToken(token: string): Promise<AuthUser> {
  if (token.startsWith('bmk_')) {
    return this.resolveApiKey(token);
  }
  return this.authProvider.validateToken(token);
}

private async resolveApiKey(key: string): Promise<AuthUser> {
  const hash = createHash('sha256').update(key).digest('hex');
  const [row] = await this.dbService.db
    .select().from(apiKeys).where(eq(apiKeys.keyHash, hash)).limit(1);

  if (!row) throw new UnauthorizedException('Invalid API key');

  if (row.expiresAt && new Date(row.expiresAt) < new Date()) {
    throw new UnauthorizedException('API key expired');
  }

  // Update last_used_at asynchronously (fire-and-forget)
  this.dbService.db.update(apiKeys)
    .set({ lastUsedAt: new Date().toISOString() })
    .where(eq(apiKeys.id, row.id))
    .then(() => {}) // swallow
    .catch(() => {}); // swallow

  // Resolve the key's owner
  const [user] = await this.dbService.db
    .select().from(users).where(eq(users.id, row.userId)).limit(1);
  if (!user) throw new UnauthorizedException('API key owner not found');

  return {
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    provider: 'local',
  };
}
```

### Management Endpoints

```typescript
@Controller('api-keys')
export class ApiKeysController {
  @Post()
  async create(@Body() body: { name: string; expiresIn?: string }, @Req() req: any) {
    const rawKey = 'bmk_' + randomBytes(33).toString('base64url');
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.slice(0, 12) + '...';

    await this.db.insert(apiKeys).values({
      id: randomUUID(),
      userId: req.user.userId,
      name: body.name,
      keyHash,
      keyPrefix,
      createdAt: new Date().toISOString(),
      expiresAt: body.expiresIn ? this.computeExpiry(body.expiresIn) : null,
    });

    // Return the FULL key exactly once
    return { key: rawKey, prefix: keyPrefix, name: body.name };
  }

  @Get()
  async list(@Req() req: any) {
    // NEVER return keyHash — only prefix, name, lastUsed, expires
    return this.db.select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.keyPrefix,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      createdAt: apiKeys.createdAt,
    }).from(apiKeys).where(eq(apiKeys.userId, req.user.userId));
  }

  @Delete(':id')
  async revoke(@Param('id') id: string, @Req() req: any) {
    await this.db.delete(apiKeys)
      .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, req.user.userId)));
    return { ok: true };
  }
}
```

### CLI Integration

```typescript
// packages/cli/src/cli.ts
// Add --api-key option alongside --api-url
const apiKey = process.env.BOTMEM_API_KEY || flags['api-key'];

// All HTTP requests include the key:
const headers: Record<string, string> = {};
if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
```

---

## 7. Memory Bank Data Model

### Concept

A memory bank is a logical partition of a user's memories. Every user has at least one default bank. Use cases:

- **Personal** (default) — all connectors feed here unless configured otherwise
- **Work** — only Slack + work Gmail accounts route here
- **Archive** — manually moved old memories
- **Encrypted** — client-side encrypted bank with limited server-side pipeline
- Future: **Shared** — grant another user read access to a specific bank

### Database Schema

```sql
-- memory_banks table (shown in schema.pg.ts above)
CREATE TABLE memory_banks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_encrypted BOOLEAN NOT NULL DEFAULT false,
  settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(user_id, name)
);

-- memories.bank_id FK (added in schema.pg.ts)
-- Nullable: null means "use default bank" (backward compat for migrated data)

-- Account-to-bank routing: which bank should new memories from this account go to?
CREATE TABLE account_bank_mappings (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  bank_id UUID NOT NULL REFERENCES memory_banks(id) ON DELETE CASCADE,
  PRIMARY KEY (account_id, bank_id)
);
```

### Qdrant Strategy: Single Collection with Payload Filters

**Recommended: payload filter approach.** One `memories` collection, each point carries `user_id` and `bank_id` in its payload.

```
Single "memories" Qdrant collection:

  Point payload: {
    memory_id: "uuid",
    user_id: "uuid",          <-- NEW (for user isolation)
    bank_id: "uuid",          <-- NEW (for bank scoping)
    source_type: "email",
    connector_type: "gmail",
    event_time: "2026-03-01T..."
  }

  Search filter example:
  {
    must: [
      { key: "user_id", match: { value: "user-uuid" } },
      { key: "bank_id", match: { value: "bank-uuid" } }
    ]
  }

  Cross-bank search (all user's memories):
  {
    must: [
      { key: "user_id", match: { value: "user-uuid" } }
    ]
  }
```

**Why NOT collection-per-bank or collection-per-user:**

| Approach | Pros | Cons |
|---|---|---|
| Single collection + payload filter | Simple ops, cross-bank search trivial, one HNSW index | Slightly larger index |
| Collection per user | Natural isolation | Collection creation overhead, cross-user search impossible (fine), but Qdrant recommends payload filters for <1M users |
| Collection per bank | Maximum isolation | Excessive collections (user x banks), cross-bank search requires multi-collection query, HNSW index per collection wastes memory |

Qdrant's documentation explicitly recommends payload-based filtering for multi-tenancy up to millions of tenants, using keyword payload indexes for fast filtering.

### Payload Index Setup

Add to `QdrantService.onModuleInit()`:

```typescript
async onModuleInit() {
  await this.ensureCollection(768);
  await this.ensureIndexed();
  await this.ensureTemporalIndex();
  // NEW: user and bank indexes for multi-tenant filtering
  await this.ensurePayloadIndex('user_id', 'keyword');
  await this.ensurePayloadIndex('bank_id', 'keyword');
}

private async ensurePayloadIndex(field: string, schema: string) {
  try {
    await this.client.createPayloadIndex(QdrantService.COLLECTION, {
      field_name: field,
      field_schema: schema,
    });
  } catch (err: any) {
    if (!err?.message?.includes('already exists') && err?.status !== 400) {
      console.error(`Failed to create ${field} payload index:`, err);
    }
  }
}
```

### Search Scoping

All search operations must include `user_id` in the Qdrant filter. `bank_id` is optional (omitting it searches across all banks):

```typescript
// memory.service.ts
async search(userId: string, query: string, options?: {
  bankId?: string;
  filters?: SearchFilters;
  limit?: number;
  rerank?: boolean;
}) {
  const qdrantFilter: any = {
    must: [
      { key: 'user_id', match: { value: userId } },
    ],
  };
  if (options?.bankId) {
    qdrantFilter.must.push({ key: 'bank_id', match: { value: options.bankId } });
  }
  // ... pass qdrantFilter to this.qdrant.search()
}
```

### Sync-Time Bank Selection

When a connector syncs, new memories need a bank assignment. Resolution order:

```
Sync Pipeline with Bank Resolution:

  [EmbedProcessor receives rawEvent]
       |
       v
  Look up account_bank_mappings for this accountId
       |
       +-- Mapping exists --> use mapped bankId
       |
       +-- No mapping --> use user's default bank (is_default=true)
       |
       v
  Create Memory with bankId set
       |
       v
  Upsert to Qdrant with bank_id in payload
```

```typescript
// In EmbedProcessor
private async resolveBankId(accountId: string, userId: string): Promise<string> {
  // Check explicit mapping first
  const [mapping] = await this.db.select()
    .from(accountBankMappings)
    .where(eq(accountBankMappings.accountId, accountId))
    .limit(1);
  if (mapping) return mapping.bankId;

  // Fall back to user's default bank
  const [defaultBank] = await this.db.select()
    .from(memoryBanks)
    .where(and(eq(memoryBanks.userId, userId), eq(memoryBanks.isDefault, true)))
    .limit(1);
  return defaultBank.id;
}
```

### Bank Operations

```typescript
@Controller('banks')
export class BanksController {
  @Get()              // List user's banks with memory counts
  @Post()             // Create new bank
  @Get(':id')         // Get bank details + stats (memory count, last sync)
  @Patch(':id')       // Update name, description, settings
  @Delete(':id')      // Delete bank — moves memories to default bank, not deleted
  @Post(':id/accounts')           // Assign account(s) to this bank
  @Delete(':id/accounts/:accId')  // Remove account from bank (reverts to default)
}
```

**Bank deletion** does not delete memories — it moves them to the user's default bank:

```typescript
async deleteBank(bankId: string, userId: string) {
  const [bank] = await this.db.select().from(memoryBanks)
    .where(and(eq(memoryBanks.id, bankId), eq(memoryBanks.userId, userId)));
  if (!bank) throw new NotFoundException();
  if (bank.isDefault) throw new BadRequestException('Cannot delete default bank');

  // Find default bank
  const [defaultBank] = await this.db.select().from(memoryBanks)
    .where(and(eq(memoryBanks.userId, userId), eq(memoryBanks.isDefault, true)));

  // Move memories to default bank
  await this.db.update(memories)
    .set({ bankId: defaultBank.id })
    .where(eq(memories.bankId, bankId));

  // Update Qdrant payloads (batch update bank_id)
  // ... scroll through points with bank_id filter, update payload

  // Delete mappings and the bank
  await this.db.delete(accountBankMappings).where(eq(accountBankMappings.bankId, bankId));
  await this.db.delete(memoryBanks).where(eq(memoryBanks.id, bankId));
}
```

### SQLite Compatibility

For SQLite (single-user mode), banks still work:
- One user, one default bank, `bank_id` on all memories
- Users can create additional banks for organization
- No RLS, no user filtering — just bank filtering
- Schema additions are straightforward (add columns to existing tables)

---

## Implementation Order

Recommended phased rollout — each phase is independently deployable:

```
Phase 1: Foundation (no breaking changes, guard disabled by default)
  +-----------------------------------------------------------------+
  |  1. Add users table to schema.ts (SQLite) + schema.pg.ts (new)  |
  |  2. Add @Public() decorator + JwtAuthGuard                      |
  |  3. Add AuthProviderService + LocalAuthProvider                  |
  |  4. Add ConfigService entries (DB_DRIVER, AUTH_PROVIDER, etc.)   |
  |  5. Guard is OFF by default (AUTH_ENABLED=false)                 |
  +-----------------------------------------------------------------+

Phase 2: Database Refactor (mechanical, no behavior change)
  +-----------------------------------------------------------------+
  |  6. Replace all .get()/.all()/.run() with async equivalents     |
  |  7. Create db.interface.ts + SqliteDriver + PostgresDriver      |
  |  8. Conditional driver init in DbService via DB_DRIVER env      |
  |  9. Set up Drizzle Kit migrations for both drivers              |
  +-----------------------------------------------------------------+

Phase 3: Auth Activation (feature-gated)
  +-----------------------------------------------------------------+
  |  10. Enable JwtAuthGuard (AUTH_ENABLED=true)                    |
  |  11. Add signup/login/refresh endpoints                         |
  |  12. Add API key table + CRUD endpoints                         |
  |  13. Update CLI to support --api-key / BOTMEM_API_KEY           |
  |  14. WebSocket auth in EventsGateway                            |
  +-----------------------------------------------------------------+

Phase 4: Multi-tenancy
  +-----------------------------------------------------------------+
  |  15. Add user_id FK to accounts, memories, contacts             |
  |  16. Add memory_banks table + account_bank_mappings             |
  |  17. Add user_id + bank_id to Qdrant payloads + indexes         |
  |  18. Update all services to accept userId, scope queries        |
  |  19. Add RlsInterceptor + RLS policies (Postgres only)          |
  |  20. Update BullMQ job payloads to carry userId                 |
  +-----------------------------------------------------------------+

Phase 5: Client-Side Encryption (opt-in)
  +-----------------------------------------------------------------+
  |  21. Add kdf_salt + encrypted_dek columns to users              |
  |  22. Key material API endpoints (get/put)                       |
  |  23. Browser: Argon2id + AES-256-GCM encryption module          |
  |  24. Browser: ONNX embedding generation for encrypted banks     |
  |  25. Encrypted bank type (is_encrypted flag on memory_banks)    |
  |  26. Modified pipeline: skip enrichment for encrypted memories  |
  +-----------------------------------------------------------------+
```

Each phase builds on the previous one but can be shipped and tested independently. The critical path is Phase 2 (async refactor) which is the largest mechanical change but carries no behavioral risk — SQLite's Drizzle driver supports both sync and async APIs.

---

## Sources

All findings based on direct analysis of:

- `apps/api/src/db/db.service.ts` — current SQLite driver initialization + DDL
- `apps/api/src/db/schema.ts` — current Drizzle schema (SQLite)
- `apps/api/src/auth/auth.service.ts` — connector OAuth flow (no user auth)
- `apps/api/src/auth/auth.controller.ts` — connector auth endpoints
- `apps/api/src/app.module.ts` — module registration (no guards)
- `apps/api/src/main.ts` — bootstrap (no global guards, CORS open)
- `apps/api/src/events/events.gateway.ts` — WebSocket (no auth)
- `apps/api/src/memory/qdrant.service.ts` — Qdrant client, single collection
- `apps/api/src/memory/memory.service.ts` — search flow, no user scoping
- `apps/api/src/memory/memory.controller.ts` — all endpoints open
- `apps/api/src/accounts/accounts.service.ts` — CRUD, no user scoping
- `apps/api/src/config/config.service.ts` — env var definitions
- `packages/shared/src/types/index.ts` — shared type definitions

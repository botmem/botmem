---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: Security, Auth & Encryption
status: completed
stopped_at: Completed quick-8 UI/UX fixes from visual E2E review
last_updated: '2026-03-09T17:35:00.000Z'
last_activity: 2026-03-09 — Archived milestones v1.0 through v3.0.1
progress:
  total_phases: 32
  completed_phases: 27
  total_plans: 51
  completed_plans: 51
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-09)

**Core value:** Every piece of personal communication is searchable, connected, and queryable -- with factuality labeling so the user knows what's verified vs. hearsay.
**Current focus:** v4.0 E2E Testing & Test Infrastructure — Phase 35 (Fixture Capture) is first, but blocked until v2.0 phases 23, 24 complete

## Current Position

Phase: Not started (roadmap defined, execution blocked)
Plan: —
Status: Execution blocked on v2.0 phases 23 (RLS) and 24 (Firebase). Roadmap and success criteria are fully defined. Phase 21 (E2EE) is complete.
Last activity: 2026-03-09 — Roadmap v4.0 finalized (phases 35-39)

```
v4.0 Progress: [..........] 0/5 phases complete
Phase 35: Fixture Capture          [ ] Not started
Phase 36: Pipeline Integration     [ ] Not started
Phase 37: API HTTP Integration     [ ] Not started
Phase 38: Connector Parsing        [ ] Not started
Phase 39: CI Gates & Coverage      [ ] Not started
```

## Performance Metrics

**Velocity:**

- Total plans completed: 46
- Average duration: 5min
- Total execution time: ~230min

| Phase                      | Plan | Duration | Tasks    | Files |
| -------------------------- | ---- | -------- | -------- | ----- |
| 16                         | 01   | 6min     | 2        | 16    |
| 16                         | 02   | 4min     | 2        | 7     |
| 16                         | 03   | 5min     | 3        | 15    |
| 17                         | 01   | 5min     | 2        | 13    |
| 25                         | 01   | 3min     | 2        | 4     |
| 25                         | 02   | 1min     | 1        | 1     |
| 29                         | 01   | 4min     | 2        | 18    |
| 26                         | 01   | 3min     | 2        | 3     |
| 26                         | 02   | 2min     | 2        | 2     |
| 30                         | 02   | 2min     | 1        | 3     |
| 30                         | 01   | 5min     | 2        | 27    |
| 31                         | 01   | 2min     | 2        | 2     |
| 34                         | 01   | 6min     | 2        | 29    |
| 32                         | 01   | 3min     | 2        | 14    |
| 34                         | 02   | 10min    | 2        | 16    |
| 34                         | 03   | 7min     | 2        | 12    |
| 33                         | 01   | 22min    | 2        | 5     |
| 27                         | 01   | 6min     | 2        | 7     |
| 28                         | 01   | 18min    | 2        | 1     |
| 22                         | 01   | 3min     | 3        | 6     |
| 22                         | 02   | 16min    | 2        | 26    |
| 10                         | UAT  | 15min    | 2        | 3     |
| Phase 19 P02               | 2min | 2 tasks  | 5 files  |
| Phase 19 P01               | 6min | 2 tasks  | 9 files  |
| Phase 19 P03               | 2min | 3 tasks  | 7 files  |
| Phase 20 P01               | 2min | 2 tasks  | 3 files  |
| Phase 21 P01               | 4min | 2 tasks  | 11 files |
| Phase 21 P02               | 6min | 2 tasks  | 7 files  |
| Phase 23 P01               | 2min | 1 tasks  | 1 files  |
| Phase 23 P02               | 2min | 2 tasks  | 5 files  |
| Phase 23 P03               | 2min | 2 tasks  | 2 files  |
| Phase 24 P01               | 4min | 2 tasks  | 11 files |
| Phase 24-firebase-auth P01 | 4min | 2 tasks  | 11 files |
| Phase 24-firebase-auth P02 | 8min | 2 tasks  | 5 files  |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [v2.0]: Auth always on -- no dev bypass, even open-core requires login
- [v2.0]: Open-core = local email+password+JWT; Prod-core = Firebase (Google/GitHub social)
- [v2.0]: E2EE encrypts text+metadata only; vectors stay plaintext for search
- [v2.0]: Encryption key derived from user password (Argon2id) -- lost password = lost data
- [v2.0]: Memory bank selected at sync time (not auto-assigned per connector)
- [v2.0]: PostgreSQL included because RLS depends on it
- [v2.0]: Phase numbering continues from 15 (starts at 16)
- [Phase 16]: Access token in memory only -- never persisted; session restored via httpOnly refresh cookie
- [Phase 16]: 401 interceptor uses mutex Promise to prevent concurrent refresh races
- [Phase 16]: Password reset token stored as SHA-256 hash with 1hr expiry; existing unused tokens invalidated
- [Phase 19]: Qdrant bulk update uses REST API directly in standalone migration scripts (no NestJS DI)
- [Phase 19]: isDefault typed as boolean throughout frontend to match Postgres boolean column
- [Phase 19]: Job-level memoryBankId override takes priority over default bank lookup in embed processor
- [Phase 19]: Bank ownership validated via MemoryBanksService.getById before sync trigger
- [Phase 19]: API key bank IDs validated with inArray query against user's banks before creation
- [Phase 19]: Bank selector hidden when only one bank exists (no UI clutter for single-bank users)
- [Phase 19]: Unchecked bank checkboxes on API key creation means unrestricted access to all banks
- [Phase 20]: Standalone encrypt/isEncrypted in migration script (no NestJS DI dependency)
- [Phase 20]: Per-row error handling: log and continue, never abort entire migration
- [Phase 20]: Guard main() with process.argv check to allow test imports without side effects
- [Phase 21]: Argon2id with timeCost=3, memoryCost=19456 for per-user key derivation (OWASP params)
- [Phase 21]: Legacy users get encryptionSalt generated on first login for backward compatibility
- [Phase 21]: keyVersion=0 on memories means APP_SECRET encrypted, >=1 means per-user key
- [Phase 21]: decryptMemoryAuto routes decryption based on memory.keyVersion (0=APP_SECRET, >=1=user key)
- [Phase 21]: EncryptionKeyMissingError triggers BullMQ exponential backoff retry (30s base, 48 attempts ~24h)
- [Phase 21]: ReencryptProcessor updates keyVersion even on per-row errors to prevent infinite loops
- [v4.0]: Fixture-based testing chosen to handle Ollama non-determinism -- tests never call live LLM
- [v4.0]: Fixture capture runs against live Ollama once; subsequent test runs use recorded responses
- [v4.0]: Pipeline integration tests use a real isolated Postgres schema (not mocks) -- each suite gets fresh schema
- [v4.0]: Connector parsing tests are pure data-transform tests -- no BullMQ, no Postgres, no Qdrant needed
- [Phase 23]: RLS policies use NULL-safe current_setting('app.current_user_id', true) — returns NULL not ERROR if session var unset
- [Phase 23]: FORCE ROW LEVEL SECURITY added to every RLS table so table owner role also obeys policies in production
- [Phase 23]: users, settings, connector_credentials excluded from RLS — users needed for auth lookups, others are global not per-user
- [Phase 23]: createRlsPolicies() idempotent: DROP POLICY IF EXISTS before every CREATE POLICY, runs on every onModuleInit()
- [Phase 23]: RlsInterceptor uses AsyncLocalStorage for non-blocking request-scoped userId propagation — interceptor holds no DB connection
- [Phase 23]: withUserId uses SET LOCAL so session variable is transaction-scoped — pool connections are safe from cross-request bleed
- [Phase 23]: RlsContext injected as @Optional() in DbService to prevent circular dependency with DbModule Global providers
- [Phase 23]: [Phase 23-03]: timeline/getRelated/searchEntities/getEntityGraph in memory.service.ts were using unscoped db — migrated to withCurrentUser()
- [Phase 23]: [Phase 23-03]: sync.processor.ts rawEvents INSERT wrapped in withUserId(ownerUserId) using bootstrap pattern (unscoped userId lookup then scoped data write)
- [Phase 24-firebase-auth]: AuthProviderGuard delegation pattern — single APP_GUARD reads AUTH_PROVIDER at request time and delegates to JwtAuthGuard (local) or FirebaseAuthGuard (firebase)
- [Phase 24-firebase-auth]: Sentinel passwordHash ('firebase:<uid>') for Firebase users — never compared via bcrypt, prevents password login
- [Phase 24-firebase-auth]: firebaseUid nullable unique column on users table — allows linking Firebase accounts to existing local accounts by email on first Firebase login
- [Phase 24-firebase-auth]: Firebase ID token stored as accessToken in authStore — reuses existing Bearer token infrastructure without changes to API fetch layer
- [Phase 24-firebase-auth]: isFirebaseMode = VITE_AUTH_PROVIDER === firebase — module-level constant, zero runtime cost, gates all Firebase UI conditionally
- [Phase 24-firebase-auth]: popup-closed-by-user / cancelled-popup-request handled gracefully — no error state shown to user

### Decisions (Phase 16)

- [16-01]: Separate jwtAccessSecret/jwtRefreshSecret instead of single JWT_SECRET for defense-in-depth
- [16-01]: SHA-256 hash of refresh token stored in DB, raw token never persisted
- [16-01]: Dummy bcrypt hash comparison on non-existent users prevents timing-based email enumeration
- [16-01]: Token family UUID tracks refresh chain -- replaying revoked token kills entire family
- [16-02]: Lazy nodemailer transporter -- only create SMTP connection on first send
- [16-02]: Graceful mail failure -- log errors but never throw from sendResetEmail
- [16-02]: Console fallback in dev -- log reset URL to stdout when SMTP not configured

### Decisions (Phase 17)

- [17-01]: CORS supports comma-separated FRONTEND_URL for multi-origin deployments
- [17-01]: WebSocket auth via token query param (not header) for browser WebSocket API compatibility
- [17-01]: WsClient refuses to connect without token -- prevents pre-auth connection attempts

### Decisions (Phase 25)

- [25-01]: Migration scripts use main().catch() pattern instead of top-level await for tsx CJS compatibility

### Decisions (Phase 29)

- [29-01]: Single root eslint.config.mjs -- no per-package ESLint configs (monorepo anti-pattern)
- [29-01]: no-explicit-any as warn not error -- codebase uses any extensively
- [29-01]: Web uses tsc --noEmit (not tsc -b --noEmit) to avoid TS6310 with referenced composite projects
- [29-01]: APP_SECRET added to .env.example -- was in config.service.ts but missing from plan template

### Decisions (Phase 26)

- [26-01]: 10-type canonical taxonomy (lowercase): person, organization, location, date, event, product, concept, quantity, language, other
- [26-01]: Normalizer is a pure function (no DI, no side effects) for easy testing and reuse
- [26-01]: Embed-shape entities (type/id/role) handled by parsing compound id format (name:X|email:Y)
- [26-02]: Bidirectional link dedup: check both src->dst and dst->src before inserting memoryLinks
- [26-02]: embedEntities stored as parallel normalized copy in metadata -- contact resolution untouched

### Decisions (Phase 30)

- [30-02]: Lazy ioredis connection (lazyConnect: true) -- only probes on health check, not on startup
- [30-02]: Promise.allSettled for concurrent health probing -- one slow service does not block others
- [30-02]: Health endpoint always returns HTTP 200 -- reports status, never fails itself
- [30-01]: CJS output for all library packages -- module:CommonJS + moduleResolution:node overrides base ESNext config
- [30-01]: Vite source condition -- shared package exports 'source' field, Vite resolves it for dev builds
- [30-01]: SWC builder in nest-cli.json for faster incremental rebuilds than tsc
- [30-01]: Web dev script renamed to dev:standalone to prevent turbo from starting conflicting Vite server

### Decisions (Phase 31)

- [31-01]: Removed api service from docker-compose (no Dockerfile, app runs via pnpm dev)
- [31-01]: Ollama behind profile -- opt-in only, not started by default
- [31-01]: Qdrant healthcheck uses bash TCP probe (no curl in image)

### Decisions (Phase 34)

- [34-01]: ValidationPipe uses whitelist+transform without forbidNonWhitelisted to avoid breaking existing clients
- [34-01]: Single default throttle tier (100/min) with per-route overrides for auth and AI endpoints
- [34-01]: UpdateAccountDto uses SyncSchedule type from @botmem/shared for compile-time type safety

### Decisions (Phase 34-02)

- [34-02]: Logger pattern: class-level `new Logger(ClassName.name)` for services, module-level `new Logger('Bootstrap')` for main.ts
- [34-02]: Error logging passes err.stack as second param to logger.error() for NestJS stack trace support
- [34-02]: Transaction scope limited to multi-table cascading deletes only -- single-table operations left as-is

### Decisions (Phase 34-03)

- [34-03]: Production validation uses OnModuleInit to fail fast at startup, not lazy check
- [34-03]: Agent controller removes fail() wrapper entirely, lets NestJS exception filter handle errors
- [34-03]: Contacts getSuggestions/getMemories accept optional userId for backward compatibility

### Decisions (Phase 33)

- [33-01]: ServeStaticModule guarded with existsSync, not NODE_ENV alone -- supports API-only Docker images
- [33-01]: 4-stage Docker build: base, pruner (turbo prune), builder (compile+prod prune), runner (minimal alpine)
- [33-01]: --ignore-scripts + selective rebuild for native modules to skip husky prepare in Docker
- [33-01]: Workspace packages copied to runner to preserve pnpm symlink resolution for @botmem/\* imports

### Decisions (Phase 32)

- [32-01]: pnpm catalog for typescript, vitest, vite, @vitest/coverage-v8 -- four deps centralized
- [32-01]: Pre-push hook uses turbo filter to only check changed packages, not full monorepo
- [32-01]: lint-staged runs eslint --fix then prettier --write on .ts/.tsx files

### Decisions (Phase 27)

- [27-01]: enrichedAt nullable column as resumability marker -- skip already-processed memories on restart
- [27-01]: Worker concurrency default 2 to avoid overwhelming Ollama during backfill
- [27-01]: BullMQ jobId set to memory ID for idempotent enqueuing -- prevents duplicates on retry/resume

### Decisions (Phase 28)

- [28-01]: enriched_at column added to SQLite manually -- Phase 27 migration was never applied to existing DB
- [28-01]: VER-02 photo search 0 results is a hybrid search design limitation, not data quality issue
- [28-01]: Non-canonical entity types (time, amount, metric) are pre-existing, normalizer works for new data

### Decisions (Phase 22)

- [22-01]: Encrypted columns stay TEXT (ciphertext is opaque strings, not structured data for jsonb)
- [22-01]: JSONB only for structured data: factuality, weights, avatars, contacts metadata
- [22-01]: Pool max=20, idle timeout 30s, connect timeout 5s
- [22-01]: GIN indexes with pg_trgm replace SQLite FTS5 virtual tables
- [22-01]: All SQLite migration functions removed -- fresh Postgres DB, no legacy data migration
- [22-02]: Mock-based test helper replaces in-memory SQLite -- integration tests deferred to TEST_DATABASE_URL
- [22-02]: users.service accepts string|Date for expiresAt -- backward-compatible during migration
- [22-02]: PostgreSQL unique constraint detected via error code 23505 (replaces SQLITE_CONSTRAINT_UNIQUE)
- [22-01]: DATABASE_URL required at startup with fail-fast OnModuleInit pattern

### Pending Todos

None yet.

### Roadmap Evolution

- v2.0 paused at 26% (phases 16-17 complete, 25 complete, 18-24 + 26-28 remaining)
- v3.0 inserted for monorepo/DX work before resuming security milestone
- v4.0 roadmap defined 2026-03-09 (phases 35-39); execution blocked on v2.0 phases 23, 24

### Blockers/Concerns

- v4.0 execution blocked: phases 23 (RLS) and 24 (Firebase) must complete before Phase 35 can begin -- test infrastructure must be built against the final auth/DB architecture.

### Quick Tasks Completed

| #   | Description                                                                                               | Date       | Commit  | Directory                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------- | ---------- | ------- | ------------------------------------------------------------------------------------------------- |
| 4   | Fix contact merge suggestions for duplicate identities and filter device identifiers from people contacts | 2026-03-09 | 6b76742 | [4-fix-contact-merge-suggestions-for-duplic](./quick/4-fix-contact-merge-suggestions-for-duplic/) |
| 5   | Move connector/sync logs from PostgreSQL to NDJSON file on disk                                           | 2026-03-09 | d0615bd | [5-logs-are-being-stored-to-the-db-which-is](./quick/5-logs-are-being-stored-to-the-db-which-is/) |
| 6   | Create GitHub CI/CD pipeline with GitHub Actions + Watchtower auto-deploy                                 | 2026-03-09 | 6540f0c | [6-create-a-github-cicd-pipeline-and-on-pro](./quick/6-create-a-github-cicd-pipeline-and-on-pro/) |
| 8   | Fix all UI/UX issues from visual E2E review — emoji icons, off-brand colors, auth page logos, aria attrs  | 2026-03-09 | 5fc1674 | [8-fix-all-ui-ux-issues-from-visual-e2e-rev](./quick/8-fix-all-ui-ux-issues-from-visual-e2e-rev/) |

## Session Continuity

Last session: 2026-03-09T13:11:08.102Z
Stopped at: Completed quick-7 UI visual E2E review
Resume file: None

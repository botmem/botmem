---
gsd_state_version: 1.0
milestone: v2.1
milestone_name: Data Quality & Pipeline Integrity
status: completed
stopped_at: Completed 28-01-PLAN.md
last_updated: '2026-03-09T21:01:37.000Z'
last_activity: 2026-03-09 -- Phase 28 Plan 01 complete (end-to-end data quality verification)
progress:
  total_phases: 28
  completed_phases: 21
  total_plans: 38
  completed_plans: 38
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-08)

**Core value:** Every piece of personal communication is searchable, connected, and queryable -- with factuality labeling so the user knows what's verified vs. hearsay.
**Current focus:** v2.1 Data Quality & Pipeline Integrity -- Phase 28 Plan 01 complete (verification)

## Current Position

Phase: 28 (Verification)
Plan: 01 of 01 (complete)
Status: Phase 28 complete (all plans done)
Last activity: 2026-03-09 -- Phase 28 Plan 01 complete (end-to-end data quality verification)

## Performance Metrics

**Velocity:**

- Total plans completed: 18
- Average duration: 5min
- Total execution time: 96min

| Phase | Plan | Duration | Tasks | Files |
| ----- | ---- | -------- | ----- | ----- |
| 16    | 01   | 6min     | 2     | 16    |
| 16    | 02   | 4min     | 2     | 7     |
| 16    | 03   | 5min     | 3     | 15    |
| 17    | 01   | 5min     | 2     | 13    |
| 25    | 01   | 3min     | 2     | 4     |
| 25    | 02   | 1min     | 1     | 1     |
| 29    | 01   | 4min     | 2     | 18    |
| 26    | 01   | 3min     | 2     | 3     |
| 26    | 02   | 2min     | 2     | 2     |
| 30    | 02   | 2min     | 1     | 3     |
| 30    | 01   | 5min     | 2     | 27    |
| 31    | 01   | 2min     | 2     | 2     |
| 34    | 01   | 6min     | 2     | 29    |
| 32    | 01   | 3min     | 2     | 14    |
| 34    | 02   | 10min    | 2     | 16    |
| 34    | 03   | 7min     | 2     | 12    |
| 33    | 01   | 22min    | 2     | 5     |
| 27    | 01   | 6min     | 2     | 7     |
| 28    | 01   | 18min    | 2     | 1     |

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

### Pending Todos

None yet.

### Roadmap Evolution

- v2.0 paused at 26% (phases 16-17 complete, 25 complete, 18-24 + 26-28 remaining)
- v3.0 inserted for monorepo/DX work before resuming security milestone

### Blockers/Concerns

None.

## Session Continuity

Last session: 2026-03-09T21:01:37Z
Stopped at: Completed 28-01-PLAN.md
Resume: Phase 28 complete. v2.1 Data Quality milestone verified. Next phase TBD.

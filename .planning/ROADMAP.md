# Roadmap: Botmem

## Milestones

- v1.0 MVP - Phases 1-3 (shipped 2026-03-07)
- v1.1 PostHog Analytics Activation - Phase 4 (shipped 2026-03-07)
- v1.2 PostHog Deep Analytics - Phases 5-6 (shipped 2026-03-08)
- v1.3 Test Coverage - Phase 7 (shipped 2026-03-08)
- v1.4 Search Intelligence - Phases 8-10 (shipped 2026-03-08)
- v2.0 Security, Auth & Encryption - Phases 16-24 (in progress)
- v2.1 Data Quality & Pipeline Integrity - Phases 25-28 (queued)
- v3.0 Monorepo & Developer Experience - Phases 29-33 (active)
- v3.1 Production Deployment & CI/CD - (planned, deferred)

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

<details>
<summary>v1.0 MVP (Phases 1-3) - SHIPPED 2026-03-07</summary>

### Phase 1: Search Quality
**Goal**: Users get meaningfully ranked search results where frequently-accessed and pinned memories surface reliably, and the reranker fills the empty 0.30 weight slot in the scoring formula
**Depends on**: Nothing (first phase)
**Requirements**: SRCH-01, SRCH-02, SRCH-03, SRCH-04, SRCH-05, SRCH-06
**Success Criteria** (what must be TRUE):
  1. Search results are visibly reranked -- querying the same term returns different ordering than before, with more contextually relevant results at the top
  2. User can pin a memory from the UI, and that memory consistently appears in relevant searches regardless of age
  3. Viewing a search result multiple times causes it to rank higher in future searches for similar queries
  4. Reranking completes within 3 seconds for a typical search (no perceptible freeze)
**Plans**: 2 plans

Plans:
- [x] 01-01: Reranker integration (SRCH-01, SRCH-02)
- [x] 01-02: Pinning and importance reinforcement (SRCH-03, SRCH-04, SRCH-05, SRCH-06)

### Phase 2: Operational Maturity
**Goal**: The system maintains accurate scores over time through automated decay, and usage is tracked via PostHog so search and sync patterns are observable
**Depends on**: Phase 1
**Requirements**: OPS-01, OPS-02, OPS-03, OPS-04, OPS-05
**Success Criteria** (what must be TRUE):
  1. Old unpinned memories naturally rank lower over time without manual intervention
  2. PostHog dashboard shows search, sync, and pin events when API key is configured
  3. System runs normally with no errors when PostHog API key is absent
  4. Decay job runs nightly without blocking normal API operations
**Plans**: 2 plans

Plans:
- [x] 02-01: Nightly decay job (OPS-01, OPS-02)
- [x] 02-02: PostHog analytics integration (OPS-03, OPS-04, OPS-05)

### Phase 3: Extensibility
**Goal**: Users can drop plugin files into the plugins directory to add custom connectors, scorers, or lifecycle hooks without modifying core code
**Depends on**: Phase 2
**Requirements**: EXT-01, EXT-02, EXT-03, EXT-04
**Success Criteria** (what must be TRUE):
  1. A sample enricher plugin in the plugins directory runs automatically during the enrich pipeline
  2. Lifecycle hooks fire at documented points (afterIngest, afterEmbed, afterEnrich, afterSearch) and plugin code can observe memory events
  3. Plugin interface is documented with working example that a developer can copy and modify
**Plans**: 2 plans

Plans:
- [x] 03-01: Plugin registry and loading infrastructure (EXT-01, EXT-03)
- [x] 03-02: Hook wiring, scorer integration, and sample plugin (EXT-02, EXT-04)

</details>

<details>
<summary>v1.1 PostHog Analytics Activation (Phase 4) - SHIPPED 2026-03-07</summary>

### Phase 4: PostHog Analytics Activation
**Goal**: PostHog receives real analytics events from both frontend and backend, with comprehensive product tracking across all key user actions
**Depends on**: Phase 3
**Requirements**: CFG-01, CFG-02, VER-01, VER-02, VER-03, VER-04, VER-05, COV-01, COV-02
**Success Criteria** (what must be TRUE):
  1. PostHog dashboard shows pageview events when user navigates between pages in the web app
  2. PostHog dashboard shows search, pin/unpin, sync_complete, and sync_error events with correct properties
  3. Connector setup completions and graph view interactions appear as tracked events in PostHog
  4. Removing API keys from environment variables causes zero errors and zero network calls to PostHog
**Plans**: 2 plans

Plans:
- [x] 04-01: Config + coverage gaps (CFG-02, COV-01, COV-02)
- [x] 04-02: API key setup + end-to-end verification (CFG-01, VER-01, VER-02, VER-03, VER-04, VER-05)

</details>

<details>
<summary>v1.2 PostHog Deep Analytics (Phases 5-6) - SHIPPED 2026-03-08</summary>

### Phase 5: SDK Feature Enablement
**Goal**: All PostHog deep analytics features are actively capturing data from Botmem sessions
**Depends on**: Phase 4 (PostHog SDK already integrated and sending events)
**Requirements**: REPLAY-01, REPLAY-03, HEAT-01, HEAT-03, ERR-01, ERR-03, WEB-03, ID-01, ID-02
**Success Criteria** (what must be TRUE):
  1. Browsing Botmem generates session replay recordings with text inputs masked and network requests captured (auth headers redacted)
  2. Clicking and scrolling on pages produces autocapture events including rageclicks, and UTM/referrer data is captured on page views
  3. A deliberately thrown JS error appears as a captured exception in PostHog, and an unhandled backend exception is sent as a server-side error
  4. After page load, PostHog identifies the session with a stable user ID and sets connectors_count and memories_count as person properties
**Plans**: 2 plans

Plans:
- [x] 05-01-PLAN.md -- Enable session replay, autocapture, heatmaps, error tracking, network recording, and backend exception filter
- [x] 05-02-PLAN.md -- User identification with stable ID and person properties

### Phase 6: Verification and Dashboards
**Goal**: PostHog dashboards provide actionable insights on Botmem usage patterns
**Depends on**: Phase 5 (data must be flowing before dashboards can be built)
**Requirements**: REPLAY-02, HEAT-02, ERR-02, WEB-01, WEB-02, PROD-01, PROD-02, PROD-03
**Success Criteria** (what must be TRUE):
  1. Session recordings are playable in PostHog Replay tab and heatmap overlay is visible on Botmem pages via PostHog toolbar
  2. Errors with stack traces appear in PostHog Error Tracking view
  3. PostHog web analytics dashboard shows page views, unique visitors, session counts, and navigation paths between pages
  4. A saved PostHog dashboard exists with insights for searches/day, syncs/day, memories created, a connector setup funnel, and a search retention insight
**Plans**: 2 plans

Plans:
- [x] 06-01-PLAN.md -- Data flow verification (session replay, heatmaps, error tracking, navigation paths)
- [x] 06-02-PLAN.md -- Dashboard creation (web analytics, product metrics, funnel, retention)

</details>

<details>
<summary>v1.3 Test Coverage (Phase 7) - SHIPPED 2026-03-08</summary>

### Phase 7: Test Infrastructure Fixes
**Goal**: Test infrastructure is reliable with coverage tooling and passing test suites across all packages
**Depends on**: Phase 6
**Plans**: 2 plans

Plans:
- [x] 07-01: Coverage tooling setup
- [x] 07-02: Fix failing tests

</details>

<details>
<summary>v1.4 Search Intelligence (Phases 8-10) - SHIPPED 2026-03-08</summary>

**Milestone Goal:** Make Botmem's search layer intelligent enough for a personal AI assistant -- parse natural language queries into structured filters, fix entity type classification for reliable filtering, and add source citations for assistant drill-down.

- [x] **Phase 8: Entity Type Taxonomy** - Canonical entity types via structured output, backfill existing data, type-filtered search (completed 2026-03-08)
- [x] **Phase 8.1: Contact Auto-Merge** (INSERTED) - Auto-merge obvious contact duplicates (completed 2026-03-08)
- [x] **Phase 9: NLQ Parsing** - Temporal references via chrono-node, entity extraction, intent classification (completed 2026-03-08)
- [ ] **Phase 10: Source Citations & Verification** - Deferred (CIT-01 moved to backlog)

### Phase 8-10 details (collapsed -- see phase directories for plans)

Phase 8: Entity Type Taxonomy (2/2 plans complete)
Phase 8.1: Contact Auto-Merge (2/2 plans complete)
Phase 9: NLQ Parsing (2/2 plans complete)
Phase 10: Source Citations (deferred)

</details>

## v2.0 Security, Auth & Encryption (Phases 16-24)

**Milestone Goal:** Add user authentication, API keys, memory banks, encryption at rest, E2EE for prod-core, and PostgreSQL with RLS -- transforming Botmem from a completely open system into a properly secured personal memory platform.

**Phase Ordering Rationale:**
- User auth first (Phase 16) because everything else depends on having a user identity
- API security (Phase 17) immediately after to lock down endpoints before adding more features
- API keys (Phase 18) require auth to exist, and banks need keys for scoping
- Memory banks (Phase 19) need user identity for ownership and keys for scoping
- Encryption at rest (Phase 20) can happen independently once auth is in place
- E2EE (Phase 21) requires auth + banks, and must happen before Postgres migration (encrypted data must be stable)
- PostgreSQL dual-driver (Phase 22) is infrastructure, independent of auth features but needed for RLS
- RLS (Phase 23) requires Postgres + auth + banks to all be in place
- Firebase auth (Phase 24) is last because it's prod-core only and builds on the local auth foundation

**Summary:**
- [x] **Phase 16: User Authentication** - Register, login, JWT access+refresh tokens, password reset, session persistence (AUTH-01 through AUTH-05) (completed 2026-03-08)
- [x] **Phase 17: API Security** - Global auth guard, CORS lockdown, @Public() decorator for health/version/auth endpoints (SEC-01, SEC-02) (completed 2026-03-08)
- [ ] **Phase 18: API Keys** - Named read-only API keys, cryptographic generation, bank scoping, Bearer header auth (KEY-01 through KEY-05)
- [ ] **Phase 19: Memory Banks** - Create/list/rename/delete banks, sync-time selection, search scoping, default bank + data migration (BANK-01 through BANK-04)
- [ ] **Phase 20: Encryption at Rest** - AES-256-GCM for authContext + connectorCredentials, APP_SECRET key, migration script (ENC-01, ENC-02)
- [ ] **Phase 21: End-to-End Encryption** - Argon2id key derivation, client-side memory encryption, vectors plaintext, password change re-encryption (E2EE-01 through E2EE-04)
- [ ] **Phase 22: PostgreSQL Dual-Driver** - Postgres schema, shared DB interface, conditional driver, FTS5->tsvector (DB-01 through DB-04)
- [ ] **Phase 23: Row Level Security** - Postgres RLS policies for user data isolation (DB-05)
- [ ] **Phase 24: Firebase Auth (Prod-Core)** - Firebase guard, React Firebase UI, AUTH_PROVIDER switch, social login (FBAUTH-01 through FBAUTH-04)

## v2.1 Data Quality & Pipeline Integrity (Phases 25-28)

**Milestone Goal:** Fix source type misclassification, tame entity extraction chaos, unify entity format, deduplicate entities, and backfill existing data -- so search, filtering, and the memory graph actually work correctly.

**Phase Ordering Rationale:**
- Source type fix first (Phase 25) because it is independent of entity work and delivers immediate search improvement
- Entity format unification (Phase 26) before entity quality because the normalizer needs a consistent shape to work with
- Entity quality improvements bundled with format (Phase 26) because both modify the same pipeline files and must precede backfill
- Backfill (Phase 27) depends on the corrected pipeline from Phase 26 -- running backfill with the old pipeline would just reproduce bad data
- Verification (Phase 28) depends on all prior phases completing -- it validates the full fix chain end-to-end

**Summary:**
- [x] **Phase 25: Source Type Reclassification** - Fix photos connector, backfill SQLite + Qdrant, remove SOURCE_TYPE_ALIASES hack (SRC-01 through SRC-04) (completed 2026-03-08)
- [x] **Phase 26: Entity Format & Quality** - Unified entity shape, improved extraction prompt, normalizer with dedup/clean/validate, entity cap (FMT-01 through FMT-03, ENT-01 through ENT-05) (completed 2026-03-08)
- [ ] **Phase 27: Data Backfill** - Re-enrich existing memories with corrected pipeline, resumable, filterable, real-time progress (BKF-01 through BKF-04)
- [ ] **Phase 28: Verification** - End-to-end validation that search, graph, and NLQ produce correct results (VER-01 through VER-04)

## v3.0 Monorepo & Developer Experience (Phases 29-33)

**Milestone Goal:** Transform the hacked-together monorepo into a production-grade, plug-and-play development environment -- proper tooling, Docker Compose with all services, build gates with tests, and no dev experience footguns like port conflicts or restart storms.

**Phase Ordering Rationale:**
- Foundation config first (Phase 29) because linting and typecheck must exist before they can be build gates or pre-commit hooks
- Dev workflow fix (Phase 30) is the highest-value phase -- fixes the primary pain point (restart storms, port conflicts) and adds the health endpoint needed by Docker health checks
- Docker & infrastructure (Phase 31) after dev workflow because health endpoint (Phase 30) is needed by Docker Compose health checks, and Makefile targets reference Docker Compose commands
- Build optimization (Phase 32) after infrastructure because pnpm catalogs touch every package.json and must be stable before Docker build is finalized
- Production Docker (Phase 33) last because it depends on stable lockfile and build pipeline from Phase 32
- Each phase is independently shippable. Phase 30 alone delivers the highest value.

**Summary:**
- [x] **Phase 29: Foundation Config** - ESLint 9, Prettier, typecheck task, .env.example documentation (QUAL-01, QUAL-02, QUAL-03, DOCK-03) (completed 2026-03-08)
- [ ] **Phase 30: Dev Workflow Fix** - Replace nodemon, turbo watch, proper exports, health endpoint (DEV-01, DEV-02, DEV-03, DEV-04, DOCK-04)
- [ ] **Phase 31: Docker & Infrastructure** - Compose profiles, Makefile, health checks on all services (DOCK-01, DOCK-02)
- [ ] **Phase 32: Build Optimization** - pnpm catalogs, Husky + lint-staged pre-commit/pre-push hooks (BUILD-01, QUAL-04)
- [ ] **Phase 33: Production Docker** - Multi-stage build with turbo prune for minimal image size (BUILD-02)

## Phase Details (v2.0)

### Phase 16: User Authentication
**Goal**: Users can register, log in, and maintain sessions with JWT access tokens and httpOnly refresh cookies -- auth is always required, no bypass mode
**Depends on**: Phase 15 (v1.4 complete, codebase stable)
**Requirements**: AUTH-01, AUTH-02, AUTH-03, AUTH-04, AUTH-05
**Success Criteria** (what must be TRUE):
  1. `POST /api/user-auth/register` creates a new user with bcrypt-hashed password and returns JWT access token + sets httpOnly refresh cookie
  2. `POST /api/user-auth/login` with valid email+password returns JWT access token (15min expiry) + sets httpOnly refresh cookie (7d expiry)
  3. `POST /api/user-auth/refresh` with valid refresh cookie returns new access token and rotates refresh token (old token invalidated)
  4. `POST /api/user-auth/forgot-password` sends reset email with token link; `POST /api/user-auth/reset-password` with valid token (1hr) allows password change
  5. React frontend has login/register pages and persists session via refresh token
**Plans**: 3 plans

Plans:
- [x] 16-01-PLAN.md -- Backend auth infrastructure: schema, JWT, register/login/refresh/logout
- [x] 16-02-PLAN.md -- Password reset infrastructure: passwordResets table, MailService
- [x] 16-03-PLAN.md -- Frontend auth rewrite + password reset endpoints wiring

### Phase 17: API Security
**Goal**: All API endpoints require authentication except explicitly public ones, and CORS is locked to the frontend origin
**Depends on**: Phase 16 (auth system must exist to enforce)
**Requirements**: SEC-01, SEC-02
**Success Criteria** (what must be TRUE):
  1. Unauthenticated requests to any endpoint (except `/health`, `/version`, `/auth/*`) return 401 Unauthorized
  2. WebSocket connections require valid JWT token in handshake
  3. CORS only allows requests from FRONTEND_URL origin(s), with credentials mode enabled
  4. OAuth callback endpoints for connectors still work (they are marked @Public)
**Plans**: 1 plan

Plans:
- [x] 17-01-PLAN.md -- Global auth guard, CORS lockdown, WebSocket JWT auth, health endpoint

### Phase 18: API Keys
**Goal**: Users can create named, read-only API keys for programmatic access (CLI, agents), scoped to specific memory banks
**Depends on**: Phase 17 (auth guard must be in place to enforce key auth)
**Requirements**: KEY-01, KEY-02, KEY-03, KEY-04, KEY-05
**Success Criteria** (what must be TRUE):
  1. `POST /api-keys` creates a named API key, returns the key once (never stored plaintext), stores SHA-256 hash
  2. API keys only allow read operations (search, list memories/contacts) -- write/sync/delete operations return 403
  3. API keys created with bank scope only see data in those banks -- cross-bank requests return empty results
  4. `GET /api-keys` lists all keys (name, created, last used, banks), `DELETE /api-keys/:id` revokes a key
  5. `Authorization: Bearer <api-key>` header authenticates as the key's owner with read-only + bank-scoped permissions
**Plans**: 2 plans

Plans:
- [ ] 18-01-PLAN.md -- Backend: schema, service, controller, dual auth guard, @RequiresJwt enforcement
- [ ] 18-02-PLAN.md -- Frontend: Settings page tabs, API Keys management UI

### Phase 19: Memory Banks
**Goal**: Memories are organized into banks for logical data isolation, with bank selection at sync time and search scoping
**Depends on**: Phase 18 (API keys need banks for scoping)
**Requirements**: BANK-01, BANK-02, BANK-03, BANK-04
**Success Criteria** (what must be TRUE):
  1. `POST /banks` creates a new bank, `GET /banks` lists user's banks, `PATCH /banks/:id` renames, `DELETE /banks/:id` deletes (with data)
  2. Connector sync accepts `bankId` parameter -- all ingested memories go into the specified bank
  3. Search results are scoped to the user's accessible banks (own banks for JWT auth, scoped banks for API key auth)
  4. On first login, a "Default" bank is created and all existing memories are migrated into it
**Plans**: TBD

### Phase 20: Encryption at Rest
**Goal**: Sensitive connector credentials and auth context are encrypted in the database using AES-256-GCM
**Depends on**: Phase 16 (need APP_SECRET env var pattern established)
**Requirements**: ENC-01, ENC-02
**Success Criteria** (what must be TRUE):
  1. `authContext` in accounts table and data in `connectorCredentials` table are AES-256-GCM encrypted (key from APP_SECRET)
  2. Reading encrypted fields through the API returns decrypted values transparently (encryption is at the DB layer)
  3. Migration script encrypts all existing plaintext credentials without downtime
  4. Missing APP_SECRET causes startup error with clear message
**Plans**: TBD

### Phase 21: End-to-End Encryption (Prod-Core)
**Goal**: Memory text and metadata are encrypted client-side before reaching the server, ensuring zero-knowledge storage while preserving vector search
**Depends on**: Phase 20 (encryption patterns established), Phase 19 (banks exist for scoping)
**Requirements**: E2EE-01, E2EE-02, E2EE-03, E2EE-04
**Success Criteria** (what must be TRUE):
  1. Client derives AES-256-GCM key from password using Argon2id (in-browser via WebCrypto/WASM)
  2. Memory `text`, `entities`, `claims`, and `metadata` fields are encrypted client-side before POST -- server stores ciphertext
  3. Embedding vectors remain plaintext in Qdrant -- semantic search returns results, but text fields are encrypted until decrypted client-side
  4. Password change triggers batched re-encryption of all user memories with progress tracking (resumable on failure)
**Plans**: TBD

### Phase 22: PostgreSQL Dual-Driver
**Goal**: The application runs on either SQLite or PostgreSQL with zero code changes outside the database layer
**Depends on**: Phase 19 (banks table must exist in schema before creating Postgres version)
**Requirements**: DB-01, DB-02, DB-03, DB-04
**Success Criteria** (what must be TRUE):
  1. `schema.pg.ts` mirrors `schema.ts` with PostgreSQL-specific types (serial, text[], jsonb, timestamp)
  2. Shared DB interface abstracts all queries -- application code never uses SQLite-specific or Postgres-specific syntax
  3. `DB_DRIVER=postgres` + `DATABASE_URL` starts the API on PostgreSQL; `DB_DRIVER=sqlite` (default) uses SQLite as before
  4. FTS5 queries on SQLite and tsvector+GIN queries on PostgreSQL both return equivalent search results
**Plans**: TBD

### Phase 23: Row Level Security
**Goal**: PostgreSQL RLS policies ensure each user can only access their own data at the database level
**Depends on**: Phase 22 (Postgres driver must be working), Phase 16 (user identity must exist)
**Requirements**: DB-05
**Success Criteria** (what must be TRUE):
  1. RLS policies on memories, accounts, contacts, banks, and related tables restrict access to `current_user_id` session variable
  2. Each API request sets `SET LOCAL app.current_user_id = '<user_id>'` before executing queries
  3. Attempting to read/write another user's data via direct SQL returns no results (no error, just empty)
  4. Drizzle ORM queries work correctly with RLS enabled -- no bypasses from connection pooling or missing session vars
**Plans**: TBD

### Phase 24: Firebase Auth (Prod-Core)
**Goal**: Prod-core can use Firebase for authentication with social login (Google, GitHub), switchable via env var
**Depends on**: Phase 16 (local auth must be the baseline), Phase 17 (auth guard infrastructure)
**Requirements**: FBAUTH-01, FBAUTH-02, FBAUTH-03, FBAUTH-04
**Success Criteria** (what must be TRUE):
  1. NestJS guard verifies Firebase ID tokens via `firebase-admin` SDK when `AUTH_PROVIDER=firebase`
  2. React UI shows Firebase login/register with email+password, Google, and GitHub options
  3. `AUTH_PROVIDER=local` (default) uses JWT email+password auth; `AUTH_PROVIDER=firebase` uses Firebase -- switching requires only env var change
  4. Firebase-authenticated users get local user records created on first login (sync from Firebase UID)
**Plans**: TBD

<details>
<summary>Old v2.0 Phases (11-15) -- partially complete, restructured</summary>

Phase 11 (Repo & Infrastructure) is complete and stays as-is.
Phases 12-15 (DB, Inference, Docker, CI/CD) are restructured:
- DB work moved to Phases 22-23 (now includes RLS)
- Auth work moved to Phases 16-17, 24 (expanded scope)
- Inference abstraction deferred to v3.0
- Docker/CI-CD deferred to v3.0

### Phase 11: Repository & Infrastructure Foundation (COMPLETE)
**Plans:** 1/1 plans complete
- [x] 11-01: Clean inline secrets and sanitize git history (REPO-04)
- [x] 11-02: Create GitHub org, open-core and prod-core repos (REPO-01, REPO-02, REPO-03)
- [x] 11-03: VPS configuration and DNS setup (DEP-01, DEP-05)

</details>

## Phase Details (v2.1)

### Phase 25: Source Type Reclassification
**Goal**: Photo searches return actual photos and only photos -- the source type classification is correct at the connector level, backfilled in historical data, and the NLQ workaround hack is removed
**Depends on**: Phase 24 (v2.0 complete)
**Requirements**: SRC-01, SRC-02, SRC-03, SRC-04
**Success Criteria** (what must be TRUE):
  1. Running a photos-immich sync produces memories with `source_type: 'photo'` (not `'file'`)
  2. Searching for "photos" or filtering by `source_type=photo` returns only photo memories -- no Slack file attachments mixed in
  3. The `SOURCE_TYPE_ALIASES` mapping in NLQ parser and memory service is removed, and photo queries still work correctly using the native `photo` type
  4. Qdrant vector payloads for existing photo memories show `source_type: 'photo'` after backfill
**Plans**: 2 plans

Plans:
- [x] 25-01-PLAN.md -- Connector fix, QdrantService.setPayload, backfill migration script (SRC-01, SRC-02, SRC-03)
- [x] 25-02-PLAN.md -- Remove SOURCE_TYPE_ALIASES hack (SRC-04)

### Phase 26: Entity Format & Quality
**Goal**: Entity extraction produces clean, correctly-typed, deduplicated entities in a single consistent format across the entire pipeline
**Depends on**: Phase 25 (source types must be correct before entity re-extraction makes sense)
**Requirements**: FMT-01, FMT-02, FMT-03, ENT-01, ENT-02, ENT-03, ENT-04, ENT-05
**Success Criteria** (what must be TRUE):
  1. Entities from both embed and enrich steps use the same `{type, value}` shape -- no format mismatches between pipeline stages
  2. A newly synced email or message produces entities with only canonical types (PERSON, ORGANIZATION, LOCATION, DATE, EVENT, PRODUCT, CONCEPT, QUANTITY, LANGUAGE, OTHER) -- no hallucinated types like "GREETING" or "SCHEDULE"
  3. Entity values do not contain empty strings, single characters, pronouns ("I", "you"), bare URLs, or generic terms ("hello", "thanks") -- the normalizer strips these
  4. A single memory with duplicate mentions of the same entity (e.g., "John" mentioned 5 times) stores only one entity entry after dedup
  5. No duplicate `memoryLinks` are created when re-processing a memory -- the existence check prevents insert errors
**Plans**: 2 plans

Plans:
- [x] 26-01-PLAN.md -- Entity normalizer pure function with tests + updated extraction prompt (FMT-01, ENT-01, ENT-02, ENT-03, ENT-04, ENT-05)
- [x] 26-02-PLAN.md -- Wire normalizer into enrich + embed pipeline, fix createLinks duplicate bug (FMT-02, FMT-03)

### Phase 27: Data Backfill
**Goal**: All existing memories are re-enriched with the corrected entity extraction pipeline, with progress tracking and the ability to pause/resume
**Depends on**: Phase 26 (corrected pipeline must be in place before re-processing data)
**Requirements**: BKF-01, BKF-02, BKF-03, BKF-04
**Success Criteria** (what must be TRUE):
  1. Running the backfill job re-enriches existing memories with updated entity extraction (new prompt, normalizer, dedup)
  2. Interrupting and restarting the backfill resumes from where it left off -- already-processed memories are skipped
  3. Backfill progress (processed/total, current connector) is visible in the frontend via WebSocket updates
  4. User can start a backfill filtered to a specific connector type (e.g., only re-enrich Gmail memories)
**Plans**: TBD

### Phase 28: Verification
**Goal**: End-to-end confirmation that search, graph visualization, and NLQ queries produce correct, clean results after all data quality fixes
**Depends on**: Phase 27 (all fixes and backfill must be complete)
**Requirements**: VER-01, VER-02, VER-03, VER-04
**Success Criteria** (what must be TRUE):
  1. A fresh re-sync of a connector (e.g., Gmail) produces correct source types and clean entities without needing a separate backfill step
  2. Searching for "photos" returns only actual photos from photos-immich -- zero Slack file attachments in results
  3. The memory graph shows entities with correct canonical types, no duplicates within a memory, and no garbage nodes
  4. NLQ queries like "show me photos from last week" use `source_type: 'photo'` directly (no alias resolution) and return correct results

**Plans**: TBD

## Phase Details (v3.0)

### Phase 29: Foundation Config
**Goal**: Developer has consistent code quality tooling across all packages -- linting catches errors, formatting is automatic, type errors are surfaced before runtime, and environment setup is self-documenting
**Depends on**: Phase 28 (v2.1 complete) -- but can execute independently as it is config-only additions
**Requirements**: QUAL-01, QUAL-02, QUAL-03, DOCK-03
**Success Criteria** (what must be TRUE):
  1. Running `pnpm lint` from the repo root lints all packages with ESLint 9 flat config and reports TypeScript errors consistently across API, web, CLI, and all library packages
  2. Running `pnpm format` (or saving a file with editor integration) auto-formats code with Prettier -- formatting is consistent across the entire monorepo
  3. Running `pnpm typecheck` executes `tsc --noEmit` across all packages via Turbo and catches type errors without producing build output
  4. A new developer can copy `.env.example` to `.env` and have a working configuration with safe defaults for all 11+ environment variables
**Plans**: 1 plan

Plans:
- [x] 29-01-PLAN.md -- ESLint 9, Prettier, typecheck, .env.example (QUAL-01, QUAL-02, QUAL-03, DOCK-03)

### Phase 30: Dev Workflow Fix
**Goal**: Developer can start the full dev environment with a single command and iterate on code changes across any package without port conflicts, restart storms, or manual pre-build steps
**Depends on**: Phase 29 (linting and typecheck must exist so they can be referenced by turbo task graph)
**Requirements**: DEV-01, DEV-02, DEV-03, DEV-04, DOCK-04
**Success Criteria** (what must be TRUE):
  1. Running `pnpm dev` starts the API and web dev servers without spawning competing instances or port conflicts -- a single API process owns port 12412
  2. Editing a TypeScript file in a library package (e.g., `@botmem/shared`) triggers the API to pick up the change without manual rebuild or restart
  3. Creating a new connector package with the correct `package.json` and adding it as a dependency requires zero changes to root dev scripts or turbo watch config
  4. All library packages (`shared`, `connector-sdk`, `cli`) have proper conditional `exports` fields that resolve correctly for both CJS (NestJS API) and ESM (React web) consumers
  5. `GET /api/health` returns JSON with connectivity status of Redis, Qdrant, and SQLite -- each showing `connected: true/false`
**Plans**: 2 plans

Plans:
- [x] 30-01-PLAN.md -- Dev workflow overhaul: CJS exports, turbo watch, nest build --watch (DEV-01, DEV-02, DEV-03, DEV-04) (completed 2026-03-08)
- [x] 30-02-PLAN.md -- Health endpoint with Redis/Qdrant/SQLite probes (DOCK-04) (completed 2026-03-08)

### Phase 31: Docker & Infrastructure
**Goal**: Developer can start all required infrastructure with one command, with Ollama available as an opt-in profile, and a Makefile providing a simple command layer for common operations
**Depends on**: Phase 30 (health endpoint needed for Docker Compose health checks; dev workflow must be stable before layering infrastructure)
**Requirements**: DOCK-01, DOCK-02
**Success Criteria** (what must be TRUE):
  1. Running `docker compose up` starts Redis and Qdrant with health checks that report healthy within 30 seconds; running `docker compose --profile ollama up` additionally starts Ollama
  2. Running `make dev` starts Docker infrastructure (Redis + Qdrant) and then the application dev servers -- a single command from clone to running app
  3. Docker Compose services use pinned image versions (not `latest`) and all services have health check definitions
**Plans**: TBD

### Phase 32: Build Optimization
**Goal**: Dependency versions are centralized so upgrades touch one file instead of ten, and code quality is enforced automatically on every commit and push
**Depends on**: Phase 31 (Makefile targets reference Docker Compose commands; infrastructure must be stable)
**Requirements**: BUILD-01, QUAL-04
**Success Criteria** (what must be TRUE):
  1. TypeScript, Vitest, and Vite versions are specified once in `pnpm-workspace.yaml` catalogs and all package.json files reference them via `catalog:` protocol -- upgrading requires changing one line
  2. Committing code triggers a pre-commit hook that runs ESLint fix + Prettier on staged files -- badly formatted code cannot be committed
  3. Pushing code triggers a pre-push hook that runs typecheck and tests on changed packages -- type errors and test failures are caught before they reach the remote
**Plans**: TBD

### Phase 33: Production Docker
**Goal**: The API can be built into an optimized production Docker image suitable for deployment
**Depends on**: Phase 32 (pnpm catalogs must be stable so the lockfile is finalized before Docker build)
**Requirements**: BUILD-02
**Success Criteria** (what must be TRUE):
  1. `docker build` produces a production image using multi-stage build with `turbo prune` that includes only the API and its workspace dependencies -- not the web app or dev tooling
  2. The production image size is under 500MB (compared to a naive full-monorepo image)
  3. The production container starts and responds to `GET /api/health` with correct connectivity status
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 8.1 -> 9 -> 10 -> 11 -> 16 -> 17 -> 18 -> 19 -> 20 -> 21 -> 22 -> 23 -> 24 -> 25 -> 26 -> 27 -> 28 -> 29 -> 30 -> 31 -> 32 -> 33

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Search Quality | v1.0 | 2/2 | Complete | 2026-03-07 |
| 2. Operational Maturity | v1.0 | 2/2 | Complete | 2026-03-07 |
| 3. Extensibility | v1.0 | 2/2 | Complete | 2026-03-07 |
| 4. PostHog Activation | v1.1 | 2/2 | Complete | 2026-03-07 |
| 5. SDK Feature Enablement | v1.2 | 2/2 | Complete | 2026-03-08 |
| 6. Verification and Dashboards | v1.2 | 2/2 | Complete | 2026-03-08 |
| 7. Test Infrastructure Fixes | v1.3 | 2/2 | Complete | 2026-03-08 |
| 8. Entity Type Taxonomy | v1.4 | 2/2 | Complete | 2026-03-08 |
| 8.1 Contact Auto-Merge | v1.4 | 2/2 | Complete | 2026-03-08 |
| 9. NLQ Parsing | v1.4 | 2/2 | Complete | 2026-03-08 |
| 10. Source Citations | v1.4 | 0/? | Deferred | - |
| 11. Repo & Infrastructure | v2.0 | 3/3 | Complete | 2026-03-08 |
| 16. User Authentication | v2.0 | 3/3 | Complete | 2026-03-08 |
| 17. API Security | v2.0 | 1/1 | Complete | 2026-03-08 |
| 18. API Keys | v2.0 | 0/2 | Not started | - |
| 19. Memory Banks | v2.0 | 0/? | Not started | - |
| 20. Encryption at Rest | v2.0 | 0/? | Not started | - |
| 21. E2EE (Prod-Core) | v2.0 | 0/? | Not started | - |
| 22. PostgreSQL Dual-Driver | v2.0 | 0/? | Not started | - |
| 23. Row Level Security | v2.0 | 0/? | Not started | - |
| 24. Firebase Auth (Prod-Core) | v2.0 | 0/? | Not started | - |
| 25. Source Type Reclassification | v2.1 | Complete | 2026-03-08 | 2026-03-08 |
| 26. Entity Format & Quality | v2.1 | Complete    | 2026-03-08 | 2026-03-08 |
| 27. Data Backfill | v2.1 | 0/? | Not started | - |
| 28. Verification | v2.1 | 0/? | Not started | - |
| 29. Foundation Config | v3.0 | Complete    | 2026-03-08 | 2026-03-08 |
| 30. Dev Workflow Fix | v3.0 | 2/2 | Complete | 2026-03-08 |
| 31. Docker & Infrastructure | v3.0 | 0/? | Not started | - |
| 32. Build Optimization | v3.0 | 0/? | Not started | - |
| 33. Production Docker | v3.0 | 0/? | Not started | - |

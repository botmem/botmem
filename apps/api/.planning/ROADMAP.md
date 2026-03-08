# Roadmap: Botmem

## Milestones

- v1.0 MVP - Phases 1-3 (shipped 2026-03-07)
- v1.1 PostHog Analytics Activation - Phase 4 (shipped 2026-03-07)
- v1.2 PostHog Deep Analytics - Phases 5-6 (shipped 2026-03-08)
- v1.3 Test Coverage - Phase 7 (shipped 2026-03-08)
- v1.4 Search Intelligence - Phases 8-10 (shipped 2026-03-08)
- v2.0 Security, Auth & Encryption - Phases 16-24 (in progress)
- v3.0 Production Deployment & CI/CD - (planned, deferred from old v2.0)

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

### Phase 8-10 details (collapsed — see phase directories for plans)

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
- [ ] **Phase 16: User Authentication** - Register, login, JWT access+refresh tokens, password reset, session persistence (AUTH-01 through AUTH-05)
- [ ] **Phase 17: API Security** - Global auth guard, CORS lockdown, @Public() decorator for health/version/auth endpoints (SEC-01, SEC-02)
- [ ] **Phase 18: API Keys** - Named read-only API keys, cryptographic generation, bank scoping, Bearer header auth (KEY-01 through KEY-05)
- [ ] **Phase 19: Memory Banks** - Create/list/rename/delete banks, sync-time selection, search scoping, default bank + data migration (BANK-01 through BANK-04)
- [ ] **Phase 20: Encryption at Rest** - AES-256-GCM for authContext + connectorCredentials, APP_SECRET key, migration script (ENC-01, ENC-02)
- [ ] **Phase 21: End-to-End Encryption** - Argon2id key derivation, client-side memory encryption, vectors plaintext, password change re-encryption (E2EE-01 through E2EE-04)
- [ ] **Phase 22: PostgreSQL Dual-Driver** - Postgres schema, shared DB interface, conditional driver, FTS5->tsvector (DB-01 through DB-04)
- [ ] **Phase 23: Row Level Security** - Postgres RLS policies for user data isolation (DB-05)
- [ ] **Phase 24: Firebase Auth (Prod-Core)** - Firebase guard, React Firebase UI, AUTH_PROVIDER switch, social login (FBAUTH-01 through FBAUTH-04)

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
- [ ] 16-01-PLAN.md -- Backend auth infrastructure: schema, JWT, register/login/refresh/logout
- [ ] 16-02-PLAN.md -- Password reset infrastructure: passwordResets table, MailService
- [ ] 16-03-PLAN.md -- Frontend auth rewrite + password reset endpoints wiring

### Phase 17: API Security
**Goal**: All API endpoints require authentication except explicitly public ones, and CORS is locked to the frontend origin
**Depends on**: Phase 16 (auth system must exist to enforce)
**Requirements**: SEC-01, SEC-02
**Success Criteria** (what must be TRUE):
  1. Unauthenticated requests to any endpoint (except `/health`, `/version`, `/auth/*`) return 401 Unauthorized
  2. WebSocket connections require valid JWT token in handshake
  3. CORS only allows requests from FRONTEND_URL origin(s), with credentials mode enabled
  4. OAuth callback endpoints for connectors still work (they are marked @Public)
**Plans**: TBD

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
**Plans**: TBD

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

### Phase 34: NestJS Best Practices Maturation
**Goal**: API codebase meets NestJS best practices for input validation, rate limiting, transactions, structured logging, and security hardening -- no business logic changes
**Depends on**: Existing codebase (standalone hardening phase)
**Requirements**: BP-01, BP-02, BP-03, BP-04, BP-05, BP-06, BP-07
**Success Criteria** (what must be TRUE):
  1. All controller endpoints validate input via class-validator DTOs and global ValidationPipe
  2. Auth endpoints are rate-limited (login 5/min, register 3/min) and AI endpoints are rate-limited (20/min)
  3. Multi-table delete operations are wrapped in SQLite transactions
  4. Zero console.log/warn/error calls remain in production source files
  5. Production startup fails if secrets use default values
  6. Authorization gaps are closed (account ownership, user filtering, admin endpoint restrictions)
  7. Agent controller returns proper HTTP status codes, not 200 with error body
**Plans**: 3 plans

Plans:
- [ ] 34-01-PLAN.md -- Input validation (DTOs + ValidationPipe) and rate limiting (ThrottlerModule)
- [ ] 34-02-PLAN.md -- Structured logging (NestJS Logger) and database transactions
- [ ] 34-03-PLAN.md -- Security hardening, authorization fixes, and error handling cleanup

<details>
<summary>Old v2.0 Phases (11-15) — partially complete, restructured</summary>

Phase 11 (Repo & Infrastructure) is complete and stays as-is.
Phases 12-15 (DB, Inference, Docker, CI/CD) are restructured:
- DB work moved to Phases 22-23 (now includes RLS)
- Auth work moved to Phases 16-17, 24 (expanded scope)
- Inference abstraction deferred to v3.0
- Docker/CI-CD deferred to v3.0

### Phase 11: Repository & Infrastructure Foundation (COMPLETE)
**Plans:** 3/3 plans complete
- [x] 11-01: Clean inline secrets and sanitize git history (REPO-04)
- [x] 11-02: Create GitHub org, open-core and prod-core repos (REPO-01, REPO-02, REPO-03)
- [x] 11-03: VPS configuration and DNS setup (DEP-01, DEP-05)

</details>

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 8.1 -> 9 -> 10 -> 11 -> 16 -> 17 -> 18 -> 19 -> 20 -> 21 -> 22 -> 23 -> 24 -> 34

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
| 16. User Authentication | v2.0 | 0/3 | Planning | - |
| 17. API Security | v2.0 | 0/? | Not started | - |
| 18. API Keys | v2.0 | 0/? | Not started | - |
| 19. Memory Banks | v2.0 | 0/? | Not started | - |
| 20. Encryption at Rest | v2.0 | 0/? | Not started | - |
| 21. E2EE (Prod-Core) | v2.0 | 0/? | Not started | - |
| 22. PostgreSQL Dual-Driver | v2.0 | 0/? | Not started | - |
| 23. Row Level Security | v2.0 | 0/? | Not started | - |
| 24. Firebase Auth (Prod-Core) | v2.0 | 0/? | Not started | - |
| 34. NestJS Best Practices | v2.0 | 0/3 | Planning | - |

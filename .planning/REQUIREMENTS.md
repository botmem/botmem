# Requirements: Botmem

**Core Value:** Every piece of personal communication is searchable, connected, and queryable -- with factuality labeling so the user knows what's verified vs. hearsay.

## v2.0 Requirements -- Security, Auth & Encryption

**Defined:** 2026-03-08

### User Auth (Open-Core) — always required, no bypass

- [x] **AUTH-01**: Register with email + password (bcrypt hash, minimum 8 chars)
- [x] **AUTH-02**: Login → JWT access token (15min) + httpOnly refresh cookie (7d)
- [x] **AUTH-03**: Refresh access token via `POST /auth/refresh` using refresh cookie
- [x] **AUTH-04**: Password reset via email link (cryptographic token, 1hr expiry)
- [x] **AUTH-05**: Session persistence via refresh token rotation (old token invalidated on use)

### Firebase Auth (Prod-Core)

- [x] **FBAUTH-01**: NestJS guard verifies Firebase ID tokens via `firebase-admin` SDK
- [x] **FBAUTH-02**: React login/register UI with Firebase client SDK (email+password, Google, GitHub)
- [x] **FBAUTH-03**: `AUTH_PROVIDER=local|firebase` env var selects auth provider at startup
- [x] **FBAUTH-04**: Firebase social login (Google, GitHub) available in prod-core only

### API Security

- [x] **SEC-01**: Auth guard on all endpoints (except `/health`, `/version`, `/auth/*`)
- [x] **SEC-02**: CORS locked to `FRONTEND_URL` origin(s), credentials mode enabled

### API Keys

- [ ] **KEY-01**: Create multiple named API keys per user (cryptographic generation, stored hashed)
- [ ] **KEY-02**: All API keys are read-only (search, list memories/contacts — no writes, no sync, no delete)
- [ ] **KEY-03**: Keys scoped to specific memory bank(s) at creation time
- [ ] **KEY-04**: List and revoke API keys via authenticated endpoints
- [ ] **KEY-05**: API keys authenticate via `Authorization: Bearer <key>` header, coexist with JWT auth

### Memory Banks

- [x] **BANK-01**: Create, list, rename, and delete memory banks per user
- [x] **BANK-02**: Select target memory bank at sync time (connector sync config)
- [x] **BANK-03**: Search scoped to accessible bank(s) — user's own banks + API key bank scope
- [x] **BANK-04**: Default bank created on registration + migration of existing data into default bank

### Encryption at Rest (Open-Core)

- [x] **ENC-01**: AES-256-GCM encryption for `authContext` (accounts table) and `connectorCredentials` table, key derived from `APP_SECRET` env var
- [x] **ENC-02**: Migration script to encrypt existing plaintext credentials with zero downtime

### E2EE (Prod-Core)

- [x] **E2EE-01**: Encryption key derived from user password via Argon2id (client-side, in browser)
- [x] **E2EE-02**: Memory text + metadata encrypted client-side before storage (server never sees plaintext)
- [x] **E2EE-03**: Embedding vectors stay plaintext (semantic search continues to work)
- [x] **E2EE-04**: Password change re-derives key + re-encrypts all user memories (batched, resumable)

### Database

- [x] **DB-01**: PostgreSQL schema (`schema.ts`) uses pgTable with native Postgres types (boolean, timestamptz, jsonb, doublePrecision)
- [x] **DB-02**: DbService uses pg Pool + NodePgDatabase with async init and graceful shutdown
- [x] **DB-03**: ConfigService validates DATABASE_URL at startup (fail-fast OnModuleInit pattern)
- [x] **DB-04**: SQLite FTS5 ported to PostgreSQL tsvector + GIN index for full-text search
- [x] **DB-05**: PostgreSQL RLS policies isolate user data — each user sees only their own memories, accounts, contacts

### v2.0 Out of Scope

| Feature                          | Reason                                                              |
| -------------------------------- | ------------------------------------------------------------------- |
| OAuth social login on open-core  | Firebase handles social login for prod-core only                    |
| Write-capable API keys           | Read-only is sufficient for agent/CLI use; writes require full auth |
| Multi-tenancy admin dashboard    | Single-user focus; admin features deferred                          |
| Docker/Caddy/CI-CD deployment    | Deferred to v3.0                                                    |
| OpenRouter inference abstraction | Deferred to v3.0                                                    |
| Rate limiting                    | Can be added later without architectural changes                    |
| Key escrow / recovery            | Zero-knowledge design: lost password = lost data (by design)        |

### v2.0 Traceability

| Requirement | Phase    | Status   |
| ----------- | -------- | -------- |
| AUTH-01     | Phase 16 | Complete |
| AUTH-02     | Phase 16 | Complete |
| AUTH-03     | Phase 16 | Complete |
| AUTH-04     | Phase 16 | Complete |
| AUTH-05     | Phase 16 | Complete |
| SEC-01      | Phase 17 | Complete |
| SEC-02      | Phase 17 | Complete |
| KEY-01      | Phase 18 | Pending  |
| KEY-02      | Phase 18 | Pending  |
| KEY-03      | Phase 18 | Pending  |
| KEY-04      | Phase 18 | Pending  |
| KEY-05      | Phase 18 | Pending  |
| BANK-01     | Phase 19 | Complete |
| BANK-02     | Phase 19 | Complete |
| BANK-03     | Phase 19 | Complete |
| BANK-04     | Phase 19 | Complete |
| ENC-01      | Phase 20 | Complete |
| ENC-02      | Phase 20 | Complete |
| E2EE-01     | Phase 21 | Complete |
| E2EE-02     | Phase 21 | Complete |
| E2EE-03     | Phase 21 | Complete |
| E2EE-04     | Phase 21 | Complete |
| DB-01       | Phase 22 | Complete |
| DB-02       | Phase 22 | Complete |
| DB-03       | Phase 22 | Complete |
| DB-04       | Phase 22 | Complete |
| DB-05       | Phase 23 | Complete |
| FBAUTH-01   | Phase 24 | Complete |
| FBAUTH-02   | Phase 24 | Complete |
| FBAUTH-03   | Phase 24 | Complete |
| FBAUTH-04   | Phase 24 | Complete |

**v2.0 Coverage:**

- v2.0 requirements: 30 total (AUTH: 5, FBAUTH: 4, SEC: 2, KEY: 5, BANK: 4, ENC: 2, E2EE: 4, DB: 5)
- Mapped to phases: 30 (Phases 16-24, skipping FBAUTH to end)
- Unmapped: 0

## Previous Milestones (Completed)

### v1.4 -- Search Intelligence (Complete)

- [x] ENT-01, ENT-02, ENT-03 (Entity Classification)
- [x] NLQ-01, NLQ-02, NLQ-03 (NLQ Parsing)
- [x] PERF-01 (Search Performance)
- [ ] CIT-01 (Source Citations -- deferred)

### v1.3 -- Test Coverage (Complete)

- [x] Test infrastructure fixes

### v1.2 -- PostHog Deep Analytics (Complete)

- [x] REPLAY-01-03, HEAT-01-03, ERR-01-03, WEB-01-03, PROD-01-03, ID-01-02

### v1.1 -- PostHog Analytics Activation (Complete)

- [x] CFG-01-02, VER-01-05, COV-01-02

## v2.1 Requirements -- Data Quality & Pipeline Integrity

**Defined:** 2026-03-08

### Source Type Classification

- [x] **SRC-01**: Photos connector emits `photo` source type instead of `file`
- [x] **SRC-02**: Existing photo memories reclassified from `file` to `photo` in SQLite
- [x] **SRC-03**: Qdrant vector payloads updated with corrected `source_type` for photos
- [x] **SRC-04**: `SOURCE_TYPE_ALIASES` hack removed from NLQ parser and memory service

### Entity Extraction Quality

- [x] **ENT-01**: Entity extraction enforces canonical 10-type taxonomy via post-processing validation
- [x] **ENT-02**: Garbage entity values stripped (empty strings, single characters, pronouns, URLs, generic terms)
- [x] **ENT-03**: Duplicate entities within a single memory are deduplicated by normalized value+type
- [x] **ENT-04**: Entity extraction prompt improved with connector-aware examples and stricter instructions
- [x] **ENT-05**: Entity count capped per memory to prevent extraction bloat

### Entity Format & Storage

- [x] **FMT-01**: Entity format unified to single `{type, value}` shape across embed and enrich steps
- [x] **FMT-02**: `createLinks` duplicate link bug fixed with existence check before insert
- [x] **FMT-03**: Embed-step entities persisted in memory metadata for traceability

### Data Backfill

- [x] **BKF-01**: Backfill pipeline re-enriches existing memories with corrected entity extraction
- [x] **BKF-02**: Backfill is resumable and interruptible (tracks progress, skips completed)
- [x] **BKF-03**: Backfill progress visible via WebSocket real-time updates
- [x] **BKF-04**: Backfill supports selective filtering by connector type

### Verification

- [x] **VER-01**: Fresh re-sync of a connector produces correct source types and clean entities without backfill
- [x] **VER-02**: Photo search returns only photos (not Slack file attachments)
- [x] **VER-03**: Entity graph shows deduplicated, correctly-typed entities
- [x] **VER-04**: NLQ queries for photos use `photo` source type naturally

### v2.1 Out of Scope

| Feature                                         | Reason                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| Cross-memory entity dedup (global entity table) | Adds significant complexity; per-memory dedup is sufficient for v2.1 |
| Entity linking to external knowledge bases      | Overkill for personal memory system                                  |
| Upgrading Ollama model (qwen3:0.6b -> larger)   | Test improvements with current model first                           |
| rawEvents payload JSON mutation                 | Treat rawEvents as immutable audit log                               |

### v2.1 Traceability

| Requirement | Phase    | Status   |
| ----------- | -------- | -------- |
| SRC-01      | Phase 25 | Complete |
| SRC-02      | Phase 25 | Complete |
| SRC-03      | Phase 25 | Complete |
| SRC-04      | Phase 25 | Complete |
| FMT-01      | Phase 26 | Complete |
| FMT-02      | Phase 26 | Complete |
| FMT-03      | Phase 26 | Complete |
| ENT-01      | Phase 26 | Complete |
| ENT-02      | Phase 26 | Complete |
| ENT-03      | Phase 26 | Complete |
| ENT-04      | Phase 26 | Complete |
| ENT-05      | Phase 26 | Complete |
| BKF-01      | Phase 27 | Complete |
| BKF-02      | Phase 27 | Complete |
| BKF-03      | Phase 27 | Complete |
| BKF-04      | Phase 27 | Complete |
| VER-01      | Phase 28 | Complete |
| VER-02      | Phase 28 | Complete |
| VER-03      | Phase 28 | Complete |
| VER-04      | Phase 28 | Complete |

**v2.1 Coverage:**

- v2.1 requirements: 18 total (SRC: 4, ENT: 5, FMT: 3, BKF: 4, VER: 4)
- Mapped to phases: 18 (Phases 25-28)
- Unmapped: 0

## v3.0 Requirements -- Monorepo & Developer Experience

**Defined:** 2026-03-08

### Code Quality

- [x] **QUAL-01**: Developer can run ESLint across all packages with a single command and get consistent TypeScript linting
- [x] **QUAL-02**: All code is auto-formatted on save/commit with Prettier using consistent rules
- [x] **QUAL-03**: Developer can run typecheck across all packages as a standalone Turbo task
- [x] **QUAL-04**: Committing code automatically runs lint+format on staged files; pushing runs typecheck+tests on changed packages

### Dev Workflow

- [x] **DEV-01**: Running `pnpm dev` starts the full dev environment without port conflicts or restart storms
- [x] **DEV-02**: File changes in workspace packages trigger dependency-aware restarts without manual pre-builds
- [x] **DEV-03**: Adding a new connector package requires zero changes to the root dev script or watch config
- [x] **DEV-04**: All library packages have proper conditional exports fields enabling clean resolution by both CJS and ESM consumers

### Docker & Infrastructure

- [x] **DOCK-01**: Running `docker compose up` starts Redis + Qdrant with health checks; `--profile ollama` adds Ollama
- [x] **DOCK-02**: Developer can run `make dev` to start infrastructure + app with a single command
- [x] **DOCK-03**: New developers can read `.env.example` to understand all required and optional environment variables
- [x] **DOCK-04**: `GET /api/health` returns connectivity status of Redis, Qdrant, and SQLite

### Build Optimization

- [x] **BUILD-01**: TypeScript, Vitest, and Vite versions are defined once in pnpm catalogs, referenced everywhere
- [x] **BUILD-02**: Production Docker image uses multi-stage build with turbo prune for minimal image size

### v3.0 Out of Scope

| Feature                           | Reason                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| pnpm 10 upgrade                   | Breaking changes (no hoisting, lifecycle script restrictions) — risk outweighs benefit |
| Nx migration                      | Turbo is sufficient, already in use, lower migration cost                              |
| Biome (ESLint replacement)        | ESLint ecosystem is larger, typescript-eslint is mature, Biome still stabilizing       |
| TypeScript project references     | Maintenance burden exceeds compile-time benefit at <15 packages                        |
| Shared config packages            | Overengineered for single-developer monorepo — root configs sufficient                 |
| Changesets / version management   | Not publishing to npm, no external consumers                                           |
| commitlint / conventional commits | Nice-to-have but adds friction without team coordination need                          |
| CJS → ESM migration for API       | NestJS 11 does not officially support ESM (issue #13319). High risk, zero user value   |

### v3.0 Traceability

| Requirement | Phase    | Status   |
| ----------- | -------- | -------- |
| QUAL-01     | Phase 29 | Complete |
| QUAL-02     | Phase 29 | Complete |
| QUAL-03     | Phase 29 | Complete |
| QUAL-04     | Phase 32 | Complete |
| DEV-01      | Phase 30 | Complete |
| DEV-02      | Phase 30 | Complete |
| DEV-03      | Phase 30 | Complete |
| DEV-04      | Phase 30 | Complete |
| DOCK-01     | Phase 31 | Complete |
| DOCK-02     | Phase 31 | Complete |
| DOCK-03     | Phase 29 | Complete |
| DOCK-04     | Phase 30 | Complete |
| BUILD-01    | Phase 32 | Complete |
| BUILD-02    | Phase 33 | Complete |

**v3.0 Coverage:**

- v3.0 requirements: 14 total (QUAL: 4, DEV: 4, DOCK: 4, BUILD: 2)
- Mapped to phases: 14 (Phases 29-33)
- Unmapped: 0 ✓

## v4.0 Requirements — E2E Testing & Test Infrastructure

**Defined:** 2026-03-09

**Execution dependency:** Phases 35-39 require v2.0 phases 21 (E2EE), 23 (RLS), and 24 (Firebase) to complete first — test infrastructure must be built against the final auth/DB architecture.

### Fixture Capture (FIXTURE)

- [ ] **FIXTURE-01**: Developer can run `pnpm fixtures:generate` to execute a controlled pipeline against live Ollama and record all embed/enrich/vision LLM I/O as JSON fixtures
- [ ] **FIXTURE-02**: Fixture files exist for each LLM call type: `__fixtures__/ollama/embed/*.json` (input_text → 768d vector), `__fixtures__/ollama/enrich/*.json` (memory_text → entities/claims/factuality), `__fixtures__/ollama/vl/*.json` (image → caption)
- [ ] **FIXTURE-03**: Fixture files exist for each connector's raw payloads: `__fixtures__/connectors/` with one sample per connector type (gmail, slack, imessage, immich, locations)
- [ ] **FIXTURE-04**: Developer can run `pnpm fixtures:refresh` to regenerate fixtures when the Ollama model or prompt changes
- [ ] **FIXTURE-05**: A fixture loader utility is available for test files to load any fixture by type and key — no duplicate loading logic across test files

### Pipeline Integration Tests (PIPE)

- [ ] **PIPE-01**: `embed.processor.integration.test.ts` runs the real EmbedProcessor against a fresh Postgres DB using fixture embeddings — asserts Memory row is created with correct text, source_type, connector_type, and contact associations
- [ ] **PIPE-02**: `enrich.processor.integration.test.ts` runs the real EnrichProcessor against a fresh Postgres DB using fixture enrichment — asserts entities, claims, factuality label, and encryption fields are stored correctly
- [ ] **PIPE-03**: `sync.processor.integration.test.ts` runs the real SyncProcessor with a mock connector emitting fixture payloads — asserts rawEvents are persisted and embed jobs are enqueued
- [ ] **PIPE-04**: A shared `test-db` helper spins up a fresh isolated Postgres schema, runs all Drizzle migrations, and tears down after each test suite — no test pollution between suites
- [ ] **PIPE-05**: `backfill.integration.test.ts` runs the backfill pipeline against fixture data — asserts resume behavior (already-enriched memories skipped) and correct entity output

### API HTTP Integration Tests (API)

- [ ] **API-01**: Auth flow is fully tested end-to-end: register → login → refresh → logout → forgot-password → reset-password — all return correct status codes and shapes
- [ ] **API-02**: `POST /api/memory/search` with fixture embeddings returns correctly ranked results with the expected schema (id, text, score, source_type, entities)
- [ ] **API-03**: Connector account CRUD endpoints are tested: create account, list accounts, delete account, trigger sync (mocked connector), cancel job, poll status
- [ ] **API-04**: Memory bank endpoints are tested: create bank, list banks, rename bank, delete bank, default bank assignment
- [ ] **API-05**: API key endpoints are tested: create key (returned once), list keys, revoke key — key auth grants read-only access, JWT auth grants full access
- [ ] **API-06**: Contact endpoints are tested: list contacts, get contact details, merge suggestions endpoint
- [ ] **API-07**: `GET /api/health` returns 200 with connectivity status for all services (Postgres, Redis, Qdrant)
- [ ] **API-08**: Unauthenticated requests to protected endpoints return 401; API key requests to write endpoints return 403

### Connector Parsing Tests (CONN)

- [ ] **CONN-01**: Gmail connector parsing test: given a fixture MIME email payload, produces a normalized Memory with correct participants (sender/recipient), subject, body text, and attachment metadata
- [ ] **CONN-02**: Slack connector parsing test: given a fixture Slack Events API payload, produces a normalized Memory with correct sender, channel, thread reference, and reactions
- [ ] **CONN-03**: iMessage connector parsing test: given a fixture SQLite DB (sample rows), produces message memories with correct sender, recipient, timestamp, and text
- [ ] **CONN-04**: Photos-Immich connector parsing test: given a fixture Immich API response, produces a photo Memory with `source_type: 'photo'` and correct metadata
- [ ] **CONN-05**: Locations connector parsing test: given a fixture OwnTracks POST payload, produces a location memory with correct lat/lng, timestamp, and source_type

### CI Gates & Coverage (CI)

- [ ] **CI-01**: `.github/workflows/test.yml` runs `pnpm test` across all packages on every PR — tests must pass before the PR can be merged
- [ ] **CI-02**: Fixture directory `__fixtures__/` is cached via `actions/cache` keyed on fixtures checksum — fixture generation is skipped on cache hit
- [ ] **CI-03**: Coverage report (lcov) is uploaded as a GitHub Actions artifact on each test run and posted as a PR comment
- [ ] **CI-04**: Docker image build (deploy workflow) only runs after tests pass — no production deploys with failing tests
- [ ] **CI-05**: Test run fails if overall API package coverage drops below 80% — threshold enforced in vitest config

### v4.0 Out of Scope

| Feature                   | Reason                                                                     |
| ------------------------- | -------------------------------------------------------------------------- |
| Browser E2E (Playwright)  | Deferred to v5.0 — API-level tests sufficient for this milestone           |
| WhatsApp automated E2E    | QR auth makes automated testing impractical — unit test parsing logic only |
| Load/stress testing       | Not a current bottleneck, defer to v5.0                                    |
| Visual regression testing | Requires stable UI; deferred until frontend is finalized                   |

### v4.0 Traceability

| Requirement | Phase    | Status  |
| ----------- | -------- | ------- |
| FIXTURE-01  | Phase 35 | Pending |
| FIXTURE-02  | Phase 35 | Pending |
| FIXTURE-03  | Phase 35 | Pending |
| FIXTURE-04  | Phase 35 | Pending |
| FIXTURE-05  | Phase 35 | Pending |
| PIPE-01     | Phase 36 | Pending |
| PIPE-02     | Phase 36 | Pending |
| PIPE-03     | Phase 36 | Pending |
| PIPE-04     | Phase 36 | Pending |
| PIPE-05     | Phase 36 | Pending |
| API-01      | Phase 37 | Pending |
| API-02      | Phase 37 | Pending |
| API-03      | Phase 37 | Pending |
| API-04      | Phase 37 | Pending |
| API-05      | Phase 37 | Pending |
| API-06      | Phase 37 | Pending |
| API-07      | Phase 37 | Pending |
| API-08      | Phase 37 | Pending |
| CONN-01     | Phase 38 | Pending |
| CONN-02     | Phase 38 | Pending |
| CONN-03     | Phase 38 | Pending |
| CONN-04     | Phase 38 | Pending |
| CONN-05     | Phase 38 | Pending |
| CI-01       | Phase 39 | Pending |
| CI-02       | Phase 39 | Pending |
| CI-03       | Phase 39 | Pending |
| CI-04       | Phase 39 | Pending |
| CI-05       | Phase 39 | Pending |

**v4.0 Coverage:**

- v4.0 requirements: 25 total (FIXTURE: 5, PIPE: 5, API: 8, CONN: 5, CI: 5)
- Mapped to phases: 25 (Phases 35-39)
- Unmapped: 0 ✓

## Future Requirements

Deferred to future releases. Tracked but not in current roadmap.

### v3.1 -- Production Deployment & CI/CD

- **DEP-01**: Vultr VPS provisioning with Docker and swap
- **DEP-02**: Multi-stage Dockerfile for API + web
- **DEP-03**: `docker-compose.prod.yml` with Postgres, Redis, Qdrant, Caddy
- **DEP-04**: Caddyfile with automatic Let's Encrypt SSL
- **DEP-05**: DNS A record for botmem.xyz
- **CICD-01**: GitHub Actions for open-core (lint, test, build)
- **CICD-02**: GitHub Actions for prod-core (lint, test, build, deploy)
- **CICD-03**: SSH deployment pipeline
- **INF-01**: InferenceService interface (Ollama/OpenRouter)
- **INF-02-05**: Provider implementations and fallback scoring

### Monitoring & Operations

- **OPS-01**: Uptime monitoring and alerting
- **OPS-02**: Log aggregation from Docker containers
- **OPS-03**: Automated PostgreSQL backup schedule
- **OPS-04**: Blue-green or rolling deployment strategy

## Out of Scope

| Feature                              | Reason                                          |
| ------------------------------------ | ----------------------------------------------- |
| Kubernetes / container orchestration | Single VPS is sufficient at this scale          |
| Custom domain per user               | Single-tenant production deployment             |
| CDN / edge caching                   | Unnecessary for single-user production instance |
| Multi-region deployment              | Single VPS, single region                       |
| Key escrow / password recovery       | Zero-knowledge E2EE by design                   |

---

_Requirements defined: 2026-03-08_
_Last updated: 2026-03-09 after v4.0 milestone initialization_

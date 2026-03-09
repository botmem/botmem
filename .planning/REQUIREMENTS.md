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

## v4.0 Requirements — Fix Search Once and For All

**Defined:** 2026-03-09

Validate the entire pipeline end-to-end — sync real data from every connector, verify raw event → embed → enrich → Qdrant works correctly, and prove search returns meaningful results.

### Data Ingestion

- [ ] **SYNC-01**: User can sync Gmail and produce raw email events with sender/recipients/body/subject
- [ ] **SYNC-02**: User can sync Slack and produce raw message events with channel/user/thread context
- [ ] **SYNC-03**: User can sync WhatsApp and produce raw message events with participant info
- [ ] **SYNC-04**: User can sync iMessage and produce raw message events with contact associations
- [ ] **SYNC-05**: User can sync Photos-Immich and produce raw photo events with EXIF/location/caption
- [ ] **SYNC-06**: User can sync Locations and produce raw GPS events with timestamp/coordinates

### Pipeline Processing

- [ ] **PIPE-01**: Embed processor creates Memory with correct source_type per connector (email/message/photo/location/file)
- [ ] **PIPE-02**: Embed processor generates valid 768d embedding for every memory
- [ ] **PIPE-03**: Embed processor resolves participants to deduplicated Contact records
- [ ] **PIPE-04**: Enrich processor extracts entities using canonical 10-type taxonomy
- [ ] **PIPE-05**: Enrich processor classifies factuality (FACT/UNVERIFIED/FICTION) with confidence
- [ ] **PIPE-06**: Enrich processor upserts vector to Qdrant with correct payload (memory_id, source_type, connector_type, event_time)
- [ ] **PIPE-07**: File attachments extracted as standalone memories with source_type `file` (own node on graph)
- [ ] **PIPE-08**: Photo-type files processed through vision model for caption extraction, stored as source_type `photo`
- [ ] **PIPE-09**: Non-photo files stored with metadata (filename, type, size) and linked to parent memory

### Relationship Graph

- [ ] **REL-01**: Contact associations created with correct roles (sender/recipient/mentioned) per connector
- [ ] **REL-02**: Entity extraction produces meaningful entities (people, organizations, locations, dates) per connector type
- [ ] **REL-03**: Memory links created for contextually related content (thread replies, conversations)
- [ ] **REL-04**: File/photo memories linked to their parent memory (email, message) in the relationship graph

### Search Quality

- [ ] **SRCH-01**: Semantic search returns relevant memories for natural language queries across all source types
- [ ] **SRCH-02**: Search results properly weighted (semantic + rerank + recency + importance + trust)
- [ ] **SRCH-03**: Cross-connector search returns results from multiple sources for a single query
- [ ] **SRCH-04**: Contact-scoped search finds memories associated with a specific person
- [ ] **SRCH-05**: Temporal search returns time-bounded results ("last week", "in January")
- [ ] **SRCH-06**: Source-type filtering works (search within emails only, messages only, photos only, files only)
- [ ] **SRCH-07**: User can search for content within attachments (photo captions, file metadata)

### v4.0 Out of Scope

| Feature                  | Reason                                                |
| ------------------------ | ----------------------------------------------------- |
| New connector types      | Validating existing 6 connectors, not adding new ones |
| UI/frontend changes      | Focus is pipeline + search backend quality            |
| API key implementation   | Paused v2.0 Phase 18, separate milestone              |
| Performance optimization | Correctness first, speed later                        |

### v4.0 Traceability

| Requirement | Phase | Status  |
| ----------- | ----- | ------- |
| SYNC-01     | —     | Pending |
| SYNC-02     | —     | Pending |
| SYNC-03     | —     | Pending |
| SYNC-04     | —     | Pending |
| SYNC-05     | —     | Pending |
| SYNC-06     | —     | Pending |
| PIPE-01     | —     | Pending |
| PIPE-02     | —     | Pending |
| PIPE-03     | —     | Pending |
| PIPE-04     | —     | Pending |
| PIPE-05     | —     | Pending |
| PIPE-06     | —     | Pending |
| PIPE-07     | —     | Pending |
| PIPE-08     | —     | Pending |
| PIPE-09     | —     | Pending |
| REL-01      | —     | Pending |
| REL-02      | —     | Pending |
| REL-03      | —     | Pending |
| REL-04      | —     | Pending |
| SRCH-01     | —     | Pending |
| SRCH-02     | —     | Pending |
| SRCH-03     | —     | Pending |
| SRCH-04     | —     | Pending |
| SRCH-05     | —     | Pending |
| SRCH-06     | —     | Pending |
| SRCH-07     | —     | Pending |

**v4.0 Coverage:**

- v4.0 requirements: 26 total (SYNC: 6, PIPE: 9, REL: 4, SRCH: 7)
- Mapped to phases: 0
- Unmapped: 26 ⚠️

## Future Requirements

Deferred to future releases. Tracked but not in current roadmap.

### v5.0 — E2E Testing & Test Infrastructure

- **FIXTURE-01**: Fixture capture infrastructure for JSON LLM I/O recordings
- **FIXTURE-02**: Fixture files for each LLM call type (embed/enrich/vision)
- **FIXTURE-03**: Fixture files for each connector's raw payloads
- **PIPE-T-01**: Pipeline integration tests with real Postgres + fixture LLM
- **API-T-01**: API HTTP integration tests via Supertest
- **CONN-T-01**: Connector parsing tests with recorded responses
- **CI-T-01**: CI gates with 80% coverage enforcement

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

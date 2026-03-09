# Roadmap: Botmem

## Milestones

- ✅ v1.0 MVP - Phases 1-3 (shipped 2026-03-07) — [archive](milestones/v1.0-ROADMAP.md)
- ✅ v1.1 PostHog Analytics Activation - Phase 4 (shipped 2026-03-07) — [archive](milestones/v1.1-ROADMAP.md)
- ✅ v1.2 PostHog Deep Analytics - Phases 5-6 (shipped 2026-03-08) — [archive](milestones/v1.2-ROADMAP.md)
- ✅ v1.3 Test Coverage - Phase 7 (shipped 2026-03-08) — [archive](milestones/v1.3-ROADMAP.md)
- ✅ v1.4 Search Intelligence - Phases 8-10 (shipped 2026-03-08) — [archive](milestones/v1.4-ROADMAP.md)
- v2.0 Security, Auth & Encryption - Phases 16-24 (in progress -- 5 API Key requirements pending)
- ✅ v2.1 Data Quality & Pipeline Integrity - Phases 25-28 (shipped 2026-03-09) — [archive](milestones/v2.1-ROADMAP.md)
- ✅ v3.0 Monorepo & Developer Experience - Phases 29-33 (shipped 2026-03-09) — [archive](milestones/v3.0-ROADMAP.md)
- ✅ v3.0.1 NestJS Best Practices - Phase 34 (shipped 2026-03-09) — [archive](milestones/v3.0.1-ROADMAP.md)
- v3.1 Production Deployment & CI/CD - (planned, deferred)
- 🚧 v4.0 Fix Search Once and For All - Phases 35-38 (in progress)
- v5.0 E2E Testing & Test Infrastructure - (planned, deferred)

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
**Plans**: 2 plans

Plans:

- [x] 05-01-PLAN.md -- Enable session replay, autocapture, heatmaps, error tracking, network recording, and backend exception filter
- [x] 05-02-PLAN.md -- User identification with stable ID and person properties

### Phase 6: Verification and Dashboards

**Goal**: PostHog dashboards provide actionable insights on Botmem usage patterns
**Depends on**: Phase 5 (data must be flowing before dashboards can be built)
**Requirements**: REPLAY-02, HEAT-02, ERR-02, WEB-01, WEB-02, PROD-01, PROD-02, PROD-03
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

**Summary:**

- [x] **Phase 16: User Authentication** - Register, login, JWT access+refresh tokens, password reset, session persistence (AUTH-01 through AUTH-05) (completed 2026-03-08)
- [x] **Phase 17: API Security** - Global auth guard, CORS lockdown, @Public() decorator for health/version/auth endpoints (SEC-01, SEC-02) (completed 2026-03-08)
- [x] **Phase 18: API Keys** - Named read-only API keys, cryptographic generation, bank scoping, Bearer header auth (KEY-01 through KEY-05) (completed 2026-03-08)
- [x] **Phase 19: Memory Banks** - Create/list/rename/delete banks, sync-time selection, search scoping, default bank + data migration (BANK-01 through BANK-04) (completed 2026-03-09)
- [x] **Phase 20: Encryption at Rest** - AES-256-GCM for authContext + connectorCredentials, APP_SECRET key, migration script (ENC-01, ENC-02) (completed 2026-03-09)
- [x] **Phase 21: End-to-End Encryption** - Argon2id key derivation, client-side memory encryption, vectors plaintext, password change re-encryption (E2EE-01 through E2EE-04) (completed 2026-03-09)
- [x] **Phase 22: PostgreSQL Dual-Driver** - Postgres schema, pg Pool, DATABASE_URL, Docker Compose postgres service (DB-01 through DB-04) -- Complete
- [x] **Phase 23: Row Level Security** - Postgres RLS policies for user data isolation (DB-05) (completed 2026-03-09)
- [x] **Phase 24: Firebase Auth (Prod-Core)** - Firebase guard, React Firebase UI, AUTH_PROVIDER switch, social login (FBAUTH-01 through FBAUTH-04) (completed 2026-03-09)

<details>
<summary>v2.1 Data Quality & Pipeline Integrity (Phases 25-28) - SHIPPED 2026-03-09</summary>

**Milestone Goal:** Fix source type misclassification, tame entity extraction chaos, unify entity format, deduplicate entities, and backfill existing data -- so search, filtering, and the memory graph actually work correctly.

- [x] **Phase 25: Source Type Reclassification** - Fix photos connector, backfill SQLite + Qdrant, remove SOURCE_TYPE_ALIASES hack (SRC-01 through SRC-04) (completed 2026-03-08)
- [x] **Phase 26: Entity Format & Quality** - Unified entity shape, improved extraction prompt, normalizer with dedup/clean/validate, entity cap (FMT-01 through FMT-03, ENT-01 through ENT-05) (completed 2026-03-08)
- [x] **Phase 27: Data Backfill** - Re-enrich existing memories with corrected pipeline, resumable, filterable, real-time progress (BKF-01 through BKF-04) (completed 2026-03-09)
- [x] **Phase 28: Verification** - End-to-end validation that search, graph, and NLQ produce correct results (VER-01 through VER-04) (completed 2026-03-09)

</details>

<details>
<summary>v3.0 Monorepo & Developer Experience (Phases 29-33) - SHIPPED 2026-03-09</summary>

**Milestone Goal:** Transform the hacked-together monorepo into a production-grade, plug-and-play development environment.

- [x] **Phase 29: Foundation Config** - ESLint 9, Prettier, typecheck task, .env.example documentation (QUAL-01, QUAL-02, QUAL-03, DOCK-03) (completed 2026-03-08)
- [x] **Phase 30: Dev Workflow Fix** - Replace nodemon, turbo watch, proper exports, health endpoint (DEV-01, DEV-02, DEV-03, DEV-04, DOCK-04) (completed 2026-03-08)
- [x] **Phase 31: Docker & Infrastructure** - Compose profiles, Makefile, health checks on all services (DOCK-01, DOCK-02) (completed 2026-03-08)
- [x] **Phase 32: Build Optimization** - pnpm catalogs, Husky + lint-staged pre-commit/pre-push hooks (BUILD-01, QUAL-04) (completed 2026-03-08)
- [x] **Phase 33: Production Docker** - Multi-stage build with turbo prune for minimal image size (BUILD-02) (completed 2026-03-09)

</details>

<details>
<summary>v3.0.1 NestJS Best Practices (Phase 34) - SHIPPED 2026-03-09</summary>

See [v3.0.1-ROADMAP.md](milestones/v3.0.1-ROADMAP.md) for full phase details. 3 plans complete.

</details>

## v4.0 Fix Search Once and For All (Phases 35-38)

**Milestone Goal:** Validate the entire pipeline end-to-end -- sync real data from every connector, verify raw event -> embed -> enrich -> Qdrant works correctly, build file/attachment extraction, validate relationship graph, and prove search returns meaningful results with concrete search-then-verify testing.

**Phase Ordering Rationale:**

- Sync + pipeline verification first (Phase 35) because everything depends on having real data flowing correctly through the pipeline -- you cannot validate relationships or search without memories in the database
- File/attachment processing (Phase 36) is NEW functionality that must be built before search can cover attachment content -- it depends on having synced data to know what files look like
- Relationship graph validation (Phase 37) requires both memories and file/attachment links to be in place -- verifying contacts, entities, and memory links needs the complete data picture
- Search quality validation (Phase 38) comes last because it tests the entire stack -- you need correct memories, correct entities, correct contacts, correct file links, and correct Qdrant vectors before search validation is meaningful

**Summary:**

- [ ] **Phase 35: Data Sync & Pipeline Verification** - Sync all 6 connectors and verify embed/enrich pipeline produces correct memories with proper source types, embeddings, contacts, entities, factuality, and Qdrant vectors
- [ ] **Phase 36: File & Attachment Processing** - Build file/photo extraction from emails and messages as standalone memories linked to their parent
- [ ] **Phase 37: Relationship Graph Validation** - Verify contact associations, entity extraction, and memory links across all connector types
- [ ] **Phase 38: Search Quality Validation** - Test semantic, cross-connector, contact-scoped, temporal, source-filtered, and attachment search against real data

## Phase Details (v4.0)

### Phase 35: Data Sync & Pipeline Verification

**Goal**: Real data from all 6 connector types flows through the complete pipeline and produces correct, searchable memories in PostgreSQL and Qdrant
**Depends on**: Phase 34 (codebase stable, all prior milestones shipped)
**Requirements**: SYNC-01, SYNC-02, SYNC-03, SYNC-04, SYNC-05, SYNC-06, PIPE-01, PIPE-02, PIPE-03, PIPE-04, PIPE-05, PIPE-06
**Success Criteria** (what must be TRUE):

1. User can trigger sync for each of the 6 connectors (Gmail, Slack, WhatsApp, iMessage, Photos-Immich, Locations) and see raw events created in the rawEvents table with connector-appropriate payload fields
2. Every synced raw event progresses through embed -> enrich pipeline to produce a Memory with correct source_type (email/message/photo/location), valid 768d embedding, and resolved Contact records
3. Enrich processor produces entities using the canonical 10-type taxonomy and classifies factuality (FACT/UNVERIFIED/FICTION) for every memory
4. Every enriched memory is upserted to Qdrant with correct payload fields (memory_id, source_type, connector_type, event_time) and is retrievable via vector search
5. Searching for content known to exist in synced data returns relevant results (basic sanity check per connector)
   **Plans**: TBD

### Phase 36: File & Attachment Processing

**Goal**: Email attachments and message files are extracted as standalone memories with their own embeddings and linked to their parent message/email in the relationship graph
**Depends on**: Phase 35 (synced data must exist to know what attachments look like)
**Requirements**: PIPE-07, PIPE-08, PIPE-09, REL-04
**Success Criteria** (what must be TRUE):

1. Email attachments and message file shares produce standalone Memory records with source_type `file` (or `photo` for image files) separate from the parent memory
2. Photo-type attachments are processed through the vision model and have caption text extracted and stored as the memory text
3. Non-photo file attachments store metadata (filename, MIME type, size) and have meaningful text for embedding (filename + type description)
4. File/photo memories are linked to their parent memory via memoryLinks with a relationship type that indicates parent-child association
   **Plans**: TBD

### Phase 37: Relationship Graph Validation

**Goal**: The memory graph accurately represents who said what, what entities were mentioned, and how memories relate to each other across all connector types
**Depends on**: Phase 36 (file links must be in place for complete graph validation)
**Requirements**: REL-01, REL-02, REL-03
**Success Criteria** (what must be TRUE):

1. Contact associations have correct roles per connector -- Gmail emails have sender/recipient contacts, Slack messages have sender contacts, WhatsApp messages have participant contacts, iMessage messages have sender/recipient contacts
2. Entity extraction produces meaningful entities per connector type -- emails yield person/organization/date entities, messages yield person/location entities, photos yield location/date entities, locations yield location entities
3. Memory links exist for contextually related content -- email threads link replies to originals, Slack thread replies link to parent messages, WhatsApp conversation messages within a time window are linked
   **Plans**: TBD

### Phase 38: Search Quality Validation

**Goal**: Search across the full corpus of real data returns meaningful, well-ranked results for every search mode the system supports
**Depends on**: Phase 37 (complete relationship graph for contact-scoped and entity-based search)
**Requirements**: SRCH-01, SRCH-02, SRCH-03, SRCH-04, SRCH-05, SRCH-06, SRCH-07
**Success Criteria** (what must be TRUE):

1. Natural language queries return semantically relevant results across all source types, and results are properly weighted using the 5-weight formula (semantic + rerank + recency + importance + trust)
2. A single query that spans multiple connectors returns results from at least 2 different source types (cross-connector search works)
3. Searching scoped to a specific contact returns only memories associated with that person, and temporal queries ("last week", "in January") return time-bounded results
4. Source-type filtering works -- searching within "emails only", "messages only", "photos only", or "files only" returns correctly filtered results
5. Searching for content within attachments returns results -- photo captions and file metadata are searchable alongside regular memory text
   **Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 8.1 -> 9 -> 10 -> 11 -> 16 -> 17 -> 18 -> 19 -> 20 -> 21 -> 22 -> 23 -> 24 -> 25 -> 26 -> 27 -> 28 -> 29 -> 30 -> 31 -> 32 -> 33 -> 34 -> 35 -> 36 -> 37 -> 38

| Phase                            | Milestone | Plans Complete | Status      | Completed  |
| -------------------------------- | --------- | -------------- | ----------- | ---------- |
| 1. Search Quality                | v1.0      | 2/2            | Complete    | 2026-03-07 |
| 2. Operational Maturity          | v1.0      | 2/2            | Complete    | 2026-03-07 |
| 3. Extensibility                 | v1.0      | 2/2            | Complete    | 2026-03-07 |
| 4. PostHog Activation            | v1.1      | 2/2            | Complete    | 2026-03-07 |
| 5. SDK Feature Enablement        | v1.2      | 2/2            | Complete    | 2026-03-08 |
| 6. Verification and Dashboards   | v1.2      | 2/2            | Complete    | 2026-03-08 |
| 7. Test Infrastructure Fixes     | v1.3      | 2/2            | Complete    | 2026-03-08 |
| 8. Entity Type Taxonomy          | v1.4      | 2/2            | Complete    | 2026-03-08 |
| 8.1 Contact Auto-Merge           | v1.4      | 2/2            | Complete    | 2026-03-08 |
| 9. NLQ Parsing                   | v1.4      | 2/2            | Complete    | 2026-03-08 |
| 10. Source Citations             | v1.4      | 0/?            | Deferred    | -          |
| 11. Repo & Infrastructure        | v2.0      | 3/3            | Complete    | 2026-03-08 |
| 16. User Authentication          | v2.0      | 3/3            | Complete    | 2026-03-08 |
| 17. API Security                 | v2.0      | 1/1            | Complete    | 2026-03-08 |
| 18. API Keys                     | v2.0      | 2/2            | Complete    | 2026-03-08 |
| 19. Memory Banks                 | v2.0      | 3/3            | Complete    | 2026-03-09 |
| 20. Encryption at Rest           | v2.0      | 1/1            | Complete    | 2026-03-09 |
| 21. E2EE (Prod-Core)             | v2.0      | 2/2            | Complete    | 2026-03-09 |
| 22. PostgreSQL Dual-Driver       | v2.0      | 2/2            | Complete    | 2026-03-09 |
| 23. Row Level Security           | v2.0      | 3/3            | Complete    | 2026-03-09 |
| 24. Firebase Auth (Prod-Core)    | v2.0      | 2/2            | Complete    | 2026-03-09 |
| 25. Source Type Reclassification | v2.1      | 2/2            | Complete    | 2026-03-08 |
| 26. Entity Format & Quality      | v2.1      | 2/2            | Complete    | 2026-03-08 |
| 27. Data Backfill                | v2.1      | 1/1            | Complete    | 2026-03-09 |
| 28. Verification                 | v2.1      | 1/1            | Complete    | 2026-03-09 |
| 29. Foundation Config            | v3.0      | 1/1            | Complete    | 2026-03-08 |
| 30. Dev Workflow Fix             | v3.0      | 2/2            | Complete    | 2026-03-08 |
| 31. Docker & Infrastructure      | v3.0      | 1/1            | Complete    | 2026-03-08 |
| 32. Build Optimization           | v3.0      | 1/1            | Complete    | 2026-03-08 |
| 33. Production Docker            | v3.0      | 1/1            | Complete    | 2026-03-09 |
| 34. NestJS Best Practices        | v3.0.1    | 3/3            | Complete    | 2026-03-09 |
| 35. Data Sync & Pipeline         | v4.0      | 0/?            | Not started | -          |
| 36. File & Attachment Processing | v4.0      | 0/?            | Not started | -          |
| 37. Relationship Graph           | v4.0      | 0/?            | Not started | -          |
| 38. Search Quality Validation    | v4.0      | 0/?            | Not started | -          |

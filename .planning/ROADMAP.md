# Roadmap: Botmem

## Milestones

- v1.0 MVP - Phases 1-3 (shipped 2026-03-07)
- v1.1 PostHog Analytics Activation - Phase 4 (shipped 2026-03-07)
- v1.2 PostHog Deep Analytics - Phases 5-6 (shipped 2026-03-08)
- v1.3 Test Coverage - Phase 7 (shipped 2026-03-08)
- v1.4 Search Intelligence - Phases 8-10 (in progress)
- v2.0 Production Deployment & Open-Core Split - Phases 11-15 (planned)

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

## v1.4 Search Intelligence (Phases 8-10)

**Milestone Goal:** Make Botmem's search layer intelligent enough for a personal AI assistant -- parse natural language queries into structured filters, fix entity type classification for reliable filtering, and add source citations for assistant drill-down.

**Phase Ordering Rationale:**
- Entity cleanup first (Phase 8) because NLQ parsing quality depends on consistent entity types for entity-boosted search and type-filtered queries
- NLQ parsing second (Phase 9) because temporal and entity extraction from queries builds on the clean entity taxonomy, and PERF-01 constrains the implementation to deterministic parsing (no LLM in search hot path)
- Source citations and verification last (Phase 10) because citations format depends on the final search response shape from Phase 9, and LLM quality testing validates all v1.4 features end-to-end

- [x] **Phase 8: Entity Type Taxonomy** - Canonical entity types via structured output, backfill existing data, type-filtered search (completed 2026-03-08)
- [ ] **Phase 8.1: Contact Auto-Merge** (INSERTED) - Auto-merge obvious contact duplicates, eliminate manual review for exact-name non-person entities and sparse contacts
- [ ] **Phase 9: NLQ Parsing** - Temporal references via chrono-node, entity extraction from queries, intent classification, all under 500ms
- [ ] **Phase 10: Source Citations & Verification** - Citation metadata on search results, LLM quality testing of all v1.4 features

## Phase Details

### Phase 8: Entity Type Taxonomy
**Goal**: Every entity in the system has a consistent canonical type, new memories produce clean entities via structured output, and users can filter entity search by type
**Depends on**: Phase 7 (test infrastructure must be stable)
**Requirements**: ENT-01, ENT-02, ENT-03
**Success Criteria** (what must be TRUE):
  1. Running enrichment on a new memory produces entities with types from the canonical set only (person, organization, location, event, product, topic, pet, group, device, other) -- no freeform or inconsistent types
  2. Querying existing memories shows zero entities with non-canonical types (backfill has normalized all legacy data)
  3. Searching `/entities/search?q=Nugget&type=pet` returns only entities matching that type, and omitting the type parameter returns all matching entities regardless of type
**Plans**: 2 plans

Plans:
- [x] 08-01-PLAN.md -- Structured output entity extraction with canonical types (ENT-01)
- [x] 08-02-PLAN.md -- Backfill migration + type-filtered entity search (ENT-02, ENT-03)

### Phase 8.1: Contact Auto-Merge (INSERTED)
**Goal**: Obvious contact duplicates are auto-merged without manual review, reducing the merge queue by ~90% while preserving safety for ambiguous person-name matches
**Depends on**: Phase 8 (entity types must be canonical so entityType-based auto-merge rules are reliable)
**Requirements**: AUTO-MERGE-01 (new)
**Success Criteria** (what must be TRUE):
  1. Exact-name matches where BOTH contacts have entityType in (organization, product, location, event, topic) are auto-merged during suggestion generation — zero such pairs appear in manual review
  2. Exact-name matches where one contact is sparse (only has a `name` identifier, no email/phone/slack_id) are auto-merged into the richer contact — zero sparse-to-rich exact-name pairs appear in manual review
  3. Person-to-person exact-name matches with different structured identifiers still appear as suggestions for manual review (safety preserved)
  4. Auto-merge is idempotent and transaction-safe — running it multiple times produces no errors or duplicate merges
  5. Merge queue count drops significantly after running auto-merge (measured before/after)
**Plans:** 1/2 plans executed

Plans:
- [ ] 08.1-01-PLAN.md -- Contact entityType reclassification from memory entity data (AUTO-MERGE-01)
- [ ] 08.1-02-PLAN.md -- Auto-merge with safety-tiered rules + API endpoint (AUTO-MERGE-01)

### Phase 9: NLQ Parsing
**Goal**: Users can search with natural language containing temporal references, person/place names, and varying intents, and get intelligently filtered results within 500ms
**Depends on**: Phase 8 (clean entity types needed for entity-boosted search)
**Requirements**: NLQ-01, NLQ-02, NLQ-03, PERF-01
**Success Criteria** (what must be TRUE):
  1. Searching "emails from Sarah last week" returns results filtered to the correct date range and boosted for the contact named Sarah
  2. Searching "where did I go in January" returns location-type memories filtered to January of the current (or most recent) year
  3. Query intent classification distinguishes recall ("what did John say about the project"), browse ("show me recent photos"), and find ("Sarah's phone number") -- observable via the parsed query structure in API response
  4. Search with NLQ enhancements completes in under 500ms measured at the API response level -- no LLM calls occur during search request handling
**Plans**: TBD

### Phase 10: Source Citations & Verification
**Goal**: Search results carry source citation metadata suitable for AI assistant drill-down, and all v1.4 features are validated with LLM-assisted quality testing against real data
**Depends on**: Phase 9 (search response shape must be finalized)
**Requirements**: CIT-01
**Success Criteria** (what must be TRUE):
  1. Each search result includes citation metadata: memory ID, event timestamp, connector type (gmail/slack/whatsapp/etc), and participant names -- structured for assistant consumption
  2. LLM quality test confirms entity extraction produces correct types for a sample of real memories across multiple connectors
  3. LLM quality test confirms temporal query parsing returns correct date ranges for a set of natural language time expressions
**Plans**: TBD

## v2.0 Production Deployment & Open-Core Split (Phases 11-15)

**Milestone Goal:** Deploy Botmem to production on a Vultr VPS with proper infrastructure (Postgres, Firebase auth, Caddy SSL, OpenRouter inference), split the codebase into open-core (public) and prod-core (private) under a GitHub org, and wire CI/CD for automatic deployment.

- [ ] **Phase 11: Repository & Infrastructure Foundation** - GitHub org, repo split with sanitized history, VPS provisioning, DNS configuration
- [ ] **Phase 12: PostgreSQL Dual-Database** - Parallel schema file, shared database interface, conditional driver, FTS5-to-tsvector port
- [ ] **Phase 13: Inference Abstraction & Authentication** - InferenceService with Ollama/OpenRouter providers, Firebase auth with opt-in guard, React login UI
- [ ] **Phase 14: Docker Compose Production Stack** - Multi-stage Dockerfile, production compose, Caddy reverse proxy with SSL
- [ ] **Phase 15: CI/CD & Production Launch** - GitHub Actions workflows, deployment pipeline, landing page, documentation update

### Phase 11: Repository & Infrastructure Foundation
**Goal**: The GitHub org, repo structure, VPS, and DNS are all in place so that code changes in later phases have somewhere to deploy
**Depends on**: Nothing (independent of v1.x phases)
**Requirements**: REPO-01, REPO-02, REPO-03, REPO-04, DEP-01, DEP-05
**Success Criteria** (what must be TRUE):
  1. GitHub org `botmem` exists with a public `open-core` repo containing the full codebase with zero secrets in git history, and a private `prod-core` repo with deployment configs
  2. Running `git log --all -p` on the public repo and grepping for known secret patterns (OAuth client secrets, API keys, tokens) returns zero matches
  3. The Vultr VPS is reachable via SSH, has Docker and Docker Compose installed, 2GB swap configured, and firewall allows only ports 22, 80, 443
  4. Visiting `http://botmem.xyz` in a browser resolves to the Vultr VPS IP address (DNS A record propagated)
**Plans:** 1/3 plans executed

Plans:
- [ ] 11-01-PLAN.md -- Clean inline secrets and sanitize git history (REPO-04)
- [ ] 11-02-PLAN.md -- Create GitHub org, open-core and prod-core repos (REPO-01, REPO-02, REPO-03)
- [ ] 11-03-PLAN.md -- VPS configuration and DNS setup (DEP-01, DEP-05)

### Phase 12: PostgreSQL Dual-Database
**Goal**: The application can run on either SQLite or PostgreSQL with zero code changes outside of the database layer, controlled by a single environment variable
**Depends on**: Phase 11 (repos exist to push code to)
**Requirements**: DB-01, DB-02, DB-03, DB-04, DB-05
**Success Criteria** (what must be TRUE):
  1. Setting `DB_DRIVER=postgres` and providing `DATABASE_URL` starts the API against PostgreSQL with all tables, indexes, and constraints created automatically
  2. Setting `DB_DRIVER=sqlite` (or omitting it) starts the API against SQLite exactly as before -- no regressions in any existing functionality
  3. Full-text search queries return results on both database backends (FTS5 on SQLite, tsvector+GIN on PostgreSQL)
  4. The embed, enrich, and sync pipelines complete successfully on PostgreSQL with the same data that works on SQLite
**Plans**: TBD

### Phase 13: Inference Abstraction & Authentication
**Goal**: The application supports both local Ollama and cloud OpenRouter for inference, and production access is protected by Firebase authentication that degrades gracefully when unconfigured
**Depends on**: Phase 12 (database must work on Postgres before adding auth on top)
**Requirements**: INF-01, INF-02, INF-03, INF-04, INF-05, AUTH-01, AUTH-02, AUTH-03, AUTH-04, AUTH-05
**Success Criteria** (what must be TRUE):
  1. Setting `INFERENCE_PROVIDER=openrouter` with a valid API key causes all embedding, generation, and enrichment to use OpenRouter API instead of Ollama -- verified by checking no requests hit the Ollama URL
  2. Setting `INFERENCE_PROVIDER=ollama` (or omitting it) uses existing Ollama behavior with zero regressions
  3. When reranker is unavailable (OpenRouter mode), search results still return with adjusted scoring weights (rerank weight redistributed to semantic + recency) and no errors
  4. A user can register and log in via the React UI, and authenticated API requests include a valid Firebase ID token that the backend verifies
  5. When Firebase config is absent, all endpoints are accessible without authentication (open-core mode) and no Firebase-related errors appear in logs
**Plans**: TBD

### Phase 14: Docker Compose Production Stack
**Goal**: A single `docker compose up` on the VPS brings up the entire Botmem production stack with HTTPS, PostgreSQL, and all services healthy
**Depends on**: Phase 13 (all code-level changes -- DB, inference, auth -- must be complete before containerizing)
**Requirements**: DEP-02, DEP-03, DEP-04
**Success Criteria** (what must be TRUE):
  1. Running `docker compose -f docker-compose.prod.yml up -d` on the VPS starts API, PostgreSQL, Redis, Qdrant, and Caddy containers -- all report healthy within 60 seconds
  2. Visiting `https://botmem.xyz` in a browser shows the Botmem web app served over valid HTTPS (Let's Encrypt certificate, no browser warnings)
  3. The API responds to `GET /api/version` through the Caddy reverse proxy, and a full sync-embed-enrich pipeline completes successfully against production PostgreSQL
**Plans**: TBD

### Phase 15: CI/CD & Production Launch
**Goal**: Code pushed to main triggers automatic deployment, and the project is publicly documented for self-hosters and production users
**Depends on**: Phase 14 (production stack must work manually before automating deployment)
**Requirements**: CICD-01, CICD-02, CICD-03, SITE-01, SITE-02
**Success Criteria** (what must be TRUE):
  1. Pushing a commit to the open-core repo triggers a GitHub Actions workflow that lints, tests, and builds successfully
  2. Pushing a commit to prod-core main branch triggers a GitHub Actions workflow that builds, SSHs into the VPS, pulls the latest image, and runs `docker compose up` -- verified by checking the deployed version increments
  3. The landing page at botmem.xyz clearly differentiates open-core (self-host with SQLite + Ollama) from production (hosted with Postgres + OpenRouter + Firebase auth), with a features comparison
  4. Documentation includes a self-hosting guide (Docker Compose setup, env vars), auth setup guide (Firebase project creation), and OpenRouter configuration guide
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 8.1 -> 9 -> 10 -> 11 -> 12 -> 13 -> 14 -> 15

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
| 8.1 Contact Auto-Merge | 1/2 | In Progress|  | - |
| 9. NLQ Parsing | v1.4 | 0/? | Not started | - |
| 10. Source Citations & Verification | v1.4 | 0/? | Not started | - |
| 11. Repo & Infrastructure | v2.0 | 1/3 | In Progress | - |
| 12. PostgreSQL Dual-Database | v2.0 | 0/? | Not started | - |
| 13. Inference & Auth | v2.0 | 0/? | Not started | - |
| 14. Docker Production Stack | v2.0 | 0/? | Not started | - |
| 15. CI/CD & Launch | v2.0 | 0/? | Not started | - |

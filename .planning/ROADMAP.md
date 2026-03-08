# Roadmap: Botmem

## Milestones

- v1.0 MVP - Phases 1-3 (shipped 2026-03-07)
- v1.1 PostHog Analytics Activation - Phase 4 (shipped 2026-03-07)
- v1.2 PostHog Deep Analytics - Phases 5-6 (shipped 2026-03-08)
- v1.3 Test Coverage - Phases 7-10 (reserved, parallel with v2.0)
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

## v1.4 Search Intelligence (Phases 8-10)

**Milestone Goal:** Make Botmem's search layer intelligent enough for a personal AI assistant -- parse natural language queries, summarize results via LLM, and fix entity type classification.

*Phases 7-10 reserved. Managed by separate v1.4 agent. See v1.4 planning docs for details.*

## v2.0 Production Deployment & Open-Core Split

**Milestone Goal:** Deploy Botmem to production on a Vultr VPS with proper infrastructure (Postgres, Firebase auth, Caddy SSL, OpenRouter inference), split the codebase into open-core (public) and prod-core (private) under a GitHub org, and wire CI/CD for automatic deployment.

- [ ] **Phase 11: Repository & Infrastructure Foundation** - GitHub org, repo split with sanitized history, VPS provisioning, DNS configuration
- [ ] **Phase 12: PostgreSQL Dual-Database** - Parallel schema file, shared database interface, conditional driver, FTS5-to-tsvector port
- [ ] **Phase 13: Inference Abstraction & Authentication** - InferenceService with Ollama/OpenRouter providers, Firebase auth with opt-in guard, React login UI
- [ ] **Phase 14: Docker Compose Production Stack** - Multi-stage Dockerfile, production compose, Caddy reverse proxy with SSL
- [ ] **Phase 15: CI/CD & Production Launch** - GitHub Actions workflows, deployment pipeline, landing page, documentation update

## Phase Details

### Phase 11: Repository & Infrastructure Foundation
**Goal**: The GitHub org, repo structure, VPS, and DNS are all in place so that code changes in later phases have somewhere to deploy
**Depends on**: Nothing (independent of v1.x phases)
**Requirements**: REPO-01, REPO-02, REPO-03, REPO-04, DEP-01, DEP-05
**Success Criteria** (what must be TRUE):
  1. GitHub org `botmem` exists with a public `open-core` repo containing the full codebase with zero secrets in git history, and a private `prod-core` repo with deployment configs
  2. Running `git log --all -p` on the public repo and grepping for known secret patterns (OAuth client secrets, API keys, tokens) returns zero matches
  3. The Vultr VPS is reachable via SSH, has Docker and Docker Compose installed, 2GB swap configured, and firewall allows only ports 22, 80, 443
  4. Visiting `http://botmem.xyz` in a browser resolves to the Vultr VPS IP address (DNS A record propagated)
**Plans**: TBD

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
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7-10 (v1.3/v1.4) -> 11 -> 12 -> 13 -> 14 -> 15

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Search Quality | v1.0 | 2/2 | Complete | 2026-03-07 |
| 2. Operational Maturity | v1.0 | 2/2 | Complete | 2026-03-07 |
| 3. Extensibility | v1.0 | 2/2 | Complete | 2026-03-07 |
| 4. PostHog Activation | v1.1 | 2/2 | Complete | 2026-03-07 |
| 5. SDK Feature Enablement | v1.2 | 2/2 | Complete | 2026-03-08 |
| 6. Verification and Dashboards | v1.2 | 2/2 | Complete | 2026-03-08 |
| 7-10. (reserved) | v1.3/v1.4 | — | In progress | - |
| 11. Repo & Infrastructure | v2.0 | 0/? | Not started | - |
| 12. PostgreSQL Dual-Database | v2.0 | 0/? | Not started | - |
| 13. Inference & Auth | v2.0 | 0/? | Not started | - |
| 14. Docker Production Stack | v2.0 | 0/? | Not started | - |
| 15. CI/CD & Launch | v2.0 | 0/? | Not started | - |

# Requirements: Botmem

**Core Value:** Every piece of personal communication is searchable, connected, and queryable -- with factuality labeling so the user knows what's verified vs. hearsay.

## v1.4 Requirements -- Search Intelligence

**Defined:** 2026-03-08

### Entity Classification

- [x] **ENT-01**: Entity extraction uses canonical type taxonomy (person, organization, location, event, product, topic, pet, group, device, other) enforced via Ollama structured output (`format` parameter)
- [ ] **ENT-02**: All existing memories have entity types backfilled to canonical taxonomy via SQL string replacement (no LLM re-run)
- [ ] **ENT-03**: User can filter entity search by type (e.g. `/entities/search?q=Nugget&type=pet`)

### NLQ Parsing

- [ ] **NLQ-01**: User can search with temporal references ("last week", "in January", "yesterday") and get date-filtered results via chrono-node deterministic parsing
- [ ] **NLQ-02**: User can search with person/place/org names in natural language and get entity-boosted results
- [ ] **NLQ-03**: Search classifies query intent (recall/browse/find) to optimize result ranking and filtering

### Source Citations

- [ ] **CIT-01**: Search results include source citations (memory ID, timestamp, connector type, participant names) suitable for assistant drill-down

### Performance

- [ ] **PERF-01**: Search with NLQ enhancements completes in <500ms (no LLM calls in search hot path)

### v1.4 Future (deferred to v1.5)

- **SUM-01**: LLM summarization of top search results into assistant-style answer
- **SUM-02**: Async delivery of summaries via WebSocket (non-blocking search)

### v1.4 Out of Scope

| Feature | Reason |
|---------|--------|
| Conversational follow-up | Multi-turn requires session state, not v1 scope |
| Agentic multi-step search | Over-engineering for single-user system |
| Fine-tuning entity models | qwen3:0.6b + structured output sufficient |
| External NER services | Keep local-first |
| LLM calls in search hot path | Violates PERF-01 (<500ms) |

### v1.4 Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| ENT-01 | Phase 8 | Complete |
| ENT-02 | Phase 8 | Pending |
| ENT-03 | Phase 8 | Pending |
| NLQ-01 | Phase 9 | Pending |
| NLQ-02 | Phase 9 | Pending |
| NLQ-03 | Phase 9 | Pending |
| PERF-01 | Phase 9 | Pending |
| CIT-01 | Phase 10 | Pending |

**v1.4 Coverage:**
- v1.4 requirements: 8 total
- Mapped to phases: 8
- Unmapped: 0

---

## v2.0 Requirements -- Production Deployment & Open-Core Split

**Defined:** 2026-03-08

## v2.0 Requirements

Requirements for production deployment and open-core split. Each maps to roadmap phases.

### Repository & Organization

- [ ] **REPO-01**: GitHub org `botmem` is created and configured
- [ ] **REPO-02**: Open-core public repo is created with sanitized git history (no secrets)
- [ ] **REPO-03**: Prod-core private repo is created with deployment configs and business docs
- [x] **REPO-04**: Git history is sanitized to remove all credentials, API keys, and secrets before public push

### Database

- [ ] **DB-01**: PostgreSQL schema file (`schema.pg.ts`) mirrors SQLite schema with identical logical structure
- [ ] **DB-02**: Shared database interface abstracts over SQLite and PostgreSQL drivers (application code is dialect-agnostic)
- [ ] **DB-03**: Conditional DbService initializes correct driver based on environment config (`DB_DRIVER=sqlite|postgres`)
- [ ] **DB-04**: SQLite FTS5 is ported to PostgreSQL tsvector + GIN index for full-text search
- [ ] **DB-05**: All raw SQLite-specific SQL (`json_extract`, `.get()`, `.prepare()`, `PRAGMA`) is abstracted behind the shared interface

### Inference

- [ ] **INF-01**: InferenceService interface abstracts embed, generate, and rerank operations
- [ ] **INF-02**: OllamaProvider implements InferenceService using existing Ollama HTTP API
- [ ] **INF-03**: OpenRouterProvider implements InferenceService using OpenAI-compatible API (`openai` SDK)
- [ ] **INF-04**: Provider selection is controlled by environment config (`INFERENCE_PROVIDER=ollama|openrouter`)
- [ ] **INF-05**: Scoring formula redistributes weights when reranker is unavailable (rerank weight -> semantic + recency)

### Authentication

- [ ] **AUTH-01**: Firebase project is created under amroessams@gmail.com via gcloud CLI
- [ ] **AUTH-02**: NestJS guard verifies Firebase ID tokens via `firebase-admin` SDK
- [ ] **AUTH-03**: Auth guard is opt-in via `@RequireAuth()` decorator (not global -- preserves OAuth callbacks, WebSocket, CLI access)
- [ ] **AUTH-04**: Auth is disabled when Firebase config is absent (open-core runs without auth)
- [ ] **AUTH-05**: React login/register UI with Firebase client SDK

### Deployment

- [ ] **DEP-01**: $12/mo Vultr VPS (2GB RAM) is provisioned with Docker, swap (2GB), and firewall rules
- [ ] **DEP-02**: Multi-stage Dockerfile builds API + web into a single optimized image
- [ ] **DEP-03**: `docker-compose.prod.yml` orchestrates API, PostgreSQL, Redis, Qdrant, and Caddy
- [ ] **DEP-04**: Caddyfile configures reverse proxy with automatic Let's Encrypt SSL for botmem.xyz
- [ ] **DEP-05**: Spaceship DNS A record points botmem.xyz (and www) to Vultr VPS IP

### CI/CD

- [ ] **CICD-01**: GitHub Actions workflow for open-core repo: lint, test, build on push/PR
- [ ] **CICD-02**: GitHub Actions workflow for prod-core repo: lint, test, build, deploy to Vultr on push to main
- [ ] **CICD-03**: Deployment pipeline SSHs into VPS, pulls latest image, runs docker compose up

### Website & Documentation

- [ ] **SITE-01**: Landing page updated with open-core vs production differentiation (features comparison, self-host vs hosted)
- [ ] **SITE-02**: Documentation updated with deployment guide, auth setup, OpenRouter config, and self-hosting instructions

## Previous Milestones (Completed)

### v1.2 -- PostHog Deep Analytics (Complete)

- [x] REPLAY-01-03, HEAT-01-03, ERR-01-03, WEB-01-03, PROD-01-03, ID-01-02

### v1.1 -- PostHog Analytics Activation (Complete)

- [x] CFG-01-02, VER-01-05, COV-01-02

## Future Requirements

Deferred to future releases. Tracked but not in current roadmap.

### Monitoring & Operations

- **OPS-01**: Uptime monitoring and alerting (e.g., UptimeRobot, Grafana)
- **OPS-02**: Log aggregation from Docker containers
- **OPS-03**: Automated PostgreSQL backup schedule (pg_dump cron)
- **OPS-04**: Blue-green or rolling deployment strategy

### Multi-tenancy

- **MT-01**: Multiple user accounts with isolated data
- **MT-02**: Admin dashboard for user management

## Out of Scope

| Feature | Reason |
|---------|--------|
| Kubernetes / container orchestration | Single VPS is sufficient at this scale |
| Custom domain per user | Single-tenant production deployment |
| Self-hosted Firebase alternative (Supabase Auth) | Firebase free tier is sufficient, Google ecosystem integration |
| CDN / edge caching | Unnecessary for single-user production instance |
| Multi-region deployment | Single VPS, single region |
| Blue-green deployment | Overkill for solo developer; simple docker compose restart is fine for v2.0 |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| REPO-01 | Phase 11 | Pending |
| REPO-02 | Phase 11 | Pending |
| REPO-03 | Phase 11 | Pending |
| REPO-04 | Phase 11 | Complete |
| DB-01 | Phase 12 | Pending |
| DB-02 | Phase 12 | Pending |
| DB-03 | Phase 12 | Pending |
| DB-04 | Phase 12 | Pending |
| DB-05 | Phase 12 | Pending |
| INF-01 | Phase 13 | Pending |
| INF-02 | Phase 13 | Pending |
| INF-03 | Phase 13 | Pending |
| INF-04 | Phase 13 | Pending |
| INF-05 | Phase 13 | Pending |
| AUTH-01 | Phase 13 | Pending |
| AUTH-02 | Phase 13 | Pending |
| AUTH-03 | Phase 13 | Pending |
| AUTH-04 | Phase 13 | Pending |
| AUTH-05 | Phase 13 | Pending |
| DEP-01 | Phase 11 | Pending |
| DEP-02 | Phase 14 | Pending |
| DEP-03 | Phase 14 | Pending |
| DEP-04 | Phase 14 | Pending |
| DEP-05 | Phase 11 | Pending |
| CICD-01 | Phase 15 | Pending |
| CICD-02 | Phase 15 | Pending |
| CICD-03 | Phase 15 | Pending |
| SITE-01 | Phase 15 | Pending |
| SITE-02 | Phase 15 | Pending |

**Coverage:**
- v2.0 requirements: 29 total
- Mapped to phases: 29
- Unmapped: 0

---
*Requirements defined: 2026-03-08*
*Last updated: 2026-03-08 after v1.4 roadmap creation*

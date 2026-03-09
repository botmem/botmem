# Project Retrospective

_A living document updated after each milestone. Lessons feed forward into future planning._

## Milestone: v1.0 -- MVP

**Shipped:** 2026-03-07
**Phases:** 3 | **Plans:** 6 | **Sessions:** ~6

### What Was Built

- Reranker integration with qwen3-reranker filling the 0.30 weight slot
- Memory pinning with score floor and recall-count importance reinforcement
- Nightly decay job via BullMQ maintenance queue
- PostHog backend analytics service with no-op fallback
- Plugin system with lifecycle hooks and scorer integration

### What Worked

- Small, focused plans (2-5 min each) kept execution tight
- Graceful degradation patterns (reranker fallback, PostHog no-op) prevented feature flags from gating progress
- Fire-and-forget pattern for non-critical operations (hooks, analytics) avoided blocking the pipeline

### What Was Inefficient

- Plugin system scope was large for an MVP -- could have been deferred

### Patterns Established

- Score floor pattern for pinned memories
- No-op service pattern for optional external services
- Fire-and-forget hooks via `void` prefix
- BullMQ upsertJobScheduler for idempotent cron

### Key Lessons

1. Graceful degradation should be the default for all external service integrations
2. Fire-and-forget is the right pattern for observability hooks -- never block the hot path

### Cost Observations

- Sessions: ~6
- Notable: All 6 plans completed in under 30 minutes total execution time

---

## Milestone: v1.1 -- PostHog Analytics Activation

**Shipped:** 2026-03-07
**Phases:** 1 | **Plans:** 2 | **Sessions:** ~2

### What Was Built

- Configurable PostHog host with EU instance support
- Connector setup and graph interaction event tracking
- End-to-end verification script for analytics pipeline

### What Worked

- Verification script provided confidence that events were reaching PostHog without manual dashboard checks
- Small scope (1 phase, 2 plans) shipped same day as v1.0

### What Was Inefficient

- Nothing notable -- tight scope kept it clean

### Patterns Established

- Analytics events use simple string names with flat property objects
- E2E verification scripts for external service integrations

### Key Lessons

1. Ship verification tooling alongside the feature, not as a follow-up

---

## Milestone: v1.2 -- PostHog Deep Analytics

**Shipped:** 2026-03-08
**Phases:** 2 | **Plans:** 4 | **Sessions:** ~4

### What Was Built

- Session replay with input masking and network header redaction
- Backend exception filter for 5xx error capture
- User identification with person properties
- PostHog dashboards (web analytics, product metrics, funnel, retention)

### What Worked

- PostHogExceptionFilter extending BaseExceptionFilter preserved default NestJS error responses
- Dashboard creation was a pure PostHog UI task -- no code changes needed

### What Was Inefficient

- PostHogExceptionFilter had a crash bug (missing httpAdapterHost) discovered during verification -- should have been caught by the plan

### Patterns Established

- NestJS global exception filter pattern for analytics
- Network header redaction via maskCapturedNetworkRequestFn

### Key Lessons

1. NestJS global filters instantiated via app.useGlobalFilters() need explicit httpAdapterHost reference
2. Dashboard creation is a human task -- plan it as such, not as code

---

## Milestone: v1.3 -- Test Coverage

**Shipped:** 2026-03-08
**Phases:** 1 | **Plans:** 2 | **Sessions:** ~2

### What Was Built

- @vitest/coverage-v8 across all 10 workspace packages
- Fixed 77+ failing tests with zero production code changes

### What Worked

- Zero production code changes -- all fixes were test-only, proving the tests were broken, not the code
- Standardized thresholds (80/80/80/75) across all packages created a baseline

### What Was Inefficient

- 77+ test fixes in a single plan was too large -- should have been split by package

### Patterns Established

- Coverage config pattern: provider v8, reporter text+lcov, reportsDirectory ./coverage
- passWithNoTests for packages with no tests yet

### Key Lessons

1. Test maintenance debt compounds -- fix broken tests early, not in batches
2. Standardized thresholds across packages prevent drift

---

## Milestone: v1.4 -- Search Intelligence

**Shipped:** 2026-03-08
**Phases:** 4 (8, 8.1, 9, 10) | **Plans:** 8 | **Sessions:** ~8

### What Was Built

- Canonical 10-type entity taxonomy via Ollama structured output
- Contact auto-merge with safety-tiered rules
- NLQ parser with chrono-node temporal extraction and intent classification
- NLQ pipeline integration with Qdrant temporal filtering and fallback
- Phase 10 (Source Citations) deferred to backlog

### What Worked

- Pure function modules (nlq-parser, entity-normalizer) made TDD natural and testing fast
- Safety-tiered auto-merge avoided false merges while still reducing manual work
- Deferring Phase 10 was the right call -- CIT-01 had low user value

### What Was Inefficient

- Contact reclassification (08.1-01) took 11 min due to debugging threshold logic -- most complex plan in the milestone

### Patterns Established

- Pure function modules with no NestJS/DB dependencies for testability
- Structured output via Ollama format parameter for constrained generation
- Safety-tiered auto-merge (high confidence auto, ambiguous manual)
- Temporal fallback: retry without date filter when filtered search returns empty

### Key Lessons

1. Ollama structured output (JSON schema format parameter) eliminates regex-based response parsing
2. Contact dedup needs conservative thresholds -- false merges are worse than false negatives
3. NLQ parsing should be synchronous and zero-overhead -- never add latency to the search hot path

---

## Milestone: v2.1 -- Data Quality & Pipeline Integrity

**Shipped:** 2026-03-09
**Phases:** 4 (25-28) | **Plans:** 6 | **Sessions:** ~6

### What Was Built

- Photos source type corrected from 'file' to 'photo' with full backfill
- Entity normalizer pure function with canonical taxonomy and garbage stripping
- Bidirectional link dedup for memoryLinks
- Resumable backfill pipeline with WebSocket progress
- End-to-end verification of data quality

### What Worked

- Pure function normalizer made entity cleanup testable without pipeline overhead
- Resumable backfill (enrichedAt marker column) handled interruptions gracefully
- Verification phase as a formal phase (not ad-hoc testing) caught real issues

### What Was Inefficient

- Phase 22 PostgreSQL migration was discovered to be incomplete during Phase 28 verification -- three files still had SQLite JSON syntax
- Schema drift between Drizzle schema and actual DB revealed migration gaps

### Patterns Established

- Entity normalization: always run normalizeEntities() after LLM extraction
- Backfill pattern: marker column + skip-if-set for resumable bulk processing
- Bidirectional link check before creating memoryLinks

### Key Lessons

1. Verification phases are high-value -- they catch issues that unit tests miss
2. Database migrations must be tested against actual DB state, not just schema definitions
3. Backfill jobs need resumability from day one -- they will be interrupted

---

## Milestone: v3.0 -- Monorepo & Developer Experience

**Shipped:** 2026-03-09
**Phases:** 5 (29-33) | **Plans:** 6 | **Sessions:** ~6

### What Was Built

- ESLint 9 flat config + Prettier + turbo typecheck
- CJS library output with turbo watch dev
- Docker Compose with health checks and Makefile
- pnpm catalogs + Husky pre-commit/pre-push hooks
- Multi-stage Dockerfile with turbo prune

### What Worked

- Single-command dev experience (pnpm dev / make dev) eliminated onboarding friction
- pnpm catalogs reduced dependency version drift to zero
- turbo prune for Docker kept production image under 500MB

### What Was Inefficient

- CJS vs ESM resolution took iteration -- NestJS requires CJS but Vite wants ESM, resolved with conditional exports + source condition

### Patterns Established

- Library packages output CJS with 'source' export condition for Vite
- Infrastructure services in docker-compose.yml, app runs natively
- Health probe pattern: try/catch returning boolean, aggregated via Promise.allSettled

### Key Lessons

1. CJS output for library packages is the pragmatic choice when NestJS is the primary consumer
2. Health endpoints should always return 200 and report status -- never fail
3. Docker image optimization (turbo prune + multi-stage) pays for itself on every deploy

---

## Milestone: v3.0.1 -- NestJS Best Practices

**Shipped:** 2026-03-09
**Phases:** 1 (34) | **Plans:** 3 | **Sessions:** ~3

### What Was Built

- Global ValidationPipe with 18 DTO classes across all modules
- ThrottlerModule with per-route rate limits
- Structured logging via NestJS Logger (zero console.\* in production)
- Production secret validation on startup
- User ownership enforcement and proper HTTP exceptions

### What Worked

- class-validator DTOs caught real input validation gaps (missing required fields, wrong types)
- Production secret validation prevents running with default secrets

### What Was Inefficient

- 18 DTOs in a single plan was dense -- could have been split by module

### Patterns Established

- OnModuleInit for production secret validation
- ForbiddenException for user ownership checks
- NestJS Logger with ClassName.name for all services
- Drizzle db.transaction() for multi-table operations

### Key Lessons

1. Input validation should be added early, not bolted on -- DTOs prevent entire classes of bugs
2. Rate limiting auth endpoints (3-5/min) is essential -- brute force is the first attack vector
3. Structured logging with class context makes production debugging possible

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Sessions | Phases | Key Change                                  |
| --------- | -------- | ------ | ------------------------------------------- |
| v1.0      | ~6       | 3      | Established plan-based execution model      |
| v1.1      | ~2       | 1      | Same-day shipping with tight scope          |
| v1.2      | ~4       | 2      | Mixed code + human tasks (dashboards)       |
| v1.3      | ~2       | 1      | Test-only milestone (no production changes) |
| v1.4      | ~8       | 4      | Pure function modules + TDD pattern         |
| v2.1      | ~6       | 4      | Formal verification phase added             |
| v3.0      | ~6       | 5      | Infrastructure-as-code focus                |
| v3.0.1    | ~3       | 1      | Best practices hardening                    |

### Top Lessons (Verified Across Milestones)

1. Pure function modules with no DI dependencies are the most testable and reusable pattern (v1.4, v2.1)
2. Graceful degradation / no-op should be the default for all optional external services (v1.0, v1.1)
3. Verification phases catch real issues that unit tests miss (v2.1, v1.2)
4. Small, focused plans (2-5 min execution) are consistently more successful than large ones (all milestones)
5. Resumability must be designed in from day one for any batch/backfill operation (v2.1)

---

_Last updated: 2026-03-09_

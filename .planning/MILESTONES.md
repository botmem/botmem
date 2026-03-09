# Milestones

## v1.0 MVP -- shipped 2026-03-07

**Phases:** 1-3 | **Plans:** 6

### Key Accomplishments

- Reranker integration (qwen3-reranker via Ollama logprobs) filling the 0.30 weight slot in the 5-weight scoring formula
- Memory pinning with score floor and recall-count importance boost for user-prioritized memories
- Nightly decay job via BullMQ maintenance queue for automated recency recomputation
- PostHog analytics integration with backend AnalyticsService and frontend event tracking
- Plugin system with manifest-based loading, lifecycle hooks (afterIngest/afterEmbed/afterEnrich/afterSearch), and scorer plugin support

---

## v1.1 PostHog Analytics Activation -- shipped 2026-03-07

**Phases:** 4 | **Plans:** 2

### Key Accomplishments

- Configurable PostHog host via POSTHOG_HOST env var with EU instance support
- Connector setup, graph view, and graph node click event tracking coverage
- End-to-end verification of PostHog event pipeline with confirmed no-op mode (zero errors when unconfigured)

---

## v1.2 PostHog Deep Analytics -- shipped 2026-03-08

**Phases:** 5-6 | **Plans:** 4

### Key Accomplishments

- Session replay with input masking and network header redaction for privacy-safe recordings
- Backend NestJS exception filter for 5xx error capture to PostHog
- PostHog user identification with stable user ID and person properties (connectors_count, memories_count)
- "Botmem Usage" dashboard with searches/day, syncs/day, connector setup funnel, and search retention insights

---

## v1.3 Test Coverage -- shipped 2026-03-08

**Phases:** 7 | **Plans:** 2

### Key Accomplishments

- @vitest/coverage-v8 with standardized 80/80/80/75 thresholds across all 10 workspace packages
- Fixed 77+ failing tests across API, web, CLI, and connector packages with zero production code changes
- Turbo pipeline for coverage tasks with pnpm test:coverage root script

---

## v1.4 Search Intelligence -- shipped 2026-03-08

**Phases:** 8, 8.1, 9, 10 (Phase 10 deferred) | **Plans:** 8

### Key Accomplishments

- Canonical 10-type entity taxonomy enforced via Ollama structured output with JSON schema constraints
- Contact auto-merge with safety-tiered rules (non-person exact name, sparse-to-rich, person manual review)
- NLQ parser with chrono-node temporal extraction, intent classification, and source type detection
- NLQ pipeline integration with Qdrant temporal filtering, intent-based weight adjustment, and temporal fallback
- Entity type backfill migration and type-filtered entity search API + CLI

---

## v2.1 Data Quality & Pipeline Integrity -- shipped 2026-03-09

**Phases:** 25-28 | **Plans:** 6

### Key Accomplishments

- Photos connector source type corrected from 'file' to 'photo' with SQLite + Qdrant backfill
- Entity normalizer pure function with canonical 10-type taxonomy, garbage stripping, and dedup
- Bidirectional link existence check preventing duplicate memoryLinks
- Resumable backfill pipeline with enrichedAt marker column and WebSocket progress tracking
- End-to-end verification of search, graph, and NLQ data quality across all connectors

---

## v3.0 Monorepo & Developer Experience -- shipped 2026-03-09

**Phases:** 29-33 | **Plans:** 6

### Key Accomplishments

- ESLint 9 flat config + Prettier + turbo typecheck task for monorepo-wide code quality
- CJS library package output with turbo watch dev for single-command development
- Infrastructure-only docker-compose.yml with health checks, Makefile DX layer, and Ollama profile
- pnpm catalogs for centralized dependency versions + Husky pre-commit/pre-push hooks
- Multi-stage Dockerfile with turbo prune producing optimized API-only production images

---

## v3.0.1 NestJS Best Practices -- shipped 2026-03-09

**Phases:** 34 | **Plans:** 3

### Key Accomplishments

- Global ValidationPipe with 18 DTO classes and class-validator decorators across all API modules
- ThrottlerModule with 100/min default and per-route rate limits (auth: 3-5/min, AI: 20/min)
- Zero console.\* calls in production -- all logging via NestJS Logger with class context
- Production secret validation, user ownership enforcement, and proper HTTP exceptions throughout
- Drizzle db.transaction() for atomic multi-table operations

---

_Archived: 2026-03-09_
_See `.planning/milestones/` for detailed roadmap and requirements archives._

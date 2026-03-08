---
phase: 27-data-backfill
plan: 01
subsystem: api
tags: [bullmq, backfill, enrichment, ollama, encryption, websocket]

# Dependency graph
requires:
  - phase: 26-entity-normalization
    provides: Normalized entity extraction pipeline (normalizer, canonical types, dedup)
provides:
  - POST /memories/backfill-enrich endpoint for re-enrichment of historical data
  - BackfillProcessor enrich handler with decrypt/encrypt and resumability
  - enrichedAt schema column for tracking re-enriched memories
  - Frontend Re-enrich All button in MemoryExplorerPage
affects: [memory-search, entity-graph, data-quality]

# Tech tracking
tech-stack:
  added: []
  patterns: [backfill-job-pattern, resumable-processing-with-marker-column]

key-files:
  created:
    - apps/api/src/memory/dto/backfill-enrich.dto.ts
    - apps/api/src/memory/__tests__/backfill-enrich.test.ts
  modified:
    - apps/api/src/db/schema.ts
    - apps/api/src/memory/backfill.processor.ts
    - apps/api/src/memory/memory.controller.ts
    - apps/web/src/pages/MemoryExplorerPage.tsx
    - apps/web/src/lib/api.ts

key-decisions:
  - 'enrichedAt nullable column as resumability marker -- skip already-processed memories on restart'
  - 'Worker concurrency default 2 to avoid overwhelming Ollama during backfill'
  - 'BullMQ jobId set to memory ID to prevent duplicate enqueuing on resume'

patterns-established:
  - 'Backfill pattern: marker column + skip-if-set + advanceAndComplete for resumable bulk processing'

requirements-completed: [BKF-01, BKF-02, BKF-03, BKF-04]

# Metrics
duration: 6min
completed: 2026-03-08
---

# Phase 27 Plan 01: Data Backfill Summary

**Resumable backfill-enrich pipeline with decrypt/re-encrypt, connectorType filter, WebSocket progress, and frontend trigger button**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-08T20:18:19Z
- **Completed:** 2026-03-08T20:24:16Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments

- BackfillProcessor extended with backfill-enrich job handler that decrypts, enriches via EnrichService, re-encrypts, and sets enrichedAt marker
- POST /memories/backfill-enrich endpoint creates tracked job, enqueues individual BullMQ jobs per memory, broadcasts progress via WebSocket
- Resumable: restarting backfill skips already-enriched memories (enrichedAt set) while still advancing progress
- Filterable: optional connectorType parameter limits scope to specific connector's memories
- Frontend Re-enrich All button in MemoryExplorerPage with loading state and inline status message

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): Backfill enrich tests** - `3e1fceb` (test)
2. **Task 1 (GREEN): Schema + BackfillProcessor + endpoint + DTO** - `7d16746` (feat)
3. **Task 2: Frontend backfill trigger button** - `b58ef35` (feat)

_TDD task had separate test and implementation commits._

## Files Created/Modified

- `apps/api/src/db/schema.ts` - Added enrichedAt column to memories table
- `apps/api/src/memory/backfill.processor.ts` - Extended with enrich handler, DI for EnrichService/CryptoService/JobsService/EventsService/SettingsService
- `apps/api/src/memory/memory.controller.ts` - Added POST /memories/backfill-enrich endpoint with job tracking
- `apps/api/src/memory/dto/backfill-enrich.dto.ts` - Request validation DTO with optional connectorType
- `apps/api/src/memory/__tests__/backfill-enrich.test.ts` - 6 unit tests covering all behaviors
- `apps/web/src/pages/MemoryExplorerPage.tsx` - Re-enrich All button with loading/status states
- `apps/web/src/lib/api.ts` - Added backfillEnrich API method

## Decisions Made

- enrichedAt as nullable text column -- null means not yet re-enriched, ISO timestamp means done
- Worker concurrency default 2 (configurable via backfill_concurrency setting) to avoid overwhelming Ollama
- BullMQ jobId set to memory ID for idempotent enqueuing -- prevents duplicates on retry/resume
- Decrypt before enrich, re-encrypt after -- follows same pattern as EnrichProcessor

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Backfill pipeline ready for production use
- enrichedAt column will be auto-added by Drizzle push on next server start
- Can be triggered via API or frontend button

---

_Phase: 27-data-backfill_
_Completed: 2026-03-08_

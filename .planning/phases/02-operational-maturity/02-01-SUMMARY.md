---
phase: 02-operational-maturity
plan: 01
subsystem: memory
tags: [bullmq, decay, recency, scheduling, maintenance]

requires:
  - phase: 01-search-quality
    provides: computeWeights scoring formula with pinning and recall boost
provides:
  - DecayProcessor on maintenance queue for nightly recency recomputation
  - Configurable decay cron schedule via DECAY_CRON env var
  - Maintenance queue infrastructure (reusable for future maintenance jobs)
affects: [search-quality, memory-ranking]

tech-stack:
  added: []
  patterns: [maintenance-queue-processor, upsertJobScheduler-for-idempotent-cron]

key-files:
  created:
    - apps/api/src/memory/decay.processor.ts
    - apps/api/src/memory/__tests__/decay.test.ts
  modified:
    - apps/api/src/config/config.service.ts
    - apps/api/src/memory/memory.module.ts
    - apps/api/src/jobs/jobs.module.ts
    - apps/api/src/jobs/scheduler.service.ts

key-decisions:
  - "Used upsertJobScheduler (not deprecated repeat API) for idempotent cron scheduling"
  - "Decay processor preserves existing semantic/rerank scores, only recomputes recency/importance/trust/final"
  - "Default decay cron at 3:00 AM daily, configurable via DECAY_CRON env var"

patterns-established:
  - "Maintenance queue pattern: register in both jobs.module and memory.module, processor in memory.module"
  - "upsertJobScheduler for idempotent scheduled jobs (safe across restarts)"

requirements-completed: [OPS-01, OPS-02]

duration: 4min
completed: 2026-03-07
---

# Phase 2 Plan 1: Nightly Decay Job Summary

**BullMQ DecayProcessor on maintenance queue recomputes recency weights nightly in batches of 500, with pinned memory exemption and configurable 3 AM cron schedule**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-07T16:50:11Z
- **Completed:** 2026-03-07T16:54:24Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- DecayProcessor processes all memories with embeddingStatus='done' in batches of 500, recomputing recency decay (exp(-0.015 * ageDays)) while preserving semantic/rerank scores
- Pinned memories retain recency=1.0 and score floor of 0.75
- Nightly decay scheduled at 3:00 AM via upsertJobScheduler with idempotent 'nightly-decay' scheduler ID
- 5 unit tests covering recency recomputation, pinned exemption, batch processing, score preservation, and recall boost cap

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): Decay tests** - `71da4bb` (test)
2. **Task 1 (GREEN): DecayProcessor + config + queue registration** - `3f0b5c4` (feat)
3. **Task 2: Schedule decay via upsertJobScheduler** - `0d8aba8` (feat)

_Note: Task 1 used TDD with RED/GREEN commits_

## Files Created/Modified
- `apps/api/src/memory/decay.processor.ts` - BullMQ processor on maintenance queue, batch-updates recency weights
- `apps/api/src/memory/__tests__/decay.test.ts` - 5 unit tests for decay logic
- `apps/api/src/config/config.service.ts` - Added decayCron getter (env: DECAY_CRON, default: 0 3 * * *)
- `apps/api/src/memory/memory.module.ts` - Registered maintenance queue and DecayProcessor
- `apps/api/src/jobs/jobs.module.ts` - Registered maintenance queue
- `apps/api/src/jobs/scheduler.service.ts` - Added scheduleDecay() with upsertJobScheduler

## Decisions Made
- Used upsertJobScheduler (not deprecated repeat API) for idempotent cron scheduling -- safe across restarts
- Decay processor preserves existing semantic/rerank scores from weights JSON, only recomputes time-dependent fields
- Default decay cron at 3:00 AM daily, configurable via DECAY_CRON env var

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required. Decay runs automatically on existing Redis/BullMQ infrastructure.

## Next Phase Readiness
- Maintenance queue is established and reusable for future maintenance jobs
- Decay job runs nightly without manual intervention
- Ready for Phase 2 Plan 2

---
*Phase: 02-operational-maturity*
*Completed: 2026-03-07*

## Self-Check: PASSED

All 7 files verified present. All 3 commits (71da4bb, 3f0b5c4, 0d8aba8) verified in git log.

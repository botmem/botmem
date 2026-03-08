---
phase: 25-source-type-reclassification
plan: 02
subsystem: api
tags: [memory-service, nlq, source-type, cleanup]

requires:
  - phase: 25-source-type-reclassification
    provides: Corrected photos connector sourceType and backfilled historical data
provides:
  - Clean NLQ source type passthrough without alias hack
affects: [memory-search, photo-filtering]

tech-stack:
  added: []
  patterns: []

key-files:
  created: []
  modified:
    - apps/api/src/memory/memory.service.ts

key-decisions:
  - "None - followed plan as specified"

patterns-established: []

requirements-completed: [SRC-04]

duration: 1min
completed: 2026-03-08
---

# Phase 25 Plan 02: Remove SOURCE_TYPE_ALIASES Hack Summary

**Removed photo->file alias workaround from memory service now that DB contains correct 'photo' source type**

## Performance

- **Duration:** 1 min
- **Started:** 2026-03-08T15:39:11Z
- **Completed:** 2026-03-08T15:40:00Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- Removed SOURCE_TYPE_ALIASES constant and alias lookup from memory.service.ts
- NLQ sourceTypeHint now passes through directly to effectiveFilters.sourceType
- All NLQ parser tests pass confirming 'photo' sourceTypeHint works correctly

## Task Commits

Each task was committed atomically:

1. **Task 1: Remove SOURCE_TYPE_ALIASES hack from memory.service.ts** - `c10ca97` (fix)

## Files Created/Modified
- `apps/api/src/memory/memory.service.ts` - Removed SOURCE_TYPE_ALIASES constant and simplified NLQ source type hint passthrough

## Decisions Made
None - followed plan as specified.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 25 (source type reclassification) is fully complete
- Photo queries now use native 'photo' source type end-to-end: NLQ parser -> memory service -> Qdrant/SQLite

---
*Phase: 25-source-type-reclassification*
*Completed: 2026-03-08*

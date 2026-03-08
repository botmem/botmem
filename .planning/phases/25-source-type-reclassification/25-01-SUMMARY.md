---
phase: 25-source-type-reclassification
plan: 01
subsystem: api
tags: [qdrant, sqlite, migration, connector, photos-immich]

requires:
  - phase: none
    provides: n/a
provides:
  - Corrected photos connector sourceType emission ('photo' not 'file')
  - QdrantService.setPayload() method for batch payload updates
  - Standalone migration script for backfilling source_type in SQLite + Qdrant
affects: [memory-search, photo-filtering, qdrant]

tech-stack:
  added: []
  patterns: [standalone migration scripts with better-sqlite3 + QdrantClient]

key-files:
  created:
    - apps/api/src/migrations/backfill-source-types.ts
  modified:
    - packages/connectors/photos-immich/src/index.ts
    - packages/connectors/photos-immich/src/__tests__/immich.test.ts
    - apps/api/src/memory/qdrant.service.ts

key-decisions:
  - "Wrap migration in main() function instead of top-level await for tsx CJS compatibility"

patterns-established:
  - "Migration scripts use main().catch() pattern for CJS compatibility with tsx"

requirements-completed: [SRC-01, SRC-02, SRC-03]

duration: 3min
completed: 2026-03-08
---

# Phase 25 Plan 01: Source Type Reclassification Summary

**Photos connector fixed to emit 'photo' sourceType with backfill migration for SQLite + Qdrant historical data**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-08T15:34:04Z
- **Completed:** 2026-03-08T15:37:00Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- Photos-immich connector now emits `sourceType: 'photo'` instead of `'file'`
- QdrantService gains `setPayload()` method for batch payload updates without touching vectors
- Standalone migration script corrects all existing photo memories in SQLite (memories + raw_events) and Qdrant

## Task Commits

Each task was committed atomically:

1. **Task 1: Fix connector emit and update test assertion** - `acea9c1` (fix)
2. **Task 2: Create backfill migration script and QdrantService.setPayload method** - `a6364a2` (feat)

## Files Created/Modified
- `packages/connectors/photos-immich/src/index.ts` - Changed sourceType from 'file' to 'photo'
- `packages/connectors/photos-immich/src/__tests__/immich.test.ts` - Updated assertion to expect 'photo'
- `apps/api/src/memory/qdrant.service.ts` - Added setPayload() method
- `apps/api/src/migrations/backfill-source-types.ts` - New migration script for source type backfill

## Decisions Made
- Used `main().catch()` pattern instead of top-level await for tsx CJS compatibility (tsx transpiles to CJS by default, which doesn't support top-level await)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Top-level await incompatible with tsx CJS output**
- **Found during:** Task 2 (migration script verification)
- **Issue:** `tsx` transpiles to CJS by default, which doesn't support top-level await
- **Fix:** Wrapped async Qdrant call in `main()` function with `.catch()` error handler
- **Files modified:** apps/api/src/migrations/backfill-source-types.ts
- **Verification:** Script runs successfully with 0 changes on empty dataset
- **Committed in:** a6364a2 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Minor structural change for runtime compatibility. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviation above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 02 (search/filter integration) can proceed -- it depends on the sourceType fix delivered here
- Migration script ready to run on any environment: `npx tsx apps/api/src/migrations/backfill-source-types.ts`

---
*Phase: 25-source-type-reclassification*
*Completed: 2026-03-08*

---
phase: 01-search-quality
plan: 02
subsystem: api
tags: [pinning, recall-boost, importance-reinforcement, scoring, sqlite]

requires:
  - phase: 01-01
    provides: "computeWeights with 5-weight formula and reranker integration"
provides:
  - "Memory pinning with score floor 0.75 and recency exemption"
  - "Recall count tracking with capped importance boost (+0.2 max)"
  - "POST/DELETE :id/pin and POST :id/recall API endpoints"
  - "Frontend pin toggle on MemoryCard and MemoryDetailPanel"
  - "pinned and recallCount columns on memories table"
affects: [02-operational-maturity]

tech-stack:
  added: []
  patterns: ["score floor for pinned memories", "capped recall boost (0.02 per recall, max 0.2)", "fire-and-forget recall tracking on card click"]

key-files:
  created:
    - "apps/api/src/memory/__tests__/scoring.test.ts"
  modified:
    - "apps/api/src/db/schema.ts"
    - "apps/api/src/memory/memory.controller.ts"
    - "apps/api/src/memory/memory.service.ts"
    - "apps/web/src/lib/api.ts"
    - "apps/web/src/store/memoryStore.ts"
    - "apps/web/src/components/memory/MemoryCard.tsx"
    - "apps/web/src/components/memory/MemoryDetailPanel.tsx"
    - "packages/shared/src/types/index.ts"

key-decisions:
  - "Used ALTER TABLE ADD COLUMN for schema migration instead of drizzle-kit push (safer for existing data)"
  - "Pin toggle visible on hover for unpinned, always visible when pinned (amber highlight)"
  - "recordRecall is fire-and-forget (no await, errors caught silently) to avoid blocking UI"

patterns-established:
  - "Score floor pattern: Math.max(computed, floor) applied after full formula computation"
  - "Capped boost pattern: Math.min(count * rate, cap) for bounded importance reinforcement"

requirements-completed: [SRCH-03, SRCH-04, SRCH-05, SRCH-06]

duration: 4min
completed: 2026-03-07
---

# Phase 01 Plan 02: Pinning and Importance Reinforcement Summary

**Memory pinning with 0.75 score floor and recency exemption, plus recall-based importance boost capped at +0.2, with frontend pin toggle on search cards and detail panel**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-07T16:22:56Z
- **Completed:** 2026-03-07T16:27:05Z
- **Tasks:** 2
- **Files modified:** 9 (1 created, 8 modified)

## Accomplishments
- Pinned memories get a score floor of 0.75 and are exempt from recency decay (recency=1.0)
- Recall count tracking increments on every search result click, boosting importance by 0.02 per recall up to +0.2
- Three new API endpoints: POST :id/pin, DELETE :id/pin, POST :id/recall
- Frontend pin toggle button on MemoryCard (hover-visible, always-on when pinned) and MemoryDetailPanel header
- 5 unit tests covering all scoring edge cases (pin floor, recency exemption, recall boost, cap, baseline)

## Task Commits

Each task was committed atomically:

1. **Task 1: Schema columns, API endpoints, and scoring logic with tests** - `293d67e` (feat, TDD)
2. **Task 2: Frontend pin toggle and recall tracking** - `85218ee` (feat)

## Files Created/Modified
- `apps/api/src/db/schema.ts` - Added pinned (integer) and recallCount (integer) columns to memories table
- `apps/api/src/memory/memory.controller.ts` - Added POST :id/pin, DELETE :id/pin, POST :id/recall endpoints
- `apps/api/src/memory/memory.service.ts` - Updated computeWeights with pin floor, recency exemption, and recall boost; added pinned to SearchResult
- `apps/api/src/memory/__tests__/scoring.test.ts` - 5 unit tests for scoring behavior
- `apps/web/src/lib/api.ts` - Added pinMemory, unpinMemory, recordRecall API methods
- `apps/web/src/store/memoryStore.ts` - Added pinMemory, unpinMemory, recordRecall store actions; mapped pinned field
- `apps/web/src/components/memory/MemoryCard.tsx` - Pin toggle button with hover visibility, recordRecall on click
- `apps/web/src/components/memory/MemoryDetailPanel.tsx` - Pin toggle in header, pinned status indicator
- `packages/shared/src/types/index.ts` - Added optional pinned field to Memory interface

## Decisions Made
- Used raw SQL ALTER TABLE ADD COLUMN instead of drizzle-kit push to safely add columns to the 10K+ row memories table
- Pin toggle uses amber color scheme (bg-amber-400) to visually distinguish pinned memories
- recordRecall is fire-and-forget to avoid blocking the UI on every card click
- Pinned field included in SearchResult API response so frontend can render pin state without extra queries

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- drizzle-kit push with --force failed due to FOREIGN KEY constraint (it tried to recreate the table). Solved by using direct ALTER TABLE ADD COLUMN SQL statements instead.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 1 (Search Quality) is complete with both plans done
- Reranker integration (01-01) + pinning and recall (01-02) provide all scoring improvements
- Ready for Phase 2 (Operational Maturity) which depends on pinned and recallCount columns

---
*Phase: 01-search-quality*
*Completed: 2026-03-07*

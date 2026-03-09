---
phase: 19-memory-banks
plan: 02
subsystem: database, ui
tags: [postgres, qdrant, migration, boolean-fix, memory-banks]

requires:
  - phase: 22-postgres-migration
    provides: PostgreSQL database with memory_banks table
provides:
  - Idempotent data migration script for existing memories, accounts, contacts, Qdrant vectors
  - Fixed isDefault boolean handling in frontend (Postgres boolean vs SQLite integer)
affects: [19-memory-banks]

tech-stack:
  added: []
  patterns: [main().catch() migration scripts with pg Pool]

key-files:
  created:
    - apps/api/scripts/migrate-banks.ts
  modified:
    - apps/web/src/store/memoryBankStore.ts
    - apps/web/src/lib/api.ts
    - apps/web/src/components/layout/Sidebar.tsx
    - apps/web/src/components/settings/MemoryBanksTab.tsx

key-decisions:
  - 'Qdrant bulk update uses REST API directly (no NestJS DI in standalone scripts)'
  - 'isDefault typed as boolean throughout frontend (Postgres returns true/false, not 1/0)'

patterns-established:
  - 'Migration scripts: main().catch() pattern with pg Pool for tsx CJS compatibility'

requirements-completed: [BANK-01, BANK-04]

duration: 2min
completed: 2026-03-09
---

# Phase 19 Plan 02: Data Migration & Boolean Fix Summary

**Idempotent migration script for existing data to default memory bank, plus frontend isDefault boolean fix for Postgres compatibility**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-09T07:06:05Z
- **Completed:** 2026-03-09T07:08:30Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments

- Created idempotent migration script that assigns null-ownership data to the first user and default bank
- Qdrant vectors with null memory_bank_id get bulk-updated via REST API
- Fixed isDefault type from number to boolean across all frontend files (store, api, sidebar, settings)

## Task Commits

Each task was committed atomically:

1. **Task 1: Create data migration script** - `6a61577` (feat)
2. **Task 2: Fix isDefault boolean type in frontend** - `26d012f` (fix)

## Files Created/Modified

- `apps/api/scripts/migrate-banks.ts` - Standalone migration script for existing data
- `apps/web/src/store/memoryBankStore.ts` - MemoryBank type: isDefault number -> boolean
- `apps/web/src/lib/api.ts` - API response types: isDefault number -> boolean
- `apps/web/src/components/layout/Sidebar.tsx` - Default badge check: === 1 -> === true
- `apps/web/src/components/settings/MemoryBanksTab.tsx` - Default badge and delete button checks fixed

## Decisions Made

- Qdrant bulk update uses fetch() with REST API directly since migration scripts run outside NestJS DI
- isDefault typed as boolean throughout frontend to match Postgres boolean column type

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- `apps/api/scripts/` directory was in .gitignore; used `git add -f` to force-add the migration script

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Existing data can be migrated with `DATABASE_URL=... npx tsx apps/api/scripts/migrate-banks.ts`
- Frontend correctly renders default bank badges with Postgres booleans

---

_Phase: 19-memory-banks_
_Completed: 2026-03-09_

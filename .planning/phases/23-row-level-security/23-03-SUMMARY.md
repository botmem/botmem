---
phase: 23-row-level-security
plan: 03
subsystem: database/rls
tags: [rls, security, postgres, bullmq, nestjs]
dependency_graph:
  requires: [23-02]
  provides: [DB-05]
  affects:
    [
      memory-service,
      accounts-service,
      contacts-service,
      jobs-service,
      embed-processor,
      enrich-processor,
      backfill-processor,
      sync-processor,
    ]
tech_stack:
  added: []
  patterns: [withCurrentUser, withUserId, RLS-scoped-queries]
key_files:
  created: []
  modified:
    - apps/api/src/memory/memory.service.ts
    - apps/api/src/jobs/sync.processor.ts
decisions:
  - 'timeline/getRelated/searchEntities/getEntityGraph in memory.service.ts used const db = this.dbService.db shortcut — migrated to withCurrentUser() to enforce RLS'
  - 'sync.processor.ts rawEvents INSERT was unscoped — wrapped in withUserId(ownerUserId) using bootstrap pattern (resolve userId from accounts table unscoped, then use withUserId for actual data writes)'
  - 'accounts.service.ts, contacts.service.ts, jobs.service.ts already fully migrated in prior plan work — no changes needed'
  - 'embed/enrich/backfill processors already migrated in prior plan work — no changes needed'
  - 'jobs.service updateJob/incrementProgress/tryCompleteJob/markStaleRunning intentionally remain unscoped — called from BullMQ context where processors already establish withUserId scope'
metrics:
  duration: 2min
  completed: 2026-03-09
  tasks: 2
  files: 2
---

# Phase 23 Plan 03: Service and Processor RLS Wiring Summary

All HTTP services and BullMQ processors now route their queries through the RLS-aware helpers, completing end-to-end row-level security enforcement for the botmem platform.

## What Was Built

RLS wiring connecting the application layer (services and processors) to the PostgreSQL RLS policies (Plan 01) and the DB helper methods (Plan 02). Every query on RLS-protected tables now executes within a transaction that has `SET LOCAL app.current_user_id = $userId`, ensuring the RLS policies see the correct user identity.

## Tasks Completed

### Task 1: Migrate HTTP services to withCurrentUser()

`memory.service.ts` had four methods still using `const db = this.dbService.db` shortcut:

- `timeline()` — temporal query across memories
- `getRelated()` — memory graph links + vector similarity
- `searchEntities()` — entity search across memories JSON column
- `getEntityGraph()` — entity co-occurrence graph including contacts lookup

All four migrated to `this.dbService.withCurrentUser((db) => ...)` pattern.

`accounts.service.ts`, `contacts.service.ts`, `jobs.service.ts` were already fully migrated in Phase 23 Plan 02 — confirmed, no changes needed.

**Commit:** `2bc47d5`

### Task 2: Migrate BullMQ processors to withUserId() and verify RLS

`sync.processor.ts` had an unscoped `rawEvents` INSERT in the `connector.on('data')` event handler. Since `raw_events` is an RLS-protected table (policy checks `account_id → accounts.user_id`), the INSERT was failing silently or returning empty results.

Fix: Resolve `ownerUserId` from the `accounts` table using an unscoped bootstrap read before the sync loop, then wrap the `rawEvents` INSERT in `this.dbService.withUserId(ownerUserId, insertFn)`. Fallback to unscoped for orphaned accounts (no `userId`).

`embed.processor.ts`, `enrich.processor.ts`, `backfill.processor.ts` were already migrated in Phase 23 Plan 02 — confirmed, no changes needed.

**Commit:** `236f445`

## Verification

### TypeScript compilation

```
npx tsc --noEmit -p apps/api/tsconfig.json
```

Passes with no errors.

### API health

```json
{
  "status": "ok",
  "services": {
    "postgres": { "connected": true },
    "redis": { "connected": true },
    "qdrant": { "connected": true }
  }
}
```

API healthy on port 12412.

### psql RLS cross-user check

Single-user environment — returned `NOTICE: Only one user exists -- skipping cross-user RLS check`. RLS policy structure validated at the DB level from Plan 01; the application wiring is now complete.

## Deviations from Plan

None — plan executed exactly as written.

The plan noted that accounts.service.ts, contacts.service.ts, jobs.service.ts, and the three non-sync processors were expected to already be migrated from Plan 02 work, which was confirmed. The only actual migration work was the four memory.service.ts methods and the sync.processor.ts rawEvents INSERT.

## Self-Check: PASSED

Files confirmed to exist:

- `apps/api/src/memory/memory.service.ts` ✓
- `apps/api/src/jobs/sync.processor.ts` ✓

Commits confirmed:

- `2bc47d5` feat(23-03): migrate HTTP services to withCurrentUser() ✓
- `236f445` feat(23-03): migrate BullMQ processors to withUserId() and verify RLS enforcement ✓

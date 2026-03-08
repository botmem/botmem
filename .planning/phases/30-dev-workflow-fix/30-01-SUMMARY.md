---
phase: 30-dev-workflow-fix
plan: 01
subsystem: infra
tags: [turbo, swc, nest-cli, cjs, esm, monorepo, dev-workflow]

requires: []
provides:
  - CJS library package output compatible with NestJS require() and Vite import
  - turbo watch dev single-command dev workflow with dependency ordering
  - SWC-backed nest build --watch for fast incremental API rebuilds
affects: [all-packages, dev-workflow, ci-build]

tech-stack:
  added: []
  patterns:
    - "Library packages output CJS via module:CommonJS override in tsconfig"
    - "Vite resolves workspace source via 'source' export condition"
    - "turbo watch dev with dependsOn: [^dev] for dependency-ordered dev"

key-files:
  created: []
  modified:
    - packages/shared/package.json
    - packages/shared/tsconfig.json
    - packages/connector-sdk/package.json
    - packages/connector-sdk/tsconfig.json
    - packages/cli/package.json
    - packages/cli/tsconfig.json
    - packages/connectors/*/package.json
    - packages/connectors/*/tsconfig.json
    - apps/api/package.json
    - apps/api/nest-cli.json
    - apps/web/package.json
    - apps/web/vite.config.ts
    - turbo.json
    - package.json

key-decisions:
  - "CJS output for all library packages -- module:CommonJS + moduleResolution:node overrides base ESNext config"
  - "Vite source condition -- shared package exports 'source' field pointing to TS source, Vite resolves it for dev builds"
  - "SWC builder in nest-cli.json -- faster incremental rebuilds than tsc"
  - "Web dev script renamed to dev:standalone -- prevents turbo from starting a conflicting standalone Vite server"

patterns-established:
  - "Library tsconfigs override module to CommonJS and moduleResolution to node"
  - "Library package.json has no type:module field (CJS by default)"
  - "New connectors with a dev script are auto-discovered by turbo watch -- zero root config changes needed"

requirements-completed: [DEV-01, DEV-02, DEV-03, DEV-04]

duration: 5min
completed: 2026-03-08
---

# Phase 30 Plan 01: Dev Workflow Fix Summary

**CJS library output with turbo watch dev and SWC-backed nest build --watch for single-command monorepo dev**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-08T17:43:42Z
- **Completed:** 2026-03-08T17:48:18Z
- **Tasks:** 2
- **Files modified:** 27

## Accomplishments
- All 9 library packages now output CJS (module.exports) instead of ESM -- compatible with NestJS require() calls
- Replaced nodemon with nest build --watch (SWC-backed) for fast incremental API rebuilds
- Single-command `pnpm dev` using turbo watch with dependency-ordered execution
- Web dev script removed from turbo (renamed to dev:standalone) -- no more port conflicts with embedded Vite

## Task Commits

Each task was committed atomically:

1. **Task 1: Fix library package exports and tsconfigs for CJS output** - `2c47a3d` (fix)
2. **Task 2: Replace nodemon with nest build --watch, switch to turbo watch** - `f2e9307` (feat)

## Files Created/Modified
- `packages/*/package.json` - Removed type:module, added explicit CJS exports with source condition
- `packages/*/tsconfig.json` - Added module:CommonJS + moduleResolution:node overrides
- `apps/api/package.json` - Switched dev to nest build --watch, removed nodemon/detect-port deps
- `apps/api/nest-cli.json` - Added SWC builder for fast compilation
- `apps/api/nodemon.json` - Deleted
- `apps/web/package.json` - Renamed dev to dev:standalone
- `apps/web/vite.config.ts` - Added resolve.conditions: ['source'] for workspace source resolution
- `turbo.json` - Added dependsOn: [^dev] to dev task
- `package.json` - Switched to turbo watch dev

## Decisions Made
- Added moduleResolution:node override alongside module:CommonJS -- required because base tsconfig's bundler moduleResolution is incompatible with CommonJS module setting
- Added "source" export condition to shared package and configured Vite resolve.conditions -- Vite/Rollup cannot statically analyze CJS re-exports, so resolving to TypeScript source directly is the cleanest approach
- Removed detect-port from API dependencies -- unused in source code, was dead dependency

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added moduleResolution:node to all library tsconfigs**
- **Found during:** Task 1 (CJS output fix)
- **Issue:** Setting module:CommonJS conflicted with base tsconfig's moduleResolution:bundler (TS5095 error)
- **Fix:** Added moduleResolution:node override alongside module:CommonJS in all 9 library tsconfigs
- **Files modified:** All packages/*/tsconfig.json and packages/connectors/*/tsconfig.json
- **Verification:** pnpm build succeeds with all 12 tasks
- **Committed in:** 2c47a3d (Task 1 commit)

**2. [Rule 3 - Blocking] Added Vite source condition for shared package resolution**
- **Found during:** Task 1 (CJS output fix)
- **Issue:** Vite/Rollup could not resolve named exports from CJS re-export pattern in shared/dist/index.js
- **Fix:** Added "source" export condition to shared package.json, configured resolve.conditions in Vite config
- **Files modified:** packages/shared/package.json, apps/web/vite.config.ts
- **Verification:** pnpm build succeeds including web build
- **Committed in:** 2c47a3d (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (2 blocking)
**Impact on plan:** Both auto-fixes necessary to unblock build. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Dev workflow is fully configured for single-command `pnpm dev`
- All library packages build to CJS, compatible with both API (require) and web (Vite source resolution)
- New connectors auto-discovered by turbo watch -- zero config changes needed

---
*Phase: 30-dev-workflow-fix*
*Completed: 2026-03-08*

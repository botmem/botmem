---
phase: 07-test-infrastructure-fixes
plan: 01
subsystem: testing
tags: [vitest, coverage, v8, lcov, turbo, monorepo]

requires: []
provides:
  - "@vitest/coverage-v8 installed as root devDependency"
  - "Standardized 80/80/80/75 thresholds across all 10 workspace vitest configs"
  - "pnpm test:coverage root script triggering turbo pipeline"
  - "packages/cli/vitest.config.ts (new file)"
affects: [07-test-infrastructure-fixes]

tech-stack:
  added: ["@vitest/coverage-v8@^3.2.4"]
  patterns: ["Unified coverage thresholds across monorepo", "Turbo pipeline for coverage tasks"]

key-files:
  created:
    - packages/cli/vitest.config.ts
  modified:
    - package.json
    - turbo.json
    - .gitignore
    - apps/api/vitest.config.ts
    - apps/web/vitest.config.ts
    - packages/shared/vitest.config.ts
    - packages/connector-sdk/vitest.config.ts
    - packages/connectors/gmail/vitest.config.ts
    - packages/connectors/slack/vitest.config.ts
    - packages/connectors/whatsapp/vitest.config.ts
    - packages/connectors/imessage/vitest.config.ts
    - packages/connectors/photos-immich/vitest.config.ts
    - packages/cli/package.json

key-decisions:
  - "Used @vitest/coverage-v8@^3 to match existing vitest@^3 peer dependency"
  - "Standardized all thresholds to 80/80/80/75 (statements/lines/functions/branches)"

patterns-established:
  - "Coverage config pattern: provider v8, reporter text+lcov, reportsDirectory ./coverage"
  - "All workspace packages must have test:coverage script for turbo pipeline"

requirements-completed: [INFRA-01, INFRA-02, INFRA-03, INFRA-04]

duration: 5min
completed: 2026-03-08
---

# Phase 7 Plan 1: Install Coverage Tooling Summary

**@vitest/coverage-v8 installed with standardized 80/80/80/75 thresholds and turbo test:coverage pipeline across all 10 workspace packages**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-07T22:49:30Z
- **Completed:** 2026-03-07T22:55:22Z
- **Tasks:** 4
- **Files modified:** 14

## Accomplishments
- Installed @vitest/coverage-v8@^3.2.4 as root devDependency compatible with vitest 3.x
- Standardized all 10 workspace vitest configs to identical coverage thresholds (80/80/80/75)
- Added text + lcov reporters to all configs for terminal and CI output
- Created packages/cli/vitest.config.ts (was missing)
- Added test:coverage scripts to all 11 package.json files and turbo pipeline
- Verified pnpm test:coverage runs and produces coverage output

## Task Commits

Each task was committed atomically:

1. **Task 1: Install coverage-v8 and update .gitignore** - `56e67d6` (chore)
2. **Task 2: Standardize all vitest configs** - `f341bf4` (chore)
3. **Task 3: Add test:coverage scripts** - `6719d29` (chore)
4. **Task 4: Verify coverage runs** - `13704aa` (chore)

## Files Created/Modified
- `package.json` - Added @vitest/coverage-v8 devDependency and test:coverage script
- `turbo.json` - Added test:coverage task to turbo pipeline
- `.gitignore` - Added *.lcov pattern
- `packages/cli/vitest.config.ts` - New file with standardized coverage config
- `packages/cli/package.json` - Added test and test:coverage scripts
- `apps/api/vitest.config.ts` - Added reporter and reportsDirectory
- `apps/web/vitest.config.ts` - Added reporter and reportsDirectory
- `packages/shared/vitest.config.ts` - Updated thresholds from 90/85/90/90 to 80/80/80/75
- `packages/connector-sdk/vitest.config.ts` - Updated thresholds from 85/80/85/85 to 80/80/80/75
- `packages/connectors/*/vitest.config.ts` - Updated thresholds from 75/70/75/75 to 80/80/80/75

## Decisions Made
- Used @vitest/coverage-v8@^3 (not ^4) to match existing vitest@^3 peer dependency
- Standardized all thresholds to 80/80/80/75 as specified in plan

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added test:coverage task to turbo.json**
- **Found during:** Task 4 (verification)
- **Issue:** turbo test:coverage failed with "Missing tasks in project" because turbo.json had no test:coverage task definition
- **Fix:** Added test:coverage task to turbo.json with ^build dependency and coverage/** outputs
- **Files modified:** turbo.json
- **Verification:** pnpm test:coverage runs successfully after fix
- **Committed in:** 13704aa (Task 4 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Essential fix for turbo pipeline to recognize the new task. No scope creep.

## Issues Encountered
None beyond the turbo.json deviation above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Coverage tooling is installed and configured across all packages
- Ready for 07-02 (test fixes) to improve actual coverage percentages
- Current coverage will fail thresholds (expected) until tests are fixed/added

## Self-Check: PASSED

All 4 key files verified present. All 4 task commits verified in git log.

---
*Phase: 07-test-infrastructure-fixes*
*Completed: 2026-03-08*

---
phase: 02-operational-maturity
plan: 02
subsystem: analytics
tags: [posthog, analytics, event-tracking, observability]

# Dependency graph
requires:
  - phase: 01-search-quality
    provides: search and pin functionality to instrument
provides:
  - Backend AnalyticsService wrapping posthog-node with no-op fallback
  - Frontend trackEvent() helper for client-side event capture
  - Event capture in search, pin/unpin, sync complete, and sync error flows
affects: [03-expansion]

# Tech tracking
tech-stack:
  added: [posthog-node]
  patterns: [global-module-pattern, no-op-when-unconfigured]

key-files:
  created:
    - apps/api/src/analytics/analytics.service.ts
    - apps/api/src/analytics/analytics.module.ts
    - apps/api/src/analytics/__tests__/analytics.test.ts
  modified:
    - apps/api/src/config/config.service.ts
    - apps/api/src/app.module.ts
    - apps/api/src/jobs/sync.processor.ts
    - apps/web/src/lib/posthog.ts
    - apps/web/src/store/memoryStore.ts

key-decisions:
  - "AnalyticsModule is @Global() so all modules can inject without explicit imports"
  - "distinctId='server' for all backend events to avoid PII"
  - "PostHog client uses us.i.posthog.com host"

patterns-established:
  - "No-op service pattern: service gracefully degrades when external service is unconfigured"
  - "Analytics events use generic identifiers, never PII"

requirements-completed: [OPS-03, OPS-04, OPS-05]

# Metrics
duration: 4min
completed: 2026-03-07
---

# Phase 02 Plan 02: Analytics Integration Summary

**PostHog analytics with server-side AnalyticsService (posthog-node) and frontend trackEvent helper, no-op when POSTHOG_API_KEY is absent**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-07T16:50:04Z
- **Completed:** 2026-03-07T16:54:33Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments
- Backend AnalyticsService wraps posthog-node with conditional client initialization
- Frontend trackEvent() helper captures search, pin/unpin events
- SyncProcessor captures sync_complete and sync_error events with timing data
- System runs without errors when PostHog API key is absent (no-op behavior)
- 5 unit tests covering all analytics service behavior

## Task Commits

Each task was committed atomically:

1. **Task 1: AnalyticsService, AnalyticsModule, ConfigService getter, and tests** - `35d0c0d` (feat, TDD)
2. **Task 2: Frontend trackEvent helper and backend/frontend event capture calls** - `7b2a2d3` (feat)

## Files Created/Modified
- `apps/api/src/analytics/analytics.service.ts` - PostHog wrapper with no-op when unconfigured
- `apps/api/src/analytics/analytics.module.ts` - Global NestJS module exporting AnalyticsService
- `apps/api/src/analytics/__tests__/analytics.test.ts` - 5 unit tests for analytics service
- `apps/api/src/config/config.service.ts` - Added posthogApiKey getter
- `apps/api/src/app.module.ts` - Added AnalyticsModule import
- `apps/api/src/jobs/sync.processor.ts` - sync_complete and sync_error event capture
- `apps/web/src/lib/posthog.ts` - Added trackEvent() export
- `apps/web/src/store/memoryStore.ts` - trackEvent calls in search/pin/unpin handlers

## Decisions Made
- AnalyticsModule is @Global() so all modules can inject AnalyticsService without explicit imports
- distinctId='server' for all backend events to avoid PII in analytics
- PostHog client configured with us.i.posthog.com host

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

To enable PostHog analytics, set the `POSTHOG_API_KEY` environment variable on the backend and `VITE_POSTHOG_API_KEY` on the frontend. System works without them (no-op mode).

## Next Phase Readiness
- Analytics infrastructure in place for all future features to instrument
- No blockers

---
*Phase: 02-operational-maturity*
*Completed: 2026-03-07*

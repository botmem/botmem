---
phase: 05-sdk-feature-enablement
plan: 02
subsystem: analytics
tags: [posthog, identify, person-properties, user-tracking]

requires:
  - phase: 05-sdk-feature-enablement
    provides: PostHog SDK init with session replay, autocapture, heatmaps, error tracking
provides:
  - PostHog user identification with stable user ID
  - Person properties (connectors_count, memories_count) for segmentation
affects: [06-dashboard-configuration]

tech-stack:
  added: []
  patterns: [PostHog identify call gated inside AuthGuard, /api/me fetch for user identity resolution]

key-files:
  created: []
  modified:
    - apps/web/src/lib/posthog.ts
    - apps/web/src/App.tsx

key-decisions:
  - "User ID priority: email > contactId > 'botmem-user' fallback for stable session linking"
  - "PostHogIdentifier placed inside AuthGuard to only fire for authenticated users"

patterns-established:
  - "identifyUser wrapper: guards against missing API key before calling posthog.identify"
  - "PostHogIdentifier component: silent-fail fetch pattern for analytics (never blocks app)"

requirements-completed: [ID-01, ID-02]

duration: 1min
completed: 2026-03-08
---

# Phase 5 Plan 2: User Identification Summary

**PostHog user identification via /api/me with connectors_count and memories_count person properties for user-level segmentation**

## Performance

- **Duration:** 1 min
- **Started:** 2026-03-07T22:13:31Z
- **Completed:** 2026-03-07T22:14:12Z
- **Tasks:** 1
- **Files modified:** 2

## Accomplishments
- Added identifyUser helper to posthog.ts wrapping posthog.identify with API key guard
- Created PostHogIdentifier component that fetches /api/me and calls identify with stable user ID
- Set connectors_count and memories_count as person properties for segmentation
- Placed identifier inside AuthGuard so it only fires for authenticated sessions

## Task Commits

Each task was committed atomically:

1. **Task 1: Add identifyUser helper to posthog.ts and call it from App.tsx on mount** - `bbb176a` (feat)

## Files Created/Modified
- `apps/web/src/lib/posthog.ts` - Added identifyUser function wrapping posthog.identify with API key guard
- `apps/web/src/App.tsx` - Added PostHogIdentifier component, placed inside AuthGuard layout route

## Decisions Made
- User ID priority: email > contactId > 'botmem-user' fallback -- ensures stable session linking even if email is missing
- PostHogIdentifier placed inside AuthGuard subtree so identify only fires for authenticated users

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - PostHog identification activates automatically when the API key is configured.

## Next Phase Readiness
- User identification complete, ready for Phase 6 dashboard configuration
- Person properties will begin populating in PostHog immediately for segmentation

---
*Phase: 05-sdk-feature-enablement*
*Completed: 2026-03-08*

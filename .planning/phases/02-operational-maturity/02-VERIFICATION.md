---
phase: 02-operational-maturity
verified: 2026-03-07T17:10:00Z
status: passed
score: 8/8 must-haves verified
re_verification: false
---

# Phase 2: Operational Maturity Verification Report

**Phase Goal:** The system maintains accurate scores over time through automated decay, and usage is tracked via PostHog so search and sync patterns are observable
**Verified:** 2026-03-07T17:10:00Z
**Status:** passed
**Re-verification:** No -- initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Old unpinned memories have their recency weight decrease over time automatically | VERIFIED | `decay.processor.ts:46` computes `Math.exp(-0.015 * ageDays)` for non-pinned memories; scheduled nightly via `scheduler.service.ts:28` |
| 2 | Pinned memories retain recency=1.0 and are exempt from decay | VERIFIED | `decay.processor.ts:46` checks `isPinned ? 1.0 : ...`; line 69 enforces `Math.max(final, 0.75)` floor |
| 3 | Decay job processes memories in batches without blocking embed/enrich/sync | VERIFIED | `decay.processor.ts:9` uses `BATCH_SIZE = 500`, runs on separate `maintenance` queue (not sync/embed/enrich) |
| 4 | Decay job runs on a nightly schedule via BullMQ job scheduler | VERIFIED | `scheduler.service.ts:28-32` calls `upsertJobScheduler('nightly-decay', { pattern: this.config.decayCron })`, default `0 3 * * *` |
| 5 | PostHog dashboard shows search, sync, and pin events when API key is configured | VERIFIED | Backend: `sync.processor.ts:181,203` captures sync_complete/sync_error. Frontend: `memoryStore.ts:107,118,132` calls trackEvent for search/pin/unpin |
| 6 | System runs normally with no errors when PostHog API key is absent | VERIFIED | `analytics.service.ts:11` only creates client if apiKey is truthy; `capture()` uses optional chaining `this.client?.capture(...)`. Test confirms no-op behavior |
| 7 | Backend emits server-side events for sync completions and errors | VERIFIED | `sync.processor.ts:181` captures `sync_complete` with connector_type, duration_ms, item_count; line 203 captures `sync_error` |
| 8 | Frontend tracks search queries, pin/unpin actions, and sync triggers | VERIFIED | `memoryStore.ts:107` tracks search with query_length/result_count/fallback; lines 118,132 track pin/unpin |

**Score:** 8/8 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/api/src/memory/decay.processor.ts` | BullMQ processor on maintenance queue (min 60 lines) | VERIFIED | 95 lines, substantive batch processing with scoring formula |
| `apps/api/src/memory/__tests__/decay.test.ts` | Unit tests for decay logic (min 40 lines) | VERIFIED | 154 lines, 5 tests covering recency, pinning, batches, score preservation, recall cap |
| `apps/api/src/config/config.service.ts` | decayCron + posthogApiKey config getters | VERIFIED | Lines 53-59, both getters present with env var fallbacks |
| `apps/api/src/analytics/analytics.service.ts` | PostHog wrapper with no-op (min 20 lines) | VERIFIED | 23 lines, conditional client init, capture with distinctId='server' |
| `apps/api/src/analytics/analytics.module.ts` | NestJS module exporting AnalyticsService (min 8 lines) | VERIFIED | 9 lines, @Global() decorator, exports AnalyticsService |
| `apps/api/src/analytics/__tests__/analytics.test.ts` | Unit tests for analytics service (min 30 lines) | VERIFIED | 61 lines, 5 tests covering no-op, capture, shutdown behavior |
| `apps/web/src/lib/posthog.ts` | trackEvent helper function | VERIFIED | Line 14, exports `trackEvent(event, properties)` |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `scheduler.service.ts` | maintenance queue | `upsertJobScheduler('nightly-decay', ...)` | WIRED | Lines 28-32, injects `@InjectQueue('maintenance')` at line 17 |
| `decay.processor.ts` | memories table | batch SELECT + UPDATE with offset | WIRED | Lines 31-36 SELECT with limit/offset, lines 73-76 UPDATE by id |
| `memory.module.ts` | maintenance queue | `BullModule.registerQueue` | WIRED | Line 34: `registerQueue({ name: 'maintenance' })`, line 45: DecayProcessor in providers |
| `jobs.module.ts` | maintenance queue | `BullModule.registerQueue` | WIRED | Line 36: `registerQueue({ name: 'maintenance' })` |
| `analytics.service.ts` | posthog-node | conditional PostHog client init | WIRED | Line 12: `new PostHog(apiKey, ...)` |
| `sync.processor.ts` | analytics.service.ts | `this.analytics.capture('sync_complete')` | WIRED | Import at line 16, injection at line 32, capture at lines 181, 203 |
| `memoryStore.ts` | posthog.ts | trackEvent calls in search/pin handlers | WIRED | Import at line 4, calls at lines 107, 118, 132 |
| `app.module.ts` | analytics.module.ts | AnalyticsModule import | WIRED | Import at line 18, registered at line 34 |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| OPS-01 | 02-01 | Nightly decay job recomputes recency scores via BullMQ job scheduler | SATISFIED | DecayProcessor on maintenance queue, scheduled via upsertJobScheduler |
| OPS-02 | 02-01 | Decay job processes memories in batches of 500-1000 | SATISFIED | BATCH_SIZE=500 constant, offset-based pagination in while loop |
| OPS-03 | 02-02 | PostHog analytics tracks key user events (search, sync, pin) | SATISFIED | trackEvent calls in memoryStore (search, pin, unpin) + sync.processor (sync_complete, sync_error) |
| OPS-04 | 02-02 | PostHog integration is no-op when API key is not configured | SATISFIED | Conditional client creation + optional chaining, tested in analytics.test.ts |
| OPS-05 | 02-02 | Backend emits server-side analytics events for sync completions and errors | SATISFIED | sync.processor.ts captures sync_complete (line 181) and sync_error (line 203) |

No orphaned requirements found.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| None | - | - | - | No anti-patterns detected |

No TODOs, FIXMEs, placeholders, or empty implementations found in any phase 2 artifacts.

### Human Verification Required

### 1. Decay Job Execution

**Test:** Wait until 3:00 AM (or temporarily set DECAY_CRON to `* * * * *`) and check BullMQ dashboard or logs for completed maintenance/decay job
**Expected:** Job completes, memories table shows updated weights with recency values less than 1.0 for old unpinned memories
**Why human:** Requires running system with Redis + BullMQ and waiting for scheduled execution

### 2. PostHog Event Delivery

**Test:** Set POSTHOG_API_KEY and VITE_POSTHOG_API_KEY, perform searches and trigger a sync, then check PostHog dashboard
**Expected:** Events appear in PostHog: search (with query_length, result_count), memory_pin, sync_complete, sync_error
**Why human:** Requires PostHog account and API key to verify end-to-end delivery

### Gaps Summary

No gaps found. All 8 observable truths verified, all 7 artifacts pass three-level verification (exists, substantive, wired), all 8 key links confirmed wired, all 5 requirements (OPS-01 through OPS-05) satisfied. All 5 commits verified in git log.

---

_Verified: 2026-03-07T17:10:00Z_
_Verifier: Claude (gsd-verifier)_

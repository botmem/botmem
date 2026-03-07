# Phase 2: Operational Maturity - Context

**Gathered:** 2026-03-07
**Status:** Ready for planning

<domain>
## Phase Boundary

Add nightly decay job that recomputes recency scores for all memories, and integrate PostHog analytics for tracking search, sync, and pin events. The decay job ensures old unpinned memories naturally rank lower over time. PostHog provides observability into usage patterns. No new UI pages; no new connectors.

</domain>

<decisions>
## Implementation Decisions

### Nightly decay job
- Use BullMQ job scheduler for the nightly decay job — the existing `SchedulerService` already manages repeatable jobs on the sync queue
- Use `upsertJobScheduler()` instead of the deprecated `repeat` API (BullMQ v5.16.0+ deprecation flagged in Phase 1 research)
- Decay job runs on its own queue (e.g., `maintenance`) separate from sync/embed/enrich to avoid contention
- Process memories in batches of 500-1000 to avoid SQLite writer contention (WAL mode handles concurrent reads but single writer)
- Recency formula: `exp(-0.015 * age_days)` — same as used in `computeWeights()` at search time
- Decay job updates the `weights` JSON column in the memories table so stale weights are refreshed
- Pinned memories are exempt from decay (recency stays at 1.0) — consistent with Phase 1 implementation
- Job runs at 3:00 AM local time by default — configurable via env var
- If job fails mid-batch, it should resume from where it left off on next run (idempotent)

### PostHog analytics integration
- Use PostHog cloud free tier (1M events/month) — self-hosting rejected as disproportionate (16GB RAM requirement)
- Frontend: `posthog-js` already installed and initialized (from prior work) — just needs event tracking calls added
- Backend: Add `posthog-node` package for server-side event tracking (sync completions, errors, job metrics)
- PostHog integration is no-op when API key is not configured — safe for dev without PostHog
- Frontend events to track: search (query + result count), pin/unpin, sync trigger, page views (already done)
- Backend events to track: sync completion (connector type, duration, item count), sync error, enrich completion, decay job completion
- No PII in events — use anonymous distinct IDs, no email/name in event properties
- `POSTHOG_API_KEY` env var for backend (separate from `VITE_POSTHOG_API_KEY` for frontend)

### Claude's Discretion
- Exact event names and property schemas for PostHog events
- Whether to create a shared analytics service or inline posthog calls
- Batch size tuning for decay job (500 vs 1000)
- Whether decay job should also refresh the Qdrant payload metadata
- Error retry strategy for failed PostHog event sends

</decisions>

<specifics>
## Specific Ideas

- Phase 1 flagged: BullMQ `repeat` API deprecated since v5.16.0 — use `upsertJobScheduler()` for the decay job
- Phase 1 flagged: existing `weights` JSON column stores stale weights from ingest time — decay job should refresh these
- The existing `SchedulerService` uses the deprecated `repeat` API for sync scheduling — decay job should use the new API, and optionally migrate sync scheduling too
- STATE.md decision: "PostHog cloud free tier, not self-hosted (16GB RAM requirement disproportionate)"

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `SchedulerService` (`apps/api/src/jobs/scheduler.service.ts`): Manages repeatable BullMQ jobs — pattern to follow for decay job
- `posthog-js` client (`apps/web/src/lib/posthog.ts`): Already initialized with no-op when key missing — just add `posthog.capture()` calls
- `PostHogPageviewTracker` (`apps/web/src/App.tsx`): Already tracks pageviews on route change
- `computeWeights()` in `MemoryService`: Contains the recency formula — decay job should use the same formula

### Established Patterns
- BullMQ queues: sync, embed, enrich, backfill — each has a dedicated processor class
- Queue registration in `jobs.module.ts` and `memory.module.ts` via `BullModule.registerQueue()`
- Processors extend `WorkerHost` and implement `process()` method
- Config via `ConfigService` with env var defaults

### Integration Points
- `jobs.module.ts`: Register new `maintenance` queue
- `SchedulerService`: Add decay job scheduling alongside sync scheduling
- `ConfigService`: Add `posthogApiKey` and `decayCron` config getters
- `apps/web/src/lib/posthog.ts`: Add `trackEvent()` wrapper for custom events
- Frontend components: Add `posthog.capture()` calls in search, pin, sync handlers

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 02-operational-maturity*
*Context gathered: 2026-03-07*

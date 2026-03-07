# Phase 4: PostHog Analytics Activation - Context

**Gathered:** 2026-03-07
**Status:** Ready for planning

<domain>
## Phase Boundary

Configure PostHog cloud with real API keys, verify all existing event streams flow end-to-end (pageviews, search, pin/unpin, sync_complete, sync_error), add two missing tracking events (connector setup, graph view interactions), and confirm the system is a clean no-op when keys are removed. No new UI pages, no new connectors, no new analytics dashboards.

</domain>

<decisions>
## Implementation Decisions

### Connector setup tracking (COV-01)
- Fire `connector_setup` event on OAuth callback success (when credentials are stored)
- For non-OAuth connectors (iMessage, Immich — local tools), fire on first successful sync completion
- Event fires on the backend via `AnalyticsService.capture()`
- Properties: `{ connector: '<type>', auth_type: 'oauth2' | 'qr-code' | 'api-key' | 'local-tool' }`

### Graph view tracking (COV-02)
- Track two events: `graph_view` (when user opens the graph) and `graph_node_click` (when user clicks a node)
- `graph_view` properties: `{ node_count: <number>, link_count: <number> }`
- `graph_node_click` properties: `{ node_type: 'memory' | 'contact' }`
- Frontend only — no backend summary needed
- Uses existing `trackEvent()` helper from `apps/web/src/lib/posthog.ts`

### Verification approach (VER-01 through VER-05)
- Verify events reach PostHog via manual dashboard check (PostHog Live Events view)
- Use /agent-browser to walk through each event and capture proof from PostHog dashboard
- No-op verification (VER-05): remove both API keys, exercise all features (navigate, search, pin, sync), confirm zero errors in browser console and server logs
- PostHog cloud project will be created as part of this phase's execution (user doesn't have one yet)

### PostHog project setup (CFG-01, CFG-02)
- Create PostHog cloud project during execution
- Set `VITE_POSTHOG_API_KEY` and `POSTHOG_API_KEY` environment variables with real keys
- `VITE_POSTHOG_HOST` and backend host already default to `https://us.i.posthog.com`
- Backend host is currently hardcoded in `AnalyticsService` — should be made configurable via `POSTHOG_HOST` env var (CFG-02)

### Claude's Discretion
- Exact event name casing and naming convention (snake_case consistent with existing events)
- Where in the OAuth callback flow to insert the tracking call
- How to detect "first sync" for local-tool connectors (vs subsequent syncs)
- Whether to add `.env.example` entries for the PostHog keys

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `AnalyticsService` (`apps/api/src/analytics/analytics.service.ts`): Backend PostHog client, `capture()` method, no-op when key missing
- `trackEvent()` (`apps/web/src/lib/posthog.ts`): Frontend wrapper around `posthog.capture()`, no-op when key missing
- `PostHogPageviewTracker` (`apps/web/src/App.tsx`): Already captures `$pageview` on route change
- `memoryStore` (`apps/web/src/store/memoryStore.ts`): Already captures `search` and `memory_pin` events
- `SyncProcessor` (`apps/api/src/jobs/sync.processor.ts`): Already captures `sync_complete` and `sync_error`

### Established Patterns
- Frontend events use `trackEvent(name, props)` from `lib/posthog.ts`
- Backend events use `this.analytics.capture(name, props)` with `distinctId: 'server'`
- Config via `ConfigService` with env var fallbacks
- `AnalyticsModule` is `@Global()` — injectable without explicit imports

### Integration Points
- OAuth callback handler in `apps/api/src/auth/` — insert `connector_setup` event after credential storage
- `SyncProcessor` — insert first-sync detection for local-tool connector_setup
- `MemoryGraph` component (`apps/web/src/components/memory/MemoryGraph.tsx`) — add `graph_view` and `graph_node_click` events
- `ConfigService` — add `posthogHost` getter for backend host configurability

</code_context>

<specifics>
## Specific Ideas

- Verification should use /agent-browser to produce a recording/proof of events appearing in PostHog dashboard
- PostHog cloud project needs to be created as part of execution — the API keys don't exist yet
- Existing code already handles the no-op case well (guard clauses on missing key) — verification just needs to confirm no regressions

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 04-posthog-analytics-activation*
*Context gathered: 2026-03-07*

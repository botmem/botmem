# Requirements: Botmem v1.1 — PostHog Analytics Activation

**Defined:** 2026-03-07
**Core Value:** Every piece of personal communication is searchable, connected, and queryable — with factuality labeling so the user knows what's verified vs. hearsay.

## v1.1 Requirements

Requirements for this milestone. Each maps to roadmap phases.

### Configuration

- [ ] **CFG-01**: PostHog cloud API keys are configured in environment variables for both frontend (VITE_POSTHOG_API_KEY) and backend (POSTHOG_API_KEY)
- [ ] **CFG-02**: PostHog host URL is configurable via VITE_POSTHOG_HOST (frontend) and POSTHOG_HOST (backend), defaulting to PostHog cloud (https://us.i.posthog.com)

### Verification

- [ ] **VER-01**: Frontend pageview events appear in PostHog dashboard when navigating between pages
- [ ] **VER-02**: Frontend search events appear in PostHog with query_length, result_count, and fallback properties
- [ ] **VER-03**: Frontend pin/unpin events appear in PostHog with action property
- [ ] **VER-04**: Backend sync_complete and sync_error events appear in PostHog with connector metadata
- [ ] **VER-05**: All tracking is confirmed no-op when API keys are removed (no errors, no network calls)

### Coverage

- [ ] **COV-01**: Connector setup/OAuth completion is tracked as an event (connector_setup with connector type)
- [ ] **COV-02**: Graph view interactions are tracked (graph_view with node/link counts)

## v2 Requirements

Deferred to future milestone. Tracked but not in current roadmap.

### Advanced Analytics

- **AADV-01**: Custom PostHog dashboards with saved insights for key metrics
- **AADV-02**: Feature flag integration for A/B testing search algorithms
- **AADV-03**: Session recording for UX debugging

## Out of Scope

| Feature | Reason |
|---------|--------|
| PostHog self-hosting | 16GB RAM + ClickHouse/Kafka disproportionate for single-user |
| User identification / PII | Single-user system, anonymous tracking sufficient |
| Revenue/billing tracking | No monetization in v1 |
| Cohort analysis | Single-user, no cohorts to analyze |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| CFG-01 | Phase 4 | Pending |
| CFG-02 | Phase 4 | Pending |
| VER-01 | Phase 4 | Pending |
| VER-02 | Phase 4 | Pending |
| VER-03 | Phase 4 | Pending |
| VER-04 | Phase 4 | Pending |
| VER-05 | Phase 4 | Pending |
| COV-01 | Phase 4 | Pending |
| COV-02 | Phase 4 | Pending |

**Coverage:**
- v1.1 requirements: 9 total
- Mapped to phases: 9
- Unmapped: 0

---
*Requirements defined: 2026-03-07*
*Last updated: 2026-03-07 after roadmap creation*

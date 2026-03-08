# Requirements: Botmem v1.2 — PostHog Deep Analytics

**Defined:** 2026-03-08
**Core Value:** Every piece of personal communication is searchable, connected, and queryable — with factuality labeling so the user knows what's verified vs. hearsay.

## v1.2 Requirements

Requirements for this milestone. Each maps to roadmap phases.

### Session Replay

- [x] **REPLAY-01**: PostHog session replay is enabled with privacy-safe defaults (mask all text inputs, mask sensitive CSS selectors for auth tokens/keys)
- [x] **REPLAY-02**: Session recordings appear in PostHog Replay tab and can be played back
- [x] **REPLAY-03**: Network request recording is enabled for API call debugging (with auth headers masked)

### Heatmaps

- [x] **HEAT-01**: PostHog autocapture is configured to collect click and scroll data
- [x] **HEAT-02**: Heatmap data is viewable in PostHog toolbar overlay on Botmem pages
- [x] **HEAT-03**: Rageclicks (rapid repeated clicks) are captured as distinct events

### Error Tracking

- [x] **ERR-01**: Frontend JavaScript exceptions are automatically captured and sent to PostHog
- [x] **ERR-02**: Errors appear in PostHog Error Tracking view with stack traces
- [x] **ERR-03**: Backend unhandled exceptions are captured and sent to PostHog as server-side errors

### Web Analytics

- [x] **WEB-01**: PostHog web analytics dashboard shows page views, unique visitors, and session counts
- [x] **WEB-02**: Navigation paths between pages are trackable in PostHog
- [x] **WEB-03**: UTM parameters and referrer data are captured when present

### Product Analytics

- [x] **PROD-01**: A PostHog dashboard exists with saved insights for key Botmem metrics (searches/day, syncs/day, memories created)
- [x] **PROD-02**: A funnel insight tracks the connector setup flow: visit connectors → start auth → complete sync
- [x] **PROD-03**: A retention insight measures how often the user returns to search memories

### User Identity

- [x] **ID-01**: PostHog identify() is called with a stable user identifier so sessions are linked across page reloads
- [x] **ID-02**: User properties (connectors_count, memories_count) are set as person properties in PostHog for segmentation

## Previous Milestones (Completed)

### v1.1 — PostHog Analytics Activation (Complete)

- [x] **CFG-01**: PostHog cloud API keys configured
- [x] **CFG-02**: PostHog host URL configurable
- [x] **VER-01–05**: All event types verified end-to-end
- [x] **COV-01–02**: connector_setup and graph tracking events added

## Out of Scope

| Feature | Reason |
|---------|--------|
| PostHog self-hosting | 16GB RAM + ClickHouse/Kafka disproportionate for single-user |
| Feature flags / A/B testing | No user base to split-test against yet |
| Surveys | Single-user, no survey audience |
| LLM analytics | Not using PostHog's LLM observability features |
| Revenue tracking | No monetization |
| Cohort analysis | Single-user system |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| REPLAY-01 | Phase 5 | Complete |
| REPLAY-02 | Phase 6 | Complete |
| REPLAY-03 | Phase 5 | Complete |
| HEAT-01 | Phase 5 | Complete |
| HEAT-02 | Phase 6 | Complete |
| HEAT-03 | Phase 5 | Complete |
| ERR-01 | Phase 5 | Complete |
| ERR-02 | Phase 6 | Complete |
| ERR-03 | Phase 5 | Complete |
| WEB-01 | Phase 6 | Complete |
| WEB-02 | Phase 6 | Complete |
| WEB-03 | Phase 5 | Complete |
| PROD-01 | Phase 6 | Complete |
| PROD-02 | Phase 6 | Complete |
| PROD-03 | Phase 6 | Complete |
| ID-01 | Phase 5 | Complete |
| ID-02 | Phase 5 | Complete |

**Coverage:**
- v1.2 requirements: 17 total
- Mapped to phases: 17
- Unmapped: 0

---
*Requirements defined: 2026-03-08*
*Last updated: 2026-03-08 after roadmap creation*

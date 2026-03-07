# Requirements: Botmem v1.2 — PostHog Deep Analytics

**Defined:** 2026-03-08
**Core Value:** Every piece of personal communication is searchable, connected, and queryable — with factuality labeling so the user knows what's verified vs. hearsay.

## v1.2 Requirements

Requirements for this milestone. Each maps to roadmap phases.

### Session Replay

- [ ] **REPLAY-01**: PostHog session replay is enabled with privacy-safe defaults (mask all text inputs, mask sensitive CSS selectors for auth tokens/keys)
- [ ] **REPLAY-02**: Session recordings appear in PostHog Replay tab and can be played back
- [ ] **REPLAY-03**: Network request recording is enabled for API call debugging (with auth headers masked)

### Heatmaps

- [ ] **HEAT-01**: PostHog autocapture is configured to collect click and scroll data
- [ ] **HEAT-02**: Heatmap data is viewable in PostHog toolbar overlay on Botmem pages
- [ ] **HEAT-03**: Rageclicks (rapid repeated clicks) are captured as distinct events

### Error Tracking

- [ ] **ERR-01**: Frontend JavaScript exceptions are automatically captured and sent to PostHog
- [ ] **ERR-02**: Errors appear in PostHog Error Tracking view with stack traces
- [ ] **ERR-03**: Backend unhandled exceptions are captured and sent to PostHog as server-side errors

### Web Analytics

- [ ] **WEB-01**: PostHog web analytics dashboard shows page views, unique visitors, and session counts
- [ ] **WEB-02**: Navigation paths between pages are trackable in PostHog
- [ ] **WEB-03**: UTM parameters and referrer data are captured when present

### Product Analytics

- [ ] **PROD-01**: A PostHog dashboard exists with saved insights for key Botmem metrics (searches/day, syncs/day, memories created)
- [ ] **PROD-02**: A funnel insight tracks the connector setup flow: visit connectors → start auth → complete sync
- [ ] **PROD-03**: A retention insight measures how often the user returns to search memories

### User Identity

- [ ] **ID-01**: PostHog identify() is called with a stable user identifier so sessions are linked across page reloads
- [ ] **ID-02**: User properties (connectors_count, memories_count) are set as person properties in PostHog for segmentation

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
| REPLAY-01 | — | Pending |
| REPLAY-02 | — | Pending |
| REPLAY-03 | — | Pending |
| HEAT-01 | — | Pending |
| HEAT-02 | — | Pending |
| HEAT-03 | — | Pending |
| ERR-01 | — | Pending |
| ERR-02 | — | Pending |
| ERR-03 | — | Pending |
| WEB-01 | — | Pending |
| WEB-02 | — | Pending |
| WEB-03 | — | Pending |
| PROD-01 | — | Pending |
| PROD-02 | — | Pending |
| PROD-03 | — | Pending |
| ID-01 | — | Pending |
| ID-02 | — | Pending |

**Coverage:**
- v1.2 requirements: 17 total
- Mapped to phases: 0
- Unmapped: 17 ⚠️

---
*Requirements defined: 2026-03-08*
*Last updated: 2026-03-08 after initial definition*

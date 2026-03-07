# Roadmap: Botmem

## Milestones

- **v1.0 MVP** - Phases 1-3 (shipped 2026-03-07)
- **v1.1 PostHog Analytics Activation** - Phase 4 (in progress)

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

<details>
<summary>v1.0 MVP (Phases 1-3) - SHIPPED 2026-03-07</summary>

### Phase 1: Search Quality
**Goal**: Users get meaningfully ranked search results where frequently-accessed and pinned memories surface reliably, and the reranker fills the empty 0.30 weight slot in the scoring formula
**Depends on**: Nothing (first phase)
**Requirements**: SRCH-01, SRCH-02, SRCH-03, SRCH-04, SRCH-05, SRCH-06
**Success Criteria** (what must be TRUE):
  1. Search results are visibly reranked -- querying the same term returns different ordering than before, with more contextually relevant results at the top
  2. User can pin a memory from the UI, and that memory consistently appears in relevant searches regardless of age
  3. Viewing a search result multiple times causes it to rank higher in future searches for similar queries
  4. Reranking completes within 3 seconds for a typical search (no perceptible freeze)
**Plans**: 2 plans

Plans:
- [x] 01-01: Reranker integration (SRCH-01, SRCH-02)
- [x] 01-02: Pinning and importance reinforcement (SRCH-03, SRCH-04, SRCH-05, SRCH-06)

### Phase 2: Operational Maturity
**Goal**: The system maintains accurate scores over time through automated decay, and usage is tracked via PostHog so search and sync patterns are observable
**Depends on**: Phase 1 (decay job needs recallCount and pinned columns from Phase 1; analytics needs improved search to measure)
**Requirements**: OPS-01, OPS-02, OPS-03, OPS-04, OPS-05
**Success Criteria** (what must be TRUE):
  1. Old unpinned memories naturally rank lower over time without manual intervention
  2. PostHog dashboard shows search, sync, and pin events when API key is configured
  3. System runs normally with no errors when PostHog API key is absent
  4. Decay job runs nightly without blocking normal API operations
**Plans**: 2 plans

Plans:
- [x] 02-01: Nightly decay job (OPS-01, OPS-02)
- [x] 02-02: PostHog analytics integration (OPS-03, OPS-04, OPS-05)

### Phase 3: Extensibility
**Goal**: Users can drop plugin files into the plugins directory to add custom connectors, scorers, or lifecycle hooks without modifying core code
**Depends on**: Phase 2 (stable system before opening extension points)
**Requirements**: EXT-01, EXT-02, EXT-03, EXT-04
**Success Criteria** (what must be TRUE):
  1. A sample enricher plugin in the plugins directory runs automatically during the enrich pipeline
  2. Lifecycle hooks fire at documented points (afterIngest, afterEmbed, afterEnrich, afterSearch) and plugin code can observe memory events
  3. Plugin interface is documented with working example that a developer can copy and modify
**Plans**: 2 plans

Plans:
- [x] 03-01: Plugin registry and loading infrastructure (EXT-01, EXT-03)
- [x] 03-02: Hook wiring, scorer integration, and sample plugin (EXT-02, EXT-04)

</details>

### v1.1 PostHog Analytics Activation (In Progress)

**Milestone Goal:** Configure PostHog cloud with real API keys, verify events flow end-to-end across frontend and backend, and fill tracking coverage gaps so product usage is fully observable.

- [ ] **Phase 4: PostHog Analytics Activation** - Configure keys, verify event flow end-to-end, add missing tracking events

## Phase Details

### Phase 4: PostHog Analytics Activation
**Goal**: PostHog receives real analytics events from both frontend and backend, with comprehensive product tracking across all key user actions
**Depends on**: Phase 3 (PostHog SDK integration exists from v1.0 Phase 2)
**Requirements**: CFG-01, CFG-02, VER-01, VER-02, VER-03, VER-04, VER-05, COV-01, COV-02
**Success Criteria** (what must be TRUE):
  1. PostHog dashboard shows pageview events when user navigates between pages in the web app
  2. PostHog dashboard shows search, pin/unpin, sync_complete, and sync_error events with correct properties (query_length, result_count, connector type, action)
  3. Connector setup completions and graph view interactions appear as tracked events in PostHog with appropriate metadata
  4. Removing API keys from environment variables causes zero errors and zero network calls to PostHog
**Plans**: 2 plans

Plans:
- [ ] 04-01-PLAN.md -- Config + coverage gaps (CFG-02, COV-01, COV-02)
- [ ] 04-02-PLAN.md -- API key setup + end-to-end verification (CFG-01, VER-01, VER-02, VER-03, VER-04, VER-05)

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Search Quality | v1.0 | 2/2 | Complete | 2026-03-07 |
| 2. Operational Maturity | v1.0 | 2/2 | Complete | 2026-03-07 |
| 3. Extensibility | v1.0 | 2/2 | Complete | 2026-03-07 |
| 4. PostHog Analytics Activation | 1/2 | In Progress|  | - |

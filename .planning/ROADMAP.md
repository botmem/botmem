# Roadmap: Botmem Extensions

## Overview

This milestone extends Botmem beyond its working core (6 connectors, full pipeline, graph visualization) into three areas: better search ranking via reranker integration and importance tracking, operational maturity with analytics and scheduled maintenance jobs, and a plugin system that opens the platform to custom enrichers and scorers. Phases follow dependency order -- search improvements first (highest user impact, fills empty rerank weight), then analytics to measure effectiveness, then extensibility once the system is stable.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

- [x] **Phase 1: Search Quality** - Reranker scoring, importance reinforcement, and memory pinning
- [ ] **Phase 2: Operational Maturity** - PostHog analytics and nightly decay job
- [ ] **Phase 3: Extensibility** - Plugin system with connector, scorer, and lifecycle hook types

## Phase Details

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
**Plans**: TBD

Plans:
- [ ] 02-01: Nightly decay job (OPS-01, OPS-02)
- [ ] 02-02: PostHog analytics integration (OPS-03, OPS-04, OPS-05)

### Phase 3: Extensibility
**Goal**: Users can drop plugin files into the plugins directory to add custom connectors, scorers, or lifecycle hooks without modifying core code
**Depends on**: Phase 2 (stable system before opening extension points)
**Requirements**: EXT-01, EXT-02, EXT-03, EXT-04
**Success Criteria** (what must be TRUE):
  1. A sample enricher plugin in the plugins directory runs automatically during the enrich pipeline
  2. Lifecycle hooks fire at documented points (afterIngest, afterEmbed, afterEnrich, afterSearch) and plugin code can observe memory events
  3. Plugin interface is documented with working example that a developer can copy and modify
**Plans**: TBD

Plans:
- [ ] 03-01: Plugin system and lifecycle hooks (EXT-01, EXT-02, EXT-03, EXT-04)

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Search Quality | 2/2 | Complete | 2026-03-07 |
| 2. Operational Maturity | 0/2 | Not started | - |
| 3. Extensibility | 0/1 | Not started | - |

# Requirements: Botmem Extensions

**Defined:** 2026-03-07
**Core Value:** Every piece of personal communication is searchable, connected, and queryable — with factuality labeling so the user knows what's verified vs. hearsay.

## v1 Requirements

Requirements for this milestone. Each maps to roadmap phases.

### Search Quality

- [x] **SRCH-01**: Search results are reranked using Qwen3-Reranker-0.6B via Ollama generate API, filling the 0.30 rerank weight slot
- [x] **SRCH-02**: Reranking is applied to top 10-15 candidates only, keeping latency under 3 seconds
- [x] **SRCH-03**: User can pin a memory, which sets a score floor (pinned memories never drop below 0.75 final score)
- [x] **SRCH-04**: Pinned memories are exempt from recency decay
- [x] **SRCH-05**: Each successful search result view increments the memory's recall count, boosting importance score
- [x] **SRCH-06**: Importance reinforcement is capped at +0.2 after 10 recalls to prevent runaway scores

### Operational

- [x] **OPS-01**: Nightly decay job recomputes recency scores for all memories via BullMQ job scheduler
- [x] **OPS-02**: Decay job processes memories in batches of 500-1000 to avoid SQLite writer contention
- [x] **OPS-03**: PostHog analytics tracks pageviews and key user events (search, sync, pin) via cloud free tier
- [x] **OPS-04**: PostHog integration is no-op when API key is not configured (safe for dev without PostHog)
- [x] **OPS-05**: Backend emits server-side analytics events for sync completions and errors via posthog-node

### Extensibility

- [ ] **EXT-01**: Plugin system supports three plugin types: connector, scorer, and lifecycle hook
- [ ] **EXT-02**: Lifecycle hooks fire on memory events: afterIngest, afterEmbed, afterEnrich, afterSearch
- [ ] **EXT-03**: Plugins are plain objects with a manifest, not NestJS providers — loaded from plugins directory
- [ ] **EXT-04**: Plugin interface is documented with a sample enricher plugin

## v2 Requirements

Deferred to future milestone. Tracked but not in current roadmap.

### Advanced Search

- **ADV-01**: Natural language query decomposition (multi-part queries split into sub-queries)
- **ADV-02**: Contradiction detection across memories (automatic FICTION labeling when sources conflict)
- **ADV-03**: Temporal query understanding ("what happened last Tuesday")

### Advanced Operations

- **AOPS-01**: Scheduled auto-sync per connector (cron-based)
- **AOPS-02**: Memory export/backup functionality
- **AOPS-03**: Dashboard analytics widgets showing search patterns and memory growth

## Out of Scope

| Feature | Reason |
|---------|--------|
| PostHog self-hosting | Requires 16GB RAM + ClickHouse/Kafka — disproportionate for single-user |
| Plugin marketplace | No external plugin ecosystem exists; premature |
| Plugin hot-reload | Over-engineering for current usage |
| Plugin sandboxing | No untrusted third-party plugins expected |
| Native Ollama rerank API | Blocked by upstream (PR #7219); use generate workaround |
| Real-time reranking for graph view | Too slow; reranking is search-only |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SRCH-01 | Phase 1 | Complete |
| SRCH-02 | Phase 1 | Complete |
| SRCH-03 | Phase 1 | Complete |
| SRCH-04 | Phase 1 | Complete |
| SRCH-05 | Phase 1 | Complete |
| SRCH-06 | Phase 1 | Complete |
| OPS-01 | Phase 2 | Complete |
| OPS-02 | Phase 2 | Complete |
| OPS-03 | Phase 2 | Complete |
| OPS-04 | Phase 2 | Complete |
| OPS-05 | Phase 2 | Complete |
| EXT-01 | Phase 3 | Pending |
| EXT-02 | Phase 3 | Pending |
| EXT-03 | Phase 3 | Pending |
| EXT-04 | Phase 3 | Pending |

**Coverage:**
- v1 requirements: 15 total
- Mapped to phases: 15
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-07*
*Last updated: 2026-03-07 after initial definition*

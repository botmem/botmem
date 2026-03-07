# Feature Landscape — Botmem Extensions

**Domain:** Personal Memory RAG System (extending existing)
**Researched:** 2026-03-07

## Table Stakes

Features that are expected once the core system is working. Missing = system feels incomplete.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Reranker scoring | The scoring formula already has a `rerank` weight (0.30) hardcoded to 0 | Medium | Requires Ollama generate-based scoring; no native rerank API |
| Importance reinforcement | Memories accessed often should rank higher over time | Low | Schema change + counter increment on search access |
| Memory pinning | Users need to mark important memories manually | Low | Boolean column + UI toggle + importance override |
| Nightly decay job | Without decay, old irrelevant memories compete with fresh ones | Low | BullMQ repeatable job, simple exponential decay |
| Search result feedback | "Was this result helpful?" improves ranking over time | Medium | UI component + importance adjustment |
| Product analytics | Understanding which connectors/features get used | Low | PostHog JS already installed; needs API key + backend SDK |

## Differentiators

Features that set the system apart. Not expected, but high value.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Cross-connector timeline | "What was I doing on March 5?" -- unified timeline across all sources | Medium | Query by date range across all connector types, group by time |
| Conversational memory query | Natural language follow-up questions ("Tell me more about that email") | High | Requires conversation context, memory of previous search results |
| Memory contradictions view | Surface memories that contradict each other (FACT vs FICTION) | Medium | Already have factuality labels; need UI to surface `contradicts` links |
| Enricher plugins | Custom entity extractors, sentiment analysis, topic classification | Medium | Extend plugin system beyond connectors |
| Scheduled auto-sync | Connectors sync on schedule without manual triggering | Low | BullMQ repeatable jobs per account |
| Memory export | Export memories as JSON/CSV for backup or migration | Low | API endpoint + CLI command |
| Contact merge UI | Review and approve/reject contact merge suggestions | Medium | Already have contact dedup; needs approval workflow |

## Anti-Features

Features to explicitly NOT build.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Real-time chat ingestion | Massive complexity, battery drain, privacy concerns | Batch sync is sufficient; users can re-sync when needed |
| Multi-user support | Adds auth complexity, data isolation, permissions | Single-user personal tool; deploy separate instances |
| Plugin marketplace | Premature; no user base to justify distribution infra | Load from local directory, document the interface |
| AI chat interface (general) | Botmem is a memory system, not a chatbot | Expose memories as context for external AI tools via CLI/API |
| Automatic memory deletion | Risk of data loss; goes against "store everything" philosophy | Provide manual delete + archive; label confidence instead |
| Mobile app | Web works on mobile; native app is huge effort | Responsive web design is sufficient |
| Native image similarity search | Requires CLIP or similar; adds model complexity | Image retrieval via OCR/caption/metadata (current approach) |

## Feature Dependencies

```
Reranker scoring --> (none, independent)
Importance reinforcement --> (none, independent)
Memory pinning --> Importance reinforcement (pinned = max importance)
Nightly decay job --> @nestjs/schedule (new dep)
Search result feedback --> Importance reinforcement (feedback adjusts importance)
Enricher plugins --> Plugin system extension (hook system)
Scheduled auto-sync --> @nestjs/schedule + BullMQ repeatable jobs
Cross-connector timeline --> (none, API query change)
Conversational memory query --> Search result feedback (needs session context)
```

## MVP Recommendation (Next Milestone)

Prioritize:
1. **Reranker scoring** -- Fills the empty 0.30 weight in the formula; biggest search quality improvement
2. **Importance reinforcement** -- Low effort, high impact on result quality over time
3. **Memory pinning** -- Simple UX, users expect manual control
4. **Nightly decay job** -- Prevents stale memories from dominating results
5. **PostHog integration** -- Completes the already-started analytics setup

Defer:
- **Conversational memory query** -- High complexity, needs clear UX design first
- **Enricher plugins** -- Useful but no external demand yet; current enrichment pipeline works
- **Contact merge UI** -- Functional without it; merge suggestions work automatically

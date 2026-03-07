# Research Summary: Botmem Extensions

**Domain:** Personal Memory RAG System -- extending beyond core functionality
**Researched:** 2026-03-07
**Overall confidence:** MEDIUM-HIGH

## Executive Summary

Botmem has a solid foundation with 6 connectors, a working pipeline (sync -> embed -> enrich), vector search via Qdrant, and a React frontend with graph visualization. The next phase focuses on search quality improvements (reranking, importance reinforcement), operational maturity (analytics, scheduled jobs), and extensibility (plugin system evolution).

The most impactful addition is **reranker integration**, which fills the currently-empty 0.30 weight slot in the scoring formula. However, this comes with a significant caveat: Ollama does not have a native rerank API endpoint as of March 2026, despite having reranker models available in its registry. Implementation must use the generate API with prompt-based scoring, which introduces latency that needs careful management.

The second key finding is that **PostHog self-hosting is a trap** for a single-user system. It requires 16GB RAM and a full ClickHouse/Kafka/Postgres stack -- more infrastructure than Botmem itself. The cloud free tier (1M events/month) is the right choice.

Everything else (importance reinforcement, memory pinning, nightly decay, plugin hooks) requires no new external dependencies -- just application logic changes using the existing stack.

## Key Findings

**Stack:** Add `posthog-node@^5.28`, `@nestjs/schedule@^5.0`, and pull `sam860/qwen3-reranker:0.6b-Q8_0` on Ollama. No other new dependencies needed.

**Architecture:** Reranking is a generate-based workaround (not native API). Limit to top 10-15 candidates to manage latency. Analytics wraps gracefully (no-op when unconfigured).

**Critical pitfall:** Ollama has no `/api/rerank` endpoint despite listing reranker models. Build against `/api/generate` with a scoring prompt.

## Implications for Roadmap

Based on research, suggested phase structure:

1. **Search Quality** -- Reranker + importance reinforcement + memory pinning
   - Addresses: Reranker scoring, importance tracking, pin UX
   - Avoids: Latency issues by making reranking opt-in and limited to top candidates
   - This phase has the highest impact on user experience

2. **Operational Maturity** -- Analytics + scheduled jobs + decay
   - Addresses: PostHog integration, nightly decay, auto-sync scheduling
   - Avoids: Self-hosting PostHog (use cloud); over-complicated cron setup
   - Depends on: Schema changes from Phase 1 (recallCount, pinned columns)

3. **Extensibility** -- Plugin hooks + enricher plugins
   - Addresses: Hook system for memory lifecycle events, enricher plugin type
   - Avoids: Over-engineering (no marketplace, no hot-reload, no sandboxing)
   - Depends on: Stability from Phases 1-2 before opening extension points

**Phase ordering rationale:**
- Search quality first because the rerank weight is already allocated but empty -- this is visible technical debt
- Analytics second because you need the improved search running before you can measure its effectiveness
- Plugin extensibility last because no external plugins exist yet; build the hook system when you have a concrete enricher to plug in

**Research flags for phases:**
- Phase 1 (Search Quality): Needs validation -- the generate-based reranking approach should be prototyped and benchmarked before committing to the full integration. Latency on RTX 3070 with model swapping is unknown.
- Phase 2 (Analytics): Standard patterns, unlikely to need further research
- Phase 3 (Plugins): May need research when the first enricher plugin is designed

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Only 2 new npm packages, both well-documented; reranker model confirmed on Ollama |
| Features | HIGH | Clear feature list from PROJECT.md active items; dependencies mapped |
| Architecture | MEDIUM | Reranking via generate API is a community workaround, not officially supported pattern; latency implications need benchmarking |
| Pitfalls | HIGH | Ollama rerank gap confirmed via multiple sources; PostHog requirements verified from official docs |

## Gaps to Address

- **Reranker latency benchmarking:** Unknown how fast Qwen3-Reranker-0.6B runs via generate on RTX 3070. Needs a prototype to measure before committing to the UX pattern (synchronous vs. async reranking).
- **Ollama rerank API timeline:** PR #7219 may merge soon. If it does, the implementation can simplify significantly. Worth checking before building the generate-based workaround.
- **PostHog event schema:** Which specific events to track needs product thinking, not research. Recommendation: start with 10-15 events (search, sync, pin, error) and expand based on what's useful.
- **Importance formula tuning:** The decay rate (0.998/day) and reinforcement amount (how much a click boosts importance) will need empirical tuning after deployment. Start conservative and adjust.

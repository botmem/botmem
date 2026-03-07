# Domain Pitfalls

**Domain:** Personal memory RAG system -- scoring, reranking, decay, plugins, analytics
**Researched:** 2026-03-07

## Critical Pitfalls

Mistakes that cause rewrites or major issues.

### Pitfall 1: Ollama Rerank API Does Not Exist

**What goes wrong:** Assuming Ollama has a `/api/rerank` endpoint (like vLLM's `/v1/rerank`) and building against it. It does not exist as of March 2026.
**Why it happens:** Multiple Ollama reranker models are listed in the registry, suggesting native support. The PR (#7219) exists but is not merged.
**Consequences:** Code that calls a non-existent endpoint fails silently or errors. Days wasted debugging.
**Prevention:** Use `/api/generate` with prompt-based scoring. Wrap in a RerankerService that can swap to native API when it ships.
**Detection:** 404 errors from Ollama, empty rerank scores.

### Pitfall 2: Reranking Latency Destroys Search UX

**What goes wrong:** Reranking all 60 vector search candidates sequentially through Ollama. At ~200ms per generate call, that's 12 seconds per search.
**Why it happens:** Naively applying reranking to all candidates without limiting the set.
**Consequences:** Search feels broken. Users abandon the feature.
**Prevention:** Rerank only top 10-15 candidates. Make reranking opt-in (query parameter). Consider async reranking where initial results show immediately, reranked results replace them.
**Detection:** Search response times > 3 seconds.

### Pitfall 3: Importance Score Runaway

**What goes wrong:** Frequently searched memories get importance boosted on every access, creating a feedback loop where the same memories always appear first regardless of query relevance.
**Why it happens:** Uncapped importance reinforcement without decay or normalization.
**Consequences:** Search results become stale -- same top-10 results for every query.
**Prevention:** Cap importance boost (max 1.0). Apply nightly decay. Weight importance at only 0.10 in the formula (semantic similarity should dominate). Boost only on explicit feedback, not on every search result view.
**Detection:** Importance scores clustered near 1.0 for many memories; decreasing search result diversity.

### Pitfall 4: PostHog Self-Hosting Resource Drain

**What goes wrong:** Self-hosting PostHog because "privacy" or "local-first philosophy," then discovering it requires 16GB RAM, ClickHouse, Kafka, Postgres, Redis, Zookeeper, and MinIO.
**Why it happens:** PostHog markets self-hosting prominently. The hobby docker-compose makes it look simple.
**Consequences:** Consumes more resources than the entire Botmem stack combined. System slows down. Maintenance burden.
**Prevention:** Use PostHog Cloud free tier (1M events/month). A single-user personal tool will never exceed this. Analytics data is not sensitive enough to justify self-hosting overhead.
**Detection:** `docker stats` showing PostHog containers consuming >8GB RAM.

## Moderate Pitfalls

### Pitfall 5: Decay Rate Miscalibration

**What goes wrong:** Choosing a decay rate that's too aggressive (memories become irrelevant in weeks) or too gentle (no observable effect).
**Prevention:** Start with `importance *= 0.998` per day (~50% after 1 year, ~25% after 2 years). This is conservative and tunable. Log the decay factor in config, not hardcoded.

### Pitfall 6: Plugin System Scope Creep

**What goes wrong:** Building a full plugin SDK with versioning, dependency resolution, hot-reloading, and configuration UI before any external plugin exists.
**Prevention:** Current `loadFromDirectory` + factory function pattern is sufficient. Extend only when the first non-connector plugin is built. Add hook system (EventEmitter2) as the first extension point.

### Pitfall 7: Counting Views as Recalls

**What goes wrong:** Incrementing `recallCount` every time a memory appears in search results, even when the user doesn't read or interact with it.
**Prevention:** Only count explicit interactions: clicking to expand a memory, pinning it, or clicking "helpful." Appearing in a results list is not a meaningful recall signal.

### Pitfall 8: Reranker Model Contention on GPU

**What goes wrong:** The reranker model competes with embedding model and text model for GPU memory on the RTX 3070 (8GB VRAM).
**Prevention:** Use the 0.6B reranker (smallest available). Ollama manages model loading/unloading, but frequent model swaps add latency. Consider batching rerank requests. Monitor VRAM usage.

## Minor Pitfalls

### Pitfall 9: @nestjs/schedule Timezone Issues

**What goes wrong:** Nightly decay job fires at the wrong time because the server timezone differs from the user's timezone.
**Prevention:** Use UTC for all cron expressions. The decay calculation doesn't depend on local time anyway.

### Pitfall 10: PostHog Distinct ID for Single-User

**What goes wrong:** Using a random distinct_id or session-based ID for PostHog events, fragmenting analytics across "users."
**Prevention:** Use a fixed distinct_id like `"owner"` since there's only one user. This ensures all events aggregate correctly.

### Pitfall 11: Forgetting to Flush PostHog on Shutdown

**What goes wrong:** PostHog Node SDK batches events. If the process exits without calling `shutdown()`, the last batch is lost.
**Prevention:** Implement `OnModuleDestroy` in PosthogService and call `this.client.shutdown()`.

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Reranker integration | No native Ollama rerank API | Use generate-based scoring; abstract behind service |
| Reranker integration | Latency from sequential scoring | Limit to top 10-15 candidates; make opt-in |
| Importance system | Feedback loop / score runaway | Cap at 1.0; apply nightly decay; count clicks not views |
| PostHog setup | Self-hosting temptation | Use cloud free tier; 1M events/month is plenty |
| Nightly decay | Choosing wrong decay rate | Start conservative (0.998/day); make configurable |
| Plugin system | Over-engineering | Extend existing pattern; don't build marketplace |
| Scheduled jobs | Timezone confusion | Use UTC everywhere |

## Sources

- [Ollama rerank issue #3368](https://github.com/ollama/ollama/issues/3368) -- no native endpoint
- [Ollama rerank endpoint issue #10467](https://github.com/ollama/ollama/issues/10467) -- confirmed non-existent
- [PostHog self-host requirements](https://posthog.com/docs/self-host) -- 4 vCPU, 16GB RAM
- [Qdrant reranking best practices](https://qdrant.tech/documentation/search-precision/reranking-semantic-search/) -- limit candidate set
- [NestJS task scheduling](https://docs.nestjs.com/techniques/task-scheduling) -- cron patterns

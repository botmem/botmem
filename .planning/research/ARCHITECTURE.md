# Architecture Patterns — Botmem Extensions

**Domain:** Personal memory RAG system -- scoring, decay, plugins, analytics
**Researched:** 2026-03-07

## Current Architecture (Unchanged)

```
Connector.sync() --> rawEvents --> [sync queue] --> [embed queue] --> [enrich queue] --> Qdrant
                                                                                     --> SQLite
```

The extension points are: search scoring, scheduled maintenance, plugin loading, and analytics instrumentation.

## Extension Architecture

### Component Boundaries

| Component | Responsibility | Communicates With |
|-----------|---------------|-------------------|
| RerankerService | Score query-document relevance via Ollama generate | OllamaService, MemoryService |
| ImportanceService | Track recall counts, compute importance, apply decay | DbService, MemoryService |
| SchedulerModule | Cron triggers for nightly decay, auto-sync | BullMQ queues, ImportanceService |
| PosthogService | Capture events to PostHog | ConfigService (for API key) |
| PluginsService (extended) | Load connectors + enrichers + hooks from directory | ConnectorsService, EnrichProcessor |

### Data Flow: Search with Reranking

```
1. User query arrives at MemoryService.search()
2. Embed query via OllamaService.embed()
3. Qdrant vector search returns top-N candidates (N=60)
4. Text/contact matching narrows candidates
5. [NEW] RerankerService.rerank(query, candidates) --> top-K scored results
   - For each candidate: OllamaService.generate() with scoring prompt
   - Returns relevance score 0-1
6. Compute final score with all weights filled:
   final = 0.40*semantic + 0.30*rerank + 0.15*recency + 0.10*importance + 0.05*trust
7. [NEW] ImportanceService.recordAccess(memoryId) for returned results
8. Return sorted results
```

### Data Flow: Nightly Decay

```
1. @nestjs/schedule fires cron at 03:00 daily
2. Enqueues "decay" job on BullMQ
3. DecayProcessor runs:
   a. SELECT all memories WHERE importance > 0.1
   b. For each: newImportance = importance * 0.998  (~50% after 1 year)
   c. Skip pinned memories (importance stays at 1.0)
   d. Batch UPDATE memories SET importance = newImportance
```

## Patterns to Follow

### Pattern 1: Prompt-Based Reranking via Generate API

**What:** Use Ollama's `/api/generate` with a structured prompt to score relevance, since no native `/api/rerank` exists.

**When:** Every search query, on the top-N candidates from vector search.

**Example:**
```typescript
async rerank(query: string, documents: string[]): Promise<number[]> {
  const scores: number[] = [];
  for (const doc of documents) {
    const prompt = `Given the query: "${query}"
Rate the relevance of the following document on a scale of 0.0 to 1.0.
Respond with ONLY a number, nothing else.

Document: "${doc.slice(0, 500)}"

Relevance score: /no_think`;

    const response = await this.ollama.generate(prompt);
    const score = parseFloat(response.trim());
    scores.push(isNaN(score) ? 0 : Math.min(Math.max(score, 0), 1));
  }
  return scores;
}
```

**Performance concern:** This makes N sequential Ollama calls per search. Mitigate by:
- Limiting reranking to top 10-15 candidates (not all 60)
- Using the 0.6B reranker model (fast inference)
- Making reranking optional via query parameter (`?rerank=true`)

### Pattern 2: Thin Service Wrapper for External SDKs

**What:** Wrap external SDKs (PostHog, future integrations) in a NestJS injectable service with graceful degradation.

**When:** Integrating any external service that may not always be configured.

**Example:**
```typescript
@Injectable()
export class PosthogService implements OnModuleDestroy {
  private client: PostHog | null = null;

  constructor(config: ConfigService) {
    const apiKey = config.posthogApiKey;
    if (apiKey) {
      this.client = new PostHog(apiKey, { host: config.posthogHost });
    }
  }

  capture(event: string, properties?: Record<string, any>) {
    // No-op if PostHog not configured -- never throw
    this.client?.capture({ distinctId: 'owner', event, properties });
  }

  async onModuleDestroy() {
    await this.client?.shutdown();
  }
}
```

**Key principle:** Analytics must never break the app. No API key = silent no-op.

### Pattern 3: Plugin Hook System via NestJS Events

**What:** Use NestJS EventEmitter2 for plugin hooks instead of building custom pub/sub.

**When:** Extending the system with lifecycle events.

**Example:**
```typescript
// Core emits
this.eventEmitter.emit('memory.created', { memoryId, text, sourceType });
this.eventEmitter.emit('search.completed', { query, resultCount, duration });

// Plugin subscribes
@OnEvent('memory.created')
async onMemoryCreated(payload: MemoryCreatedEvent) {
  // Custom enrichment, external notification, etc.
}
```

**Dependency:** `@nestjs/event-emitter` (wraps eventemitter2).

## Anti-Patterns to Avoid

### Anti-Pattern 1: Blocking Search on Reranking

**What:** Making reranking a required synchronous step in every search.
**Why bad:** Adds 2-5 seconds latency per search (10-15 sequential Ollama calls).
**Instead:** Make reranking opt-in per query. Return fast results immediately; reranked results as a quality option.

### Anti-Pattern 2: Caching Rerank Scores

**What:** Storing rerank scores in SQLite to avoid re-computation.
**Why bad:** Rerank scores are query-specific (query + document pair). Caching requires storing scores for every possible query, which is unbounded.
**Instead:** Compute at query time. Consider caching only for identical repeated queries (LRU cache, 5-minute TTL).

### Anti-Pattern 3: Over-Engineering the Plugin System

**What:** Building a full plugin lifecycle (install, enable, disable, configure, update, uninstall) before having any external plugins.
**Why bad:** Premature abstraction. No external plugins exist yet.
**Instead:** Keep the current `loadFromDirectory` approach. Add hook system when the first enricher plugin is built. Evolve incrementally.

### Anti-Pattern 4: PostHog Tracking Everything

**What:** Instrumenting every API endpoint, every database query, every Ollama call.
**Why bad:** Single-user system generates noise, not insights. PostHog free tier has event limits.
**Instead:** Track only actionable events: searches performed, connectors synced, memories pinned, enrichment failures. 10-15 event types maximum.

## Scalability Considerations

Not a primary concern for single-user, but worth noting:

| Concern | Current (10K memories) | At 100K memories | At 1M memories |
|---------|----------------------|-------------------|-----------------|
| Vector search | Fast (<100ms) | Fast (<200ms) | May need Qdrant sharding |
| Reranking | 10 docs * 200ms = 2s | Same (only top-N) | Same |
| Nightly decay | <1s batch update | ~5s batch update | May need chunked updates |
| SQLite | Fine | Fine with WAL | Consider read replicas or migration |
| Embedding queue | Sequential, fine | May need concurrency=2 | GPU becomes bottleneck |

## Sources

- [Qdrant reranking for better search](https://qdrant.tech/documentation/search-precision/reranking-semantic-search/)
- [NestJS task scheduling](https://docs.nestjs.com/techniques/task-scheduling)
- [NestJS dynamic modules](https://docs.nestjs.com/fundamentals/dynamic-modules)
- [PostHog Node.js SDK](https://posthog.com/docs/libraries/node)

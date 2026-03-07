# Technology Stack — Extensions & Improvements

**Project:** Botmem Personal Memory RAG System
**Researched:** 2026-03-07
**Scope:** Additive stack recommendations for existing system (core stack is decided)

## Existing Stack (Not Re-Researched)

NestJS 11, SQLite/Drizzle, Qdrant, BullMQ/Redis, React 19, Vite 6, Zustand 5, Tailwind 4, Ollama (nomic-embed-text, qwen3:0.6b, qwen3-vl:2b), pnpm 9.15, Turbo 2.4, Vitest 3.

---

## Recommended Additions

### 1. Reranker — Qwen3-Reranker-0.6B via Ollama Generate API

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Qwen3-Reranker-0.6B | Q8_0 quant | Second-pass reranking of search results | Same Qwen3 family as existing models, fits on RTX 3070 alongside current models, 0.6B matches text model size budget |

**CRITICAL FINDING:** Ollama does NOT have a native `/api/rerank` endpoint as of March 2026. The PR (#7219) is still pending. Reranking must be implemented via the `/api/generate` endpoint with a prompt-based scoring approach.

**Implementation approach:** Use the existing `OllamaService.generate()` method with a cross-encoder-style prompt that asks the model to score query-document relevance on a 0-1 scale. This is how the community implements reranking with Ollama today.

```
Model tag: sam860/qwen3-reranker:0.6b-Q8_0
    — or: dengcao/Qwen3-Reranker-0.6B:Q8_0
```

**Alternatives considered:**

| Option | Why Not |
|--------|---------|
| Qwen3-Reranker-8B | Too large for RTX 3070 alongside embedding + text + VL models |
| BAAI/bge-reranker via ONNX/FastEmbed | Requires separate Python service; adds deployment complexity |
| vLLM with /v1/rerank endpoint | Overkill for single-user system; Ollama already running |
| No reranker (current state) | The `rerank` weight slot in the scoring formula is already allocated at 0.30 but hardcoded to 0 |

**Confidence:** MEDIUM — Model availability confirmed on Ollama registry. Generate-based reranking is a workaround, not native API. Performance with prompt-based scoring vs. true cross-encoder needs validation.

**Env var to add:**
```
OLLAMA_RERANK_MODEL=sam860/qwen3-reranker:0.6b-Q8_0
```

---

### 2. Analytics — PostHog (Self-Hosted or Cloud)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| posthog-js | ^1.225.0 (already installed) | Frontend event tracking | Already in web package.json |
| posthog-node | ^5.28.0 | Backend event tracking | Official Node SDK, batched async capture, NestJS-compatible |

**Current state:** `posthog-js` is already a dependency in `apps/web/package.json`. Backend SDK is not yet installed.

**Self-hosting verdict: Use PostHog Cloud free tier, not self-hosted.** Self-hosted PostHog requires 4 vCPU, 16GB RAM, and runs ClickHouse + Kafka + Postgres + Redis + Zookeeper + MinIO. This is wildly disproportionate for a single-user personal tool. The free cloud tier (1M events/month) is more than sufficient.

**Backend integration approach:** Wrap `posthog-node` in a NestJS provider (simple injectable service). Do NOT use the third-party `nestjs-posthog` package — it's community-maintained with low adoption. A 20-line wrapper is simpler and more maintainable.

```typescript
// PosthogService — thin wrapper
import { PostHog } from 'posthog-node';

@Injectable()
export class PosthogService {
  private client: PostHog;
  constructor(config: ConfigService) {
    this.client = new PostHog(config.posthogApiKey, { host: config.posthogHost });
  }
  capture(distinctId: string, event: string, properties?: Record<string, any>) {
    this.client.capture({ distinctId, event, properties });
  }
  async shutdown() { await this.client.shutdown(); }
}
```

**Env vars to add:**
```
POSTHOG_API_KEY=phc_...
POSTHOG_HOST=https://us.i.posthog.com   # or EU: https://eu.i.posthog.com
```

**Alternatives considered:**

| Option | Why Not |
|--------|---------|
| PostHog self-hosted | Requires 16GB RAM, ClickHouse, Kafka — overkill for single-user |
| Plausible | Web analytics only, no product analytics (funnels, user properties) |
| Umami | Same — web analytics, not product analytics |
| nestjs-posthog (npm) | Low adoption community package; trivial to wrap yourself |
| No analytics | Missing visibility into what connectors/features are actually used |

**Confidence:** HIGH — posthog-js already installed, posthog-node is well-documented official SDK.

---

### 3. Scheduled Jobs — @nestjs/schedule + BullMQ Repeatable Jobs

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| @nestjs/schedule | ^5.0.0 | Cron-based job scheduling (nightly decay, periodic tasks) | Official NestJS package, decorator-based, zero config |
| BullMQ repeatable jobs | (already have bullmq ^5) | Distributed-safe recurring jobs | Already using BullMQ; repeatable jobs are built-in |

**Use both together:** `@nestjs/schedule` for simple cron triggers (nightly decay calculation, importance score refresh), which then enqueue BullMQ jobs for the actual work. This gives you cron scheduling with BullMQ's retry/monitoring for the heavy lifting.

**Why not node-cron:** @nestjs/schedule wraps node-cron with NestJS DI integration and decorators. No reason to use raw node-cron in a NestJS app.

**Single instance note:** Botmem is single-user, single-instance. The multi-instance scheduling problem (where @nestjs/schedule fires on every instance) does not apply here.

**Confidence:** HIGH — Official NestJS package, well-documented.

---

### 4. Plugin System — NestJS Dynamic Modules + DiscoveryService

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| NestJS DiscoveryModule | (built into @nestjs/core) | Scan and discover plugin providers at runtime | Zero dependency, built into NestJS core |

**Current state:** The plugin system (`plugins.service.ts`) already works but is connector-only. It loads connector packages from a directory and registers them. This is a good foundation.

**Extension strategy:** Evolve the existing pattern rather than replacing it:

1. **Plugin manifest format** — Each plugin directory contains a `botmem-plugin.json` with type (`connector` | `enricher` | `hook`), entry point, and dependency declarations
2. **Hook system** — Define lifecycle hooks (`onMemoryCreated`, `onSearchQuery`, `onContactMerged`) that plugins can subscribe to via decorators
3. **Enricher plugins** — Plugins that add to the enrich pipeline (e.g., custom entity extractors, sentiment analysis)

**Do NOT build:**
- Hot-reloading of plugins at runtime — unnecessary complexity for a personal tool
- Plugin marketplace/registry — premature
- Plugin sandboxing — plugins run with full trust (it's your own machine)

**Confidence:** HIGH — NestJS dynamic modules are well-documented and the existing plugin loader already uses this pattern.

---

### 5. Importance Reinforcement — No New Dependencies

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| (none needed) | — | Track recall count, boost importance on access | Pure application logic using existing SQLite + Drizzle |

**Implementation requires only schema changes:**
- Add `recallCount` integer column to `memories` table
- Add `lastRecalledAt` timestamp column
- Increment on search result access
- Factor into importance: `importance = base + min(recallCount * 0.05, 0.3)`

**No external library needed.** This is pure business logic.

**Confidence:** HIGH — straightforward schema addition.

---

### 6. Memory Pinning — No New Dependencies

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| (none needed) | — | User-pinned memories get permanent importance boost | Pure schema change |

**Add `pinned` boolean to memories table.** Pinned memories get importance = 1.0, bypassing decay.

**Confidence:** HIGH.

---

### 7. Nightly Decay Job — No New Dependencies

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| (none needed) | — | Refresh recency scores, apply importance decay | BullMQ repeatable job + @nestjs/schedule trigger |

**The recency score is already computed at query time** (`Math.exp(-0.015 * ageDays)`). A nightly job is only needed if you want to:
- Pre-compute and cache scores in SQLite (avoid per-query computation)
- Apply importance decay for memories not recalled recently
- Update Qdrant payload metadata with fresh scores

**Recommendation:** Keep recency as query-time computation (it's fast). Use the nightly job only for importance decay:
```
newImportance = importance * 0.998  // ~50% after 1 year of no recall
```

**Confidence:** HIGH.

---

## Supporting Libraries (Optional/Future)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| zod | ^3.24 | Runtime schema validation for plugin manifests, API inputs | When adding plugin manifest validation or tightening API input validation |
| pino | ^9.6 | Structured JSON logging | When you need log aggregation or want machine-readable logs; NestJS Logger is fine for now |
| ioredis (already installed) | ^5.0 | Redis client | Already in use for BullMQ |

---

## What NOT to Use

| Technology | Why Not |
|------------|---------|
| LangChain / LlamaIndex | Massive dependency trees, abstractions over simple HTTP calls to Ollama. Your OllamaService is 100 lines and does exactly what you need. |
| PostgreSQL / pgvector | SQLite + Qdrant is working. Adding Postgres adds operational complexity for no benefit in single-user system. |
| Prisma | Already using Drizzle. Switching ORMs mid-project is pointless churn. |
| Elasticsearch | Qdrant handles vector search. SQLite LIKE handles text search. Adding ES is massive overhead. |
| FastEmbed / ONNX rerankers | Requires Python runtime or ONNX bindings. Stay in the Node.js + Ollama ecosystem. |
| GraphQL | REST API is working, single consumer (web + CLI). GraphQL adds complexity without benefit. |
| Redis Streams (for event bus) | BullMQ already provides pub/sub via Redis. WebSocket gateway handles real-time. No need for another event layer. |
| Weaviate / Milvus / Pinecone | Already on Qdrant, which is working well. No reason to switch. |

---

## Installation

```bash
# New backend dependencies
pnpm --filter @botmem/api add posthog-node@^5.28.0 @nestjs/schedule@^5.0.0

# Pull reranker model on Ollama host
# (run on the machine at 192.168.10.250)
ollama pull sam860/qwen3-reranker:0.6b-Q8_0
```

---

## Environment Variables Summary (New)

| Variable | Default | Purpose |
|----------|---------|---------|
| `OLLAMA_RERANK_MODEL` | `sam860/qwen3-reranker:0.6b-Q8_0` | Reranker model for second-pass scoring |
| `POSTHOG_API_KEY` | (none) | PostHog project API key |
| `POSTHOG_HOST` | `https://us.i.posthog.com` | PostHog ingest endpoint |

---

## Sources

- [Ollama reranker model search](https://ollama.com/search?q=rerank) — confirmed model availability
- [sam860/qwen3-reranker on Ollama](https://ollama.com/sam860/qwen3-reranker) — model tags and sizes
- [Ollama rerank API issue #3368](https://github.com/ollama/ollama/issues/3368) — no native rerank endpoint
- [Ollama rerank PR #7219](https://github.com/ollama/ollama/pull/7219) — pending merge
- [PostHog Node.js SDK docs](https://posthog.com/docs/libraries/node) — official documentation
- [posthog-node on npm](https://www.npmjs.com/package/posthog-node) — version 5.28.0
- [PostHog self-host requirements](https://posthog.com/docs/self-host) — 4 vCPU, 16GB RAM minimum
- [NestJS task scheduling docs](https://docs.nestjs.com/techniques/task-scheduling) — @nestjs/schedule
- [NestJS dynamic modules docs](https://docs.nestjs.com/fundamentals/dynamic-modules) — plugin architecture patterns
- [NestJS DiscoveryModule](https://docs.nestjs.com/) — built-in provider scanning
- [Qdrant reranking guide](https://qdrant.tech/documentation/search-precision/reranking-semantic-search/) — two-stage reranking best practices
- [Qwen3-Reranker-0.6B on HuggingFace](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B) — model documentation
- [Reranking with Ollama and Qwen3](https://www.glukhov.org/post/2025/06/qwen3-embedding-qwen3-reranker-on-ollama/) — implementation patterns

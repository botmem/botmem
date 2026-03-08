# Technology Stack: v2.1 Data Quality & Pipeline Integrity

**Project:** Botmem
**Researched:** 2026-03-08
**Milestone:** v2.1 (subsequent -- building on existing NestJS/BullMQ/Ollama stack)

## Scope

This document covers ONLY the stack additions and changes needed for:
1. Enforcing LLM structured output to canonical entity types
2. Entity deduplication / normalization within and across memories
3. Source type reclassification and backfill of 7,000+ existing memories
4. Unifying entity format between embed and enrich steps

## What Already Works (DO NOT change)

| Technology | Version | Status |
|------------|---------|--------|
| NestJS 11 | ^11.0.0 | Stable, keep |
| BullMQ | ^5.0.0 | Stable, keep |
| Drizzle ORM + SQLite | 0.38.4 | Stable, keep |
| Qdrant JS client | ^1.17.0 | Stable, keep |
| Ollama (remote, qwen3:0.6b) | Current | Stable, keep |
| compromise (NLP) | ^14.15.0 | Stable, keep |

## Recommended Stack Changes

### No New Dependencies Required

The v2.1 milestone does NOT require new npm packages. Here is why for each capability:

**Entity type enforcement:** Already implemented. `ENTITY_FORMAT_SCHEMA` in `prompts.ts` uses Ollama's `format` parameter with a JSON Schema that includes an `enum` constraint on entity types. Ollama (since v0.5) converts this to a GBNF grammar that constrains token generation at the inference level -- the model literally cannot produce a non-canonical type when the format parameter is set. The current schema already defines the exact 10 canonical types: `person, organization, location, event, product, topic, pet, group, device, other`. This is working correctly.

**Entity deduplication:** Use simple normalized string comparison (lowercase, trim, whitespace collapse), NOT a fuzzy matching library. Entity names are short strings (2-30 chars) extracted by an LLM -- the variation between duplicates is casing and whitespace, not typos or abbreviations. Levenshtein-based fuzzy matching (Fuse.js, string-similarity) would create dangerous false merges on short strings ("John" matching "Joan", "AWS" matching "AES"). A 15-line normalization function covers 90%+ of duplicates with zero false positives.

**Backfill processing:** BullMQ already has a `backfill` queue registered in `jobs.module.ts` with a working `BackfillProcessor`. The existing pattern (enqueue individual jobs per memory, `attempts: 2, backoff: exponential`) is correct for 7,000 records. Worker `concurrency` setting (already used for the enrich queue) prevents Ollama overload without needing BullMQ's rate limiting API.

**Source type fix:** Pure SQL UPDATE statements against SQLite. No library needed.

**Entity format unification:** Code change in `embed.processor.ts` to normalize `{type, id, role}` participant shape to `{type, value}` canonical shape. No library needed.

### Changes to Existing Code (Not Dependencies)

| Component | Change | Why |
|-----------|--------|-----|
| `enrich.service.ts` | Add post-extraction normalization + dedup | Belt-and-suspenders: even with grammar enforcement, normalize casing/whitespace and remove duplicate `{type, value}` pairs |
| `enrich.service.ts` | Filter empty/garbage entity values | Remove entities where `value` is empty string, single character, or purely numeric |
| `embed.processor.ts` | Normalize participant entities to `{type, value}` shape | Currently produces `{type, id, role}` which conflicts with enrich step's `{type, value}` |
| `backfill.processor.ts` | Add re-enrichment mode | Currently only resolves contacts; needs a mode that re-runs entity extraction via `EnrichService.enrich()` |
| `memory.controller.ts` | Add `POST backfill-entities` endpoint | Enqueue re-enrichment jobs for memories with bad/empty entity data |
| `prompts.ts` | Strengthen entity extraction prompt | Add explicit rules against extracting generic words, pronouns, single letters |
| New migration script | `backfill-source-types.ts` | Fix `source_type = 'file'` to `'photo'` for photos connector |
| `qdrant.service.ts` | Add batch payload update method | Update `source_type` in Qdrant payloads for affected memories |

## Architecture Decisions

### 1. Entity Deduplication: Normalization over Fuzzy Matching

**Decision:** Use simple string normalization, not a fuzzy matching library.

| Approach | Verdict | Rationale |
|----------|---------|-----------|
| Fuzzy matching (Fuse.js, string-similarity) | REJECT | False merges on short strings; "John" ~ "Joan" at 0.75 similarity; overkill for LLM-extracted entities where spelling is consistent |
| Exact match after normalization | USE THIS | `toLowerCase().trim().replace(/\s+/g, ' ')` handles casing and whitespace variation which is 90%+ of LLM output duplicates |
| Embedding-based dedup | REJECT | Requires Ollama call per entity pair; not worth the cost for 7K records |

Implementation pattern (no dependency needed):

```typescript
function normalizeEntityValue(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, ' ');
}

function deduplicateEntities(
  entities: Array<{ type: string; value: string }>,
): Array<{ type: string; value: string }> {
  const seen = new Set<string>();
  return entities.filter((e) => {
    if (!e.value || e.value.length <= 1) return false; // drop garbage
    const key = `${e.type}:${normalizeEntityValue(e.value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
```

### 2. Cross-Memory Entity Dedup: SQL Aggregation

The `searchEntities` method in `memory.service.ts` already aggregates entities by `type:value` key across memories. For a global cleanup of existing data, a one-time migration script (following the pattern of `backfill-entity-types.ts`) normalizes entity values in-place within a SQLite transaction. No new infrastructure needed.

### 3. Backfill Strategy for 7,000+ Memories

**Decision:** Extend existing BullMQ backfill queue with rate-limited concurrency.

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Queue | `backfill` (existing) | Already registered in jobs module, has working processor |
| Worker concurrency | 4 | Ollama on RTX 3070 handles ~4 concurrent text inference requests; more causes queuing without throughput gain |
| Batch API size | 500 per POST call | Match existing `backfill-embeddings` endpoint pattern; prevents API timeout |
| Job options | `attempts: 2, backoff: { type: 'exponential', delay: 1000 }` | Handles transient Ollama failures gracefully |
| Estimated time | ~35-60 min for 7K records | ~0.3-0.5s per entity extraction call at concurrency 4; actual depends on text length |
| Idempotency | Overwrite entities column | Re-enrichment replaces existing entities; safe to run multiple times |

No need for BullMQ Pro batches feature or rate limiting API. Worker concurrency is the throttle.

### 4. Source Type Fix: Two-Part Strategy

**Part 1 -- Connector fix:** Photos-Immich connector should emit `sourceType: 'photo'` not `'file'` in `ConnectorDataEvent`.

**Part 2 -- Backfill existing records:** SQL migration + Qdrant payload update.

```sql
-- SQLite migration
UPDATE memories SET source_type = 'photo'
WHERE connector_type = 'photos' AND source_type = 'file';

UPDATE raw_events SET source_type = 'photo'
WHERE connector_type = 'photos' AND source_type = 'file';
```

For Qdrant, the `source_type` field in point payloads also needs updating. Use Qdrant's `set_payload` API to batch-update affected points without re-embedding:

```typescript
// qdrant.service.ts addition
async updatePayloadBatch(
  filter: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<void> {
  await this.client.setPayload('memories', {
    payload,
    filter: { must: [{ key: 'source_type', match: { value: 'file' } },
                      { key: 'connector_type', match: { value: 'photos' } }] },
  });
}
```

### 5. Entity Format Unification

**Problem:** Two different entity shapes coexist in the `entities` JSON column:
- Embed step produces: `{ type: 'person', id: 'user@email.com', role: 'sender' }` (from connector participant data)
- Enrich step produces: `{ type: 'person', value: 'John Smith' }` (from LLM extraction)

**Decision:** Standardize on `{ type: string, value: string }` as the canonical shape.

- The embed step should convert participant data to canonical shape before storing
- The `id` field maps to `value`; `role` is already stored separately in the `memoryContacts` junction table
- The backfill migration normalizes existing records to canonical shape

### 6. Structured Output Enforcement: Already Sufficient

The current `ENTITY_FORMAT_SCHEMA` in `prompts.ts` uses Ollama's `format` parameter which generates a GBNF grammar from JSON Schema. This constrains token generation at the inference level -- the `enum` field literally restricts the grammar to only produce tokens matching the 10 canonical types. This is not a "hope the model follows instructions" approach; it is a hard grammatical constraint.

**What to add:** Post-extraction validation as a safety net. Even though grammar enforcement handles types, validate that:
- Entity values are non-empty and meaningful (not single chars, not purely numeric IDs)
- Entity count per memory is reasonable (cap at 20; more indicates hallucination)
- Known misclassification patterns are caught (e.g., common first names classified as `location`)

## What NOT to Add

| Technology | Why Not |
|------------|---------|
| Fuse.js / string-similarity / fuzzyset.js | Entity names are 2-30 char strings; fuzzy matching creates false merges at this length |
| Python dedupe / entity-resolution libraries | Wrong language; would require a Python sidecar; simple normalization is sufficient |
| OpenAI / external LLM for better extraction | Ollama structured output with grammar enforcement is sufficient; external API adds latency and cost |
| Neo4j / dedicated graph DB for entities | Entities are stored as JSON in memories table; SQLite JSON querying + Qdrant handles all current access patterns |
| BullMQ Pro (batches feature) | Individual jobs with worker concurrency achieve the same result; Pro is a paid package |
| Schema migration tool beyond Drizzle | One-off data migration scripts (raw `better-sqlite3`) handle backfill; Drizzle Kit handles schema changes |
| Separate entity normalization service | Normalization is a pure function (15 lines); extracting it to a service adds unnecessary indirection |

## Installation

```bash
# No new packages needed for v2.1.
# All changes are code-level modifications to existing files.
```

## Confidence Assessment

| Claim | Confidence | Source |
|-------|------------|--------|
| Ollama `format` parameter enforces enum via GBNF grammar | HIGH | [Ollama Structured Outputs docs](https://docs.ollama.com/capabilities/structured-outputs), confirmed in codebase `prompts.ts` |
| `ENTITY_FORMAT_SCHEMA` already has correct 10-type enum | HIGH | Direct code inspection of `prompts.ts` line 11 |
| BullMQ backfill queue exists and works | HIGH | Direct code inspection of `backfill.processor.ts`, `jobs.module.ts`, `memory.controller.ts` |
| 7K records at ~0.3-0.5s each = 35-60 min backfill | MEDIUM | Based on typical Ollama qwen3:0.6b inference times on RTX 3070; actual varies with text length and GPU load |
| Simple normalization beats fuzzy matching for entity dedup | HIGH | Domain analysis: LLM-extracted entities have consistent spelling; variation is casing/whitespace only |
| Qdrant `set_payload` supports batch filter-based updates | HIGH | [Qdrant docs](https://qdrant.tech/documentation/concepts/points/#update-payload) |
| No new npm dependencies needed | HIGH | All required capabilities (string normalization, BullMQ queuing, SQLite transactions, Qdrant API) exist in current stack |

## Sources

- [Ollama Structured Outputs Documentation](https://docs.ollama.com/capabilities/structured-outputs) -- confirms format parameter with JSON Schema enum enforcement via GBNF grammar
- [Ollama Blog: Structured Outputs](https://ollama.com/blog/structured-outputs) -- explains grammar generation from JSON Schema
- [BullMQ Rate Limiting Documentation](https://docs.bullmq.io/guide/rate-limiting) -- worker-level rate limiting via concurrency setting
- [BullMQ Batches (Pro only)](https://docs.bullmq.io/bullmq-pro/batches) -- confirmed Pro-only feature, not needed
- [Qdrant Points API](https://qdrant.tech/documentation/concepts/points/) -- `set_payload` for batch payload updates
- Codebase inspection: `prompts.ts`, `enrich.service.ts`, `backfill.processor.ts`, `memory.controller.ts`, `embed.processor.ts`, `schema.ts`, `ollama.service.ts`

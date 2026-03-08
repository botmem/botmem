# Architecture Patterns: Data Quality & Pipeline Integrity

**Domain:** Data quality fixes for personal memory RAG pipeline
**Researched:** 2026-03-08
**Confidence:** HIGH (based on direct codebase analysis of all pipeline components)

---

## Current Architecture (As-Is)

The pipeline flows linearly through BullMQ queues:

```
Connector.sync()
  --> rawEvents table (immutable, stores original payload + sourceType)
  --> SyncProcessor
  --> [embed queue] EmbedProcessor
      - Reads ConnectorDataEvent from rawEvent.payload
      - Calls connector.embed() for structured entity extraction (EmbedResult)
      - Creates Memory record with sourceType from event.sourceType
      - Generates embedding via Ollama, upserts to Qdrant with source_type payload
      - Resolves contacts from EmbedResult.entities ({type, id, role} format)
      - Enqueues enrich job
  --> [enrich queue] EnrichProcessor
      - Calls EnrichService.enrich()
      - Entity extraction via Ollama structured output ({type, value} format)
      - OVERWRITES entities column from embed step
      - Factuality classification
      - Weight computation
      - Graph link creation via Qdrant similarity
      - Marks memory as 'done'
```

---

## Problem 1: Two Incompatible Entity Formats

The pipeline produces entities in two incompatible shapes that never merge:

| Step | Format | Purpose | Persisted? |
|------|--------|---------|------------|
| EmbedProcessor via `connector.embed()` | `{type, id, role}` | Contact resolution, thread linking | NO -- consumed then discarded |
| EnrichProcessor via Ollama | `{type, value}` | Searchable entity metadata | YES -- overwrites `memories.entities` |

The embed step's entities contain structured identifiers (emails, phone numbers, Slack IDs encoded in the `id` field) that are used for contact resolution, then thrown away. The enrich step's Ollama entities are the only ones that survive to `memories.entities`.

**Impact:** Entity-based search and graph visualization only see Ollama-extracted entities, missing the structured data from connectors.

## Problem 2: Source Type Misclassification

The `ConnectorDataEvent.sourceType` type includes `'photo'` as a valid value, but the photos-immich connector emits `'file'` instead (line 214 of `packages/connectors/photos-immich/src/index.ts`). Slack file attachments also emit `'file'`.

This means photos and Slack files share the same sourceType. The NLQ parser correctly maps user queries like "my photos" to `photo`, but `memory.service.ts` has a hack at line 208:

```typescript
const SOURCE_TYPE_ALIASES: Record<string, string> = { photo: 'file' };
```

This causes "my photos" searches to return Slack file attachments alongside actual photos.

The sourceType flows to three storage locations:
1. `memories.sourceType` column (SQLite)
2. `rawEvents.sourceType` column (SQLite)
3. Qdrant vector payload `source_type` field

## Problem 3: Entity Extraction Quality

The Ollama structured output schema (`ENTITY_FORMAT_SCHEMA` in `prompts.ts`) correctly constrains entity types to 10 canonical values via enum. However, the extraction prompt is minimal and produces:

1. **Garbage values** -- empty strings, single characters, pronouns ("I", "you"), generic terms ("the app", "the team")
2. **Misclassification** -- person names classified as locations or organizations
3. **No deduplication** -- "John" and "john" and "John Smith" as separate entities on the same memory
4. **No cross-memory dedup** -- same entity with different types across memories

The existing `backfill-entity-types.ts` migration already handles type normalization (removing `time`/`amount`/`metric` types, mapping unknown types to `other`), but does not address value-level quality.

---

## Recommended Architecture (To-Be)

### Principle: Fix at the Source, Backfill the Rest

Fix each problem at its origin point in the pipeline, then run targeted backfills for historical data. No new queue stages -- integrate fixes inline.

### Component Changes Overview

```
MODIFIED Components:
  1. photos-immich connector     -- emit 'photo' instead of 'file'
  2. EnrichService               -- integrate EntityNormalizer after Ollama extraction
  3. prompts.ts                  -- improved entity extraction prompt
  4. memory.service.ts           -- remove SOURCE_TYPE_ALIASES hack
  5. EmbedProcessor              -- persist embed entities in metadata for merge

NEW Components:
  6. EntityNormalizer             -- pure function: dedup + clean + validate entities
  7. SourceTypeBackfill           -- migration script: fix sourceType in SQLite + Qdrant
  8. EntityBackfill               -- queue-based: re-extract entities for existing memories
  9. QdrantService.updatePayload  -- method for payload-only updates (no re-embedding)
```

### Component Boundaries

| Component | Responsibility | Communicates With |
|-----------|---------------|-------------------|
| `EntityNormalizer` (new, pure function in `memory/entity-normalizer.ts`) | Dedup entities by normalized value, strip garbage, validate types, merge embed+enrich entities | EnrichService, BackfillProcessor |
| `SourceTypeBackfill` (new, script in `migrations/`) | Fix `file` to `photo` for Immich memories in SQLite + Qdrant | DbService (direct SQL), QdrantService |
| `EnrichService` (modified) | Call EntityNormalizer after Ollama extraction | OllamaService, EntityNormalizer |
| `EmbedProcessor` (modified) | Store embed-step entities in `metadata.embedEntities` | DbService |
| `QdrantService` (modified) | Add `updatePayload()` method for backfill | Qdrant REST API |
| `BackfillProcessor` (extended) | Re-run entity extraction on existing memories | EnrichService, BullMQ |

---

## Data Flow: Fixed Pipeline

```
Connector.sync()
  --> rawEvents (sourceType now correct: 'photo' for photos)
  --> EmbedProcessor
      - connector.embed() produces {type, id, role} entities
      - Contact resolution (unchanged)
      - STORE embed entities in metadata.embedEntities  [NEW]
      - Create memory with correct sourceType
  --> EnrichProcessor
      - Ollama extracts {type, value} entities (improved prompt)
      - EntityNormalizer.normalize(ollamaEntities, embedEntities)  [NEW]
        * Convert embed entities to {type, value} where applicable
        * Dedup: case-insensitive, strip whitespace
        * Validate: remove garbage values, enforce canonical types
        * Clean: remove pronouns, single chars, generic terms
      - Store normalized entities in memories.entities
      - Rest of enrichment unchanged
```

## Data Flow: Source Type Backfill

```
Run: npx tsx apps/api/src/migrations/fix-source-types.ts

  Step 1: SQL UPDATE on memories table
    UPDATE memories SET source_type = 'photo'
    WHERE connector_type = 'photos' AND source_type = 'file'

  Step 2: SQL UPDATE on rawEvents table
    UPDATE raw_events SET source_type = 'photo'
    WHERE connector_type = 'photos' AND source_type = 'file'

  Step 3: Qdrant payload update
    Scroll all points where connector_type = 'photos' AND source_type = 'file'
    Batch set_payload: source_type = 'photo'

  Step 4: Remove SOURCE_TYPE_ALIASES hack from memory.service.ts
```

This is deterministic (no Ollama needed), idempotent, and fast. Follows the pattern established by `backfill-entity-types.ts`.

## Data Flow: Entity Backfill

```
API: POST /api/backfill/entities { batchSize?, connectorType? }

  --> Query memories with embeddingStatus='done', ordered by createdAt
  --> Enqueue to 'backfill' queue in batches
  --> BackfillProcessor per memory:
      1. Read memory text
      2. Call EnrichService.extractEntities() (improved prompt)
      3. Read metadata.embedEntities if present
      4. Run EntityNormalizer.normalize(ollamaEntities, embedEntities)
      5. UPDATE memories.entities
  --> Progress tracked via jobs table + WebSocket events
```

---

## Patterns to Follow

### Pattern 1: Pure Function Normalizer (No DI)

Create `EntityNormalizer` as a stateless module with exported functions, not an injectable service. This allows use in both the pipeline and migration scripts without NestJS bootstrapping.

```typescript
// memory/entity-normalizer.ts
export type EntityType = 'person' | 'organization' | 'location' | 'event' |
  'product' | 'topic' | 'pet' | 'group' | 'device' | 'other';

export interface NormalizedEntity {
  type: EntityType;
  value: string;
}

const CANONICAL_TYPES = new Set<EntityType>([...]);

const GARBAGE_PATTERNS = [
  /^(i|you|we|they|he|she|it|me|my|your|our|them)$/i,
  /^.$/,           // single character
  /^(the|a|an)\s/i, // articles + something generic
  /^https?:\/\//,  // URLs are not entities
];

export function normalizeEntities(
  ollamaEntities: Array<{ type: string; value: string }>,
  embedEntities?: Array<{ type: string; id: string; role: string }>,
): NormalizedEntity[] {
  // 1. Convert embed entities where type is person/organization/location
  // 2. Merge both lists
  // 3. Filter garbage values
  // 4. Dedup by normalized key (type + lowercase trimmed value)
  // 5. Validate types against CANONICAL_TYPES
  // 6. Return clean list
}
```

**Why pure function:** Testable without mocking, usable in migration scripts that run outside NestJS, zero overhead.

### Pattern 2: Migration-as-Script for Deterministic Fixes

Source type reclassification uses a standalone script (like the existing `backfill-entity-types.ts`), not a queue job. The fix is deterministic: every Immich memory with sourceType `file` should be `photo`. No inference needed.

```typescript
// migrations/fix-source-types.ts
// Run with: npx tsx apps/api/src/migrations/fix-source-types.ts
// 1. UPDATE memories SET source_type = 'photo' WHERE connector_type = 'photos' AND source_type = 'file'
// 2. UPDATE raw_events SET source_type = 'photo' WHERE connector_type = 'photos' AND source_type = 'file'
// 3. Qdrant: scroll + batch set_payload for connector_type = 'photos'
```

**Why script not queue:** Fast (<30s), no Ollama dependency, idempotent, matches existing migration pattern.

### Pattern 3: Queue-Based Backfill for Ollama-Dependent Work

Entity re-extraction goes through the existing `backfill` BullMQ queue because it requires Ollama inference (~500ms-2s per memory). The queue provides:
- Concurrency control (don't overwhelm Ollama)
- Progress tracking via jobs table
- Failure retry (3 attempts with exponential backoff)
- Real-time progress via WebSocket

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Adding a Post-Processing Queue Stage

**What:** Creating a new `normalize` queue stage after `enrich`.
**Why bad:** Adds latency to every new memory, increases pipeline complexity. The normalizer runs in <1ms.
**Instead:** Call `normalizeEntities()` synchronously within `EnrichService.enrich()` after Ollama returns.

### Anti-Pattern 2: Creating an Entities Table

**What:** Normalizing entities into a separate `entities` SQL table with foreign keys.
**Why bad:** Over-engineering. The JSON column works fine for the current scale. The problem is data quality, not schema design.
**Instead:** Keep entities as JSON in `memories.entities`, but clean the data going in.

### Anti-Pattern 3: Re-embedding During Entity Backfill

**What:** Re-generating Qdrant vectors when re-extracting entities.
**Why bad:** Embedding is expensive (~200ms per memory) and the text hasn't changed. Entities don't affect the vector -- they're stored in SQLite, not Qdrant payload.
**Instead:** Only update the `entities` column in SQLite. Only source type backfill needs Qdrant payload updates (and those are payload-only, no re-embedding).

### Anti-Pattern 4: Modifying rawEvents.payload

**What:** Changing the `payload` JSON in rawEvents to fix sourceType.
**Why bad:** rawEvents is the immutable audit log. The payload preserves what the connector originally emitted.
**Instead:** Only update `rawEvents.sourceType` column (top-level metadata set by SyncProcessor at write time, not part of the connector's original payload).

---

## Integration Points (Detailed)

### 1. ConnectorDataEvent Type (packages/connector-sdk/src/types.ts)

Current enum: `'email' | 'message' | 'photo' | 'location' | 'file'`

`'photo'` already exists in the type. The photos-immich connector just doesn't use it. No type change needed.

### 2. photos-immich Connector (packages/connectors/photos-immich/src/index.ts)

**Change:** Line 214: `sourceType: 'file'` --> `sourceType: 'photo'`
**Test update:** Line 238 in test: `expect(event.sourceType).toBe('file')` --> `'photo'`
**Risk:** LOW. Only affects new syncs. Backfill handles existing data.

### 3. EnrichService.extractEntities() (apps/api/src/memory/enrich.service.ts)

**Change:** After Ollama returns entities, pipe through `normalizeEntities()`. Read `metadata.embedEntities` from the memory record and pass as second argument.
**Risk:** MEDIUM. Must not break existing entity format consumers (graph viz, search, NLQ).

### 4. Entity Extraction Prompt (apps/api/src/memory/prompts.ts)

**Change:** Add few-shot examples showing correct classification, explicit negative rules (no pronouns, no single chars, no URLs, no generic terms), emphasis on person vs location disambiguation.
**Risk:** LOW. Prompt changes improve quality without changing schema.

### 5. EmbedProcessor Entity Persistence (apps/api/src/memory/embed.processor.ts)

**Change:** After `connector.embed()`, store `embedResult.entities` in the metadata object before inserting the memory record. Key: `embedEntities`.
**Risk:** LOW. Additive field in existing metadata JSON. No schema change.

### 6. Memory Service Alias Removal (apps/api/src/memory/memory.service.ts)

**Change:** Remove `SOURCE_TYPE_ALIASES` object and the mapping logic at line 208-210.
**Risk:** LOW. Must happen AFTER source type backfill, not before.

### 7. QdrantService Payload Update (apps/api/src/memory/qdrant.service.ts)

**Change:** Add `updatePayload(id: string, payload: Record<string, any>)` method using Qdrant's `set_payload` API.
**Risk:** LOW. New method, no changes to existing methods. Qdrant natively supports payload-only updates.

---

## Suggested Build Order

Dependencies constrain ordering:

```
Source Type Chain:
  Phase 1a: Fix photos-immich connector
  Phase 1b: Source type backfill migration (SQLite + Qdrant)
  Phase 1c: Remove SOURCE_TYPE_ALIASES hack
  (1a before 1b -- new syncs correct; 1b before 1c -- search works during transition)

Entity Quality Chain:
  Phase 2a: EntityNormalizer module + tests
  Phase 2b: Improved entity extraction prompt
  Phase 2c: Integrate normalizer into EnrichService
  Phase 2d: Persist embed entities in EmbedProcessor metadata
  (2a before 2c -- normalizer must exist; 2d independent of 2a-2c)

Entity Backfill:
  Phase 3: Backfill entity re-extraction
  (Depends on ALL of Phase 2 -- uses improved prompt + normalizer)
```

### Recommended Phases

**Phase 1: Source Type Reclassification** (~2-4 hours)
- Fix photos-immich connector to emit `'photo'`
- Write + run source type backfill migration
- Add `QdrantService.updatePayload()` method
- Remove `SOURCE_TYPE_ALIASES` hack
- Update tests

**Phase 2: Entity Quality Infrastructure** (~4-6 hours)
- Create `EntityNormalizer` pure function module with tests
- Improve entity extraction prompt with few-shot examples and negative rules
- Integrate EntityNormalizer into EnrichService
- Store embed-step entities in metadata

**Phase 3: Entity Backfill** (~2-4 hours)
- Extend BackfillProcessor for entity re-extraction
- Add API endpoint to trigger entity backfill with progress
- Run backfill, verify results

**Phase 4: Validation** (~1-2 hours)
- Verify photo filtering works in search
- Verify entity quality in graph visualization
- Verify entity-based search returns relevant results
- Verify NLQ "my photos" returns only photos

---

## Scalability Considerations

| Concern | Current (~50K memories) | At 500K memories | At 5M memories |
|---------|------------------------|------------------|----------------|
| Source type backfill (SQL) | <1 sec | <5 sec | Batch in 10K chunks |
| Source type backfill (Qdrant) | Scroll + batch, <30 sec | ~5 min in 1K batches | ~1 hr in 1K batches |
| Entity re-extraction | ~7 hrs at 8 concurrency | ~70 hrs -- skip clean memories | Not feasible full-table |
| EntityNormalizer per-call | <1ms | <1ms | <1ms |

For large datasets, the entity backfill should filter to only memories that need it (e.g., those with garbage entities, missing entities, or specific connector types).

---

## Sources

- Direct code analysis (HIGH confidence):
  - `packages/connector-sdk/src/types.ts` -- ConnectorDataEvent sourceType enum
  - `packages/connectors/photos-immich/src/index.ts:214` -- sourceType: 'file'
  - `packages/connectors/slack/src/sync.ts:386` -- sourceType: 'file' for Slack files
  - `apps/api/src/memory/enrich.service.ts` -- entity extraction pipeline
  - `apps/api/src/memory/embed.processor.ts` -- embed pipeline, entity handling
  - `apps/api/src/memory/prompts.ts` -- ENTITY_FORMAT_SCHEMA and extraction prompt
  - `apps/api/src/memory/memory.service.ts:208` -- SOURCE_TYPE_ALIASES hack
  - `apps/api/src/memory/backfill.processor.ts` -- existing backfill infrastructure
  - `apps/api/src/migrations/backfill-entity-types.ts` -- existing migration pattern
  - `apps/api/src/memory/nlq-parser.ts` -- source type detection in search
  - `apps/api/src/db/schema.ts` -- memories table, entities column definition

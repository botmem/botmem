# Domain Pitfalls: Data Quality & Pipeline Integrity

**Domain:** Entity deduplication, source type reclassification, and data backfill for existing personal memory RAG system
**Researched:** 2026-03-08
**Context:** Adding data quality fixes to a live Botmem system with 7,000+ existing memories, 2,099 photo records stored as `file`, 100+ hallucinated entity types, and a remote Ollama GPU at 192.168.10.250 (RTX 3070)
**Confidence:** HIGH (all findings from direct codebase analysis of schema.ts, enrich.service.ts, embed.processor.ts, qdrant.service.ts, memory.service.ts, nlq-parser.ts, backfill.processor.ts, contacts.service.ts, me.service.ts)

---

## Critical Pitfalls

Mistakes that cause data corruption, lost memories, or require full re-processing.

### Pitfall 1: Qdrant Payload Desync on Source Type Reclassification

**What goes wrong:** Changing `source_type` from `file` to `photo` in the SQLite `memories` table but forgetting to update the corresponding Qdrant vector payload. The embed processor writes `source_type` into Qdrant payload at upsert time (embed.processor.ts lines 197-202). Search filtering builds Qdrant filters from `source_type` via `buildQdrantFilter()` in memory.service.ts. If SQLite says `photo` but Qdrant still says `file`, filtered searches return inconsistent results -- some photo memories found via SQL, invisible via vector search.

**Why it happens:** The system has two sources of truth for `source_type`: SQLite (`memories` table) and Qdrant (vector payload). The QdrantService currently has `upsert()` but NO `setPayload()` or `updatePayload()` method -- there is literally no API wrapper to update a payload field without re-embedding the vector. Developers will update SQLite and assume they are done.

**Consequences:**
- The NLQ parser detects "photos" queries and maps to `sourceType: 'file'` via `SOURCE_TYPE_ALIASES` in memory.service.ts (line 207). After reclassification, this alias must change too. If removed before Qdrant is updated, photo search breaks entirely. If kept, newly synced photos (with correct `photo` type) won't match the `file` alias.
- Graph visualization color-codes by sourceType. Mixed `file`/`photo` values create confusing dual-legend entries.
- The `/me` endpoint counts memories by sourceType -- stats will show split counts.
- The `rawEvents` table also stores `source_type` independently -- three stores to update, not two.

**Prevention:**
1. Add a `setPayload(ids, payload)` method to QdrantService wrapping `client.setPayload()` with filter support.
2. Use Qdrant's batch `setPayload` with a filter (single operation, not 2,099 calls): `client.setPayload(collection, { payload: { source_type: 'photo' }, filter: { must: [{ key: 'source_type', match: { value: 'file' } }, { key: 'connector_type', match: { value: 'photos' } }] } })`.
3. Migration script must update ALL THREE stores atomically: SQLite `memories`, SQLite `rawEvents`, and Qdrant payloads.
4. Update the `SOURCE_TYPE_ALIASES` map in memory.service.ts simultaneously (remove `photo: 'file'` mapping).
5. Post-migration verification: count by `source_type` in both SQLite and Qdrant; assert they match.

**Detection:** Add a health check that samples N random memories and compares SQLite `sourceType` with Qdrant payload `source_type`. Any mismatch = alert.

**Phase:** Must be the FIRST data migration to run. This is a prerequisite for all other work because search filters break on inconsistent types.

---

### Pitfall 2: Re-enrichment Overwhelming Remote Ollama (7,000+ Memories Through Single GPU)

**What goes wrong:** Backfill pipeline enqueues 7,000+ enrich jobs, each making 2 Ollama calls (entity extraction via `qwen3:0.6b` + factuality classification). At default concurrency 8 (`enrich_concurrency` setting), that is 16 concurrent HTTP requests to a single RTX 3070 at `192.168.10.250:11434`. Ollama serializes inference per model, so effective throughput is approximately 1-2 requests/second for `qwen3:0.6b`. Full backfill takes 1-2 hours minimum. During this time:

- New syncs compete for the same Ollama instance, causing timeouts (60s for embed, 180s for generate in ollama.service.ts).
- BullMQ lock duration is 300s (5 minutes) per worker in both embed and enrich processors. If Ollama queues back up, jobs exceed lock duration and BullMQ retries them, creating duplicate enrichments.
- Redis memory grows unboundedly if all 7,000 jobs are enqueued at once.

**Why it happens:** The pipeline was designed for incremental sync (tens to hundreds of items at a time), not bulk re-processing. There is no rate limiting on Ollama calls, no backpressure mechanism, and no priority separation between live sync and backfill work.

**Consequences:**
- Live syncs fail with timeouts while backfill is running -- user triggers a Gmail sync and it fails because Ollama is saturated.
- Duplicate entity extraction when jobs exceed lock duration and retry. Entities get appended or overwritten non-deterministically.
- Race condition on `memories.entities` column if a re-enrich job and a new embed job target the same memory concurrently (not likely but possible during re-sync).
- Redis OOM if entire backlog is enqueued at once without batching.

**Prevention:**
1. Use the existing `backfill` queue (already registered in BullMQ, see memory.module.ts) with dedicated low concurrency (2-3), separate from the `enrich` queue.
2. Enqueue backfill jobs in batches of 50-100 with BullMQ `delay` option between batches. Use an orchestrator job that enqueues the next batch when the current batch completes.
3. Extend BullMQ lock duration for backfill jobs to 600s to match Ollama's worst-case 180s timeout per call (2 calls per job + overhead).
4. Add a "pause on active sync" check: before processing the next backfill job, check if the sync or embed queues have active jobs; if so, delay the backfill job by 30s.
5. Track per-memory completion with an `enrichVersion` column (see Pitfall 4) so backfill can resume after interruption.

**Detection:** Monitor Ollama response times during backfill. If p95 exceeds 30s, auto-reduce backfill concurrency. Track backfill progress via WebSocket `job:progress` events.

**Phase:** Must be built BEFORE any backfill runs. The backfill orchestrator is the first thing to implement.

---

### Pitfall 3: Entity Deduplication False Positives Merging Different Entities

**What goes wrong:** Fuzzy matching on entity values like "Jordan" (person vs. country), "Apple" (company vs. fruit in a photo description), "Amazon" (company vs. river). Entities are stored as `{type, value}` JSON arrays in the `memories.entities` column. A naive deduplication that normalizes "jordan" across all memories would merge a person named Jordan with every mention of the country Jordan, corrupting entity counts and graph links.

**Why it happens:** Entities extracted by `qwen3:0.6b` via the enrich pipeline have inconsistent type classification. The PROJECT.md explicitly states this is a known issue: "names classified as locations/organizations" and "100+ hallucinated types instead of 10 canonical." The same real-world entity appears as different types across memories because the small model hallucinates type assignments.

**Consequences:**
- Entity counts on the `/me` page (me.service.ts line 378-402) become meaningless -- inflated counts for falsely merged entities.
- Memory graph links become nonsensical -- connecting a person-memory to a geography-memory.
- Contact reclassification (`reclassifyEntityTypes` in contacts.service.ts lines 831-923) uses entity type voting from linked memories. If entity types are wrong going in, the voting produces wrong contact types coming out. This is a cascading failure.
- Once entities are merged in the database, separating them is extremely difficult -- it requires tracking the original pre-merge state.

**Prevention:**
1. NEVER deduplicate entities across different types. `{type: "person", value: "Jordan"}` and `{type: "location", value: "Jordan"}` are different entities and must remain so.
2. Deduplicate only WITHIN the same type: case-insensitive, whitespace-normalized, accent-stripped matching (the `stripAccents` function already exists in memory.service.ts).
3. For person-name substring matches ("Amr" vs "Amr Essam"), only merge if one is a clear substring AND they co-occur in the same memory or share a contact link. The existing `nameWordsMatch` function (memory.service.ts line 75) provides a pattern for this.
4. Add a confidence threshold: auto-merge only on exact normalized match. Fuzzy matches (Levenshtein, Jaro-Winkler) should be human-reviewable, similar to the existing MergeTinder UI for contacts.
5. Run deduplication as a read-only analysis FIRST, output a merge plan, then apply after review.
6. Keep an undo log: store the pre-merge state of every modified entity array so merges can be reversed.

**Detection:** Before applying any dedup, generate a report showing what would be merged. Flag any cross-type merges as errors. Flag any merge affecting >50 memories as suspicious.

**Phase:** Entity deduplication must come AFTER entity type taxonomy is enforced AND backfill is complete. Running dedup on dirty data is wasted effort.

---

### Pitfall 4: Modifying the Pipeline While It Is Actively Processing

**What goes wrong:** Deploying a new version of `enrich.service.ts` (with corrected entity extraction prompts or the `ENTITY_FORMAT_SCHEMA` structured output) while the enrich queue still has pending jobs from a live sync. Some memories get enriched with the old prompt (producing 100+ unconstrained types), some with the new prompt (producing 10 canonical types via structured output). The result is inconsistent entity formats within the same sync batch.

**Why it happens:** NestJS hot-reload replaces the service instance, but BullMQ workers pick up the new code on their next job. There is no versioning on the enrichment pipeline -- you cannot tell if a memory was enriched with v1 (unconstrained) or v2 (schema-constrained) of the prompt. The `memories` table has no column to track this.

**Consequences:**
- Entities from the old prompt may use any of 100+ types while the new prompt enforces the 10-type taxonomy via `ENTITY_FORMAT_SCHEMA`. Mixed formats in the same batch.
- Entity deduplication later has to handle both formats, multiplying complexity.
- No way to identify which memories need re-enrichment because there is no enrichment version marker.
- The `me.service.ts` entity aggregation (line 387) tries to read both `entity.name` and `entity.value` fields, indicating this dual-format problem already exists.

**Prevention:**
1. Add an `enrichVersion` integer column to the `memories` table (default 0 for all existing memories, increment for each pipeline schema change).
2. Before deploying pipeline changes, drain the enrich queue (`queue.drain()` or wait for completion).
3. Backfill targets memories WHERE `enrichVersion < CURRENT_VERSION`, making re-enrichment idempotent and resumable.
4. After successful re-enrichment of a memory, UPDATE its `enrichVersion` to the current version.
5. Never change prompts and deploy mid-sync. Sequence: finish pending syncs, deploy new code, then trigger backfill.

**Detection:** Query `SELECT COUNT(*), entities FROM memories GROUP BY enrichVersion` (once column exists). Before that, check for format inconsistencies: entities with `name` field vs `value` field, non-canonical types, etc.

**Phase:** The `enrichVersion` column should be added in the FIRST schema migration, before any pipeline changes. This is a zero-risk, zero-downtime addition.

---

## Moderate Pitfalls

### Pitfall 5: SQLite Write Contention During Bulk Updates

**What goes wrong:** SQLite in WAL mode handles concurrent reads well, but a bulk UPDATE of 7,000 rows on the `memories` table (for entity normalization or source type fix) can hold the write lock for several seconds. If a live sync's embed processor tries to INSERT a new memory during this window, it blocks and may timeout. The `better-sqlite3` driver is synchronous, so a long transaction blocks the Node.js event loop entirely.

**Prevention:**
- Batch updates: UPDATE 100 rows at a time with `await new Promise(r => setTimeout(r, 10))` between batches to yield the event loop and release the write lock.
- Use `better-sqlite3` transactions for batched updates (as the existing `backfill-entity-types.ts` migration does), but keep transaction scope small (100 rows, not 7,000).
- Schedule bulk migrations during low-activity periods or pause sync workers before running.
- The existing migration script (`backfill-entity-types.ts`) wraps ALL rows in a single transaction -- this is fast but blocks all writes for the entire duration. For small datasets this is acceptable; for 7,000+ rows, batch it.

**Phase:** Every migration script must use batched transactions with configurable batch size.

---

### Pitfall 6: Dual Entity Format (Embed Step vs Enrich Step)

**What goes wrong:** The embed step (embed.processor.ts) gets entities from `connector.embed()` with format `{type, id, role}` (used for contact resolution, e.g., `{type: "person", id: "email:john@example.com|name:John", role: "sender"}`). The enrich step (enrich.service.ts line 69-73) extracts entities with format `{type, value}` and OVERWRITES the entire `entities` column with `JSON.stringify(entities)`. This means:

- Entities from the embed step (with `id` and `role` fields useful for contact linking) are permanently lost after enrich runs.
- The `me.service.ts` reads entities expecting BOTH `name` and `value` fields (line 389: `entity.name || entity.value`), confirming both formats exist in production data.
- Any migration normalizing entities must handle at least three shapes: `{type, value}`, `{type, id, role}`, and `{type, name}`.

**Prevention:**
1. Unify to a single canonical format: `{type: string, value: string}` everywhere. This is what the `ENTITY_FORMAT_SCHEMA` already enforces for the enrich step.
2. The enrich step should MERGE new entities with existing ones, not blindly replace. Read current entities, add new enrich-extracted ones, deduplicate by (type, normalized value), then write.
3. Before backfill, run a normalization migration that converts ALL existing entity JSON arrays to `{type, value}` format (mapping `id` -> `value`, `name` -> `value`).

**Phase:** Entity format unification must happen BEFORE backfill runs. It is a prerequisite -- otherwise the backfill produces entities in the new format mixed with old-format entities from the embed step.

---

### Pitfall 7: NLQ Source Type Alias Becomes Stale or Inconsistent

**What goes wrong:** The `SOURCE_TYPE_ALIASES` map in memory.service.ts (line 207) currently maps `photo` -> `file` because photos are stored with `source_type: 'file'`. After reclassification to `photo`, this alias must be removed. But if the migration is partial (some photos still `file`, some now `photo`), removing the alias breaks search for un-migrated photos, and keeping it breaks search for migrated ones. Users searching for "my photos from January" get zero or partial results.

**Prevention:**
- Reclassification must be atomic: ALL photo records get updated in one migration (SQLite + rawEvents + Qdrant), then the alias is removed in the same deployment.
- If partial migration is unavoidable, temporarily change the NLQ parser to search for BOTH `file` AND `photo` when user queries for "photos" (use a Qdrant `should` filter with both values, not a single `match`).
- Post-migration verification: `SELECT COUNT(*) FROM memories WHERE connector_type = 'photos' AND source_type = 'file'` must return 0 before the alias is removed.

**Phase:** Source type reclassification phase. Must be treated as an atomic operation. Deploy code change (alias removal) only after migration is verified complete.

---

### Pitfall 8: Memory Links Pollution During Re-enrichment

**What goes wrong:** The `createLinks()` method in enrich.service.ts (lines 153-200) finds similar memories via Qdrant `recommend()` and creates `memoryLinks` entries. It checks `result.id !== memoryId` but does NOT check for existing links between the same pair of memories. Re-enriching 7,000 memories creates up to 35,000 NEW link entries (up to 5 per memory), duplicating links that already exist from the original enrichment. The `memory_links` table has no unique constraint on `(src_memory_id, dst_memory_id)`.

**Prevention:**
1. Add a deduplication check in `createLinks()`: before INSERT, query for existing link WHERE `src_memory_id = ? AND dst_memory_id = ?` (or the reverse direction). Skip if exists.
2. Better: skip link creation entirely during backfill re-enrichment by adding a `skipLinks` parameter to `enrich()`. Links were already created during initial enrichment and are still valid (vectors haven't changed).
3. If links must be refreshed (e.g., because link types should be updated based on new factuality labels), DELETE existing links for the memory first, then recreate.
4. Consider adding a unique index on `(src_memory_id, dst_memory_id)` to the `memory_links` table and using INSERT OR IGNORE.

**Detection:** Check `SELECT COUNT(*) FROM memory_links` before and after backfill. If it more than doubles, links are being duplicated.

**Phase:** Backfill orchestrator must have a `skipLinks: true` flag for re-enrichment runs.

---

### Pitfall 9: Backfill Cannot Resume After Interruption

**What goes wrong:** If the backfill crashes at memory #3,500 of 7,000 (Ollama goes down, Redis restarts, Node process killed), there is no way to know which memories were already re-enriched. Re-running the backfill processes all 7,000 again, wasting 1+ hours of Ollama compute, creating duplicate links (Pitfall 8), and potentially overwriting good re-enriched data with redundant re-enriched data.

**Prevention:**
1. The `enrichVersion` column from Pitfall 4 solves this: backfill targets `WHERE enrich_version < TARGET_VERSION`. After successful re-enrichment, update the memory's `enrichVersion`. Restarting the backfill automatically skips already-processed memories.
2. Backfill progress should be tracked in the `jobs` table with a parent job entry showing `progress/total`, enabling the frontend to display progress via existing WebSocket infrastructure.
3. BullMQ's built-in retry mechanism (already configured with `attempts: 3, backoff: exponential` in embed.processor.ts) should be leveraged for individual job failures, but the orchestrator must handle batch-level resume.

**Phase:** Must be built into the backfill orchestrator from day one. Non-negotiable for a multi-hour operation.

---

### Pitfall 10: rawEvents Table Also Stores source_type

**What goes wrong:** The `rawEvents` table has its own `source_type` column (schema.ts line 55) that is set at sync time and never updated. After reclassifying `memories.source_type` from `file` to `photo`, the `rawEvents` table still says `file`. If any code reads `rawEvents.sourceType` (e.g., the embed processor at line 108 uses `event.sourceType` from the parsed payload, and the backfill processor parses the raw event payload), it will get the old `file` value and potentially re-create memories with the wrong type.

**Prevention:**
1. Update `rawEvents.source_type` in the same migration that updates `memories.source_type`.
2. Audit all code paths that read sourceType from rawEvents or from the parsed payload (the raw event JSON also contains `sourceType`). The embed processor creates new memory records using `event.sourceType` (line 108), meaning the embedded payload JSON is ALSO a source of truth that cannot be easily updated.
3. For the payload JSON: either update it in the migration (parse, modify, re-serialize for 2,099 rows) or add a runtime override in the embed processor that maps `file` -> `photo` when `connectorType === 'photos'`.
4. Best approach: fix the source at the connector level (photos connector should emit `sourceType: 'photo'` instead of `file`), update the rawEvents column, update the memories column, update Qdrant payloads. Four stores, not two.

**Phase:** Must be part of the source type reclassification phase. All four stores must be addressed.

---

## Minor Pitfalls

### Pitfall 11: Empty and Garbage Entity Values

**What goes wrong:** Entity extraction via `qwen3:0.6b` sometimes returns entities with empty values (`{type: "person", value: ""}`), single characters, ISO date strings disguised as entities (`{type: "event", value: "2024-01-15"}`), or metadata fragments. These pollute entity counts on the `/me` page and create noise in deduplication.

**Prevention:**
- Add validation in `extractEntities()` (enrich.service.ts): reject entities where `value.trim().length < 2`, value matches ISO date pattern, value is purely numeric, or value is a common stopword.
- Apply the same validation filter during the backfill normalization step.
- The existing migration script (`backfill-entity-types.ts`) already filters `REMOVE_TYPES` (time, amount, metric) but does NOT filter empty/garbage values. Extend it.

**Phase:** Add to entity extraction prompt improvements and as a code-level post-extraction filter.

---

### Pitfall 12: Contact Reclassification Based on Dirty Entity Data

**What goes wrong:** The `reclassifyEntityTypes()` method (contacts.service.ts line 831-923) uses entity type voting from linked memories to determine if a contact is really a person, organization, location, etc. The voting logic counts how many times a contact's name appears as each entity type across linked memories. If entity types are wrong (pre-backfill data with 100+ hallucinated types), the voting produces wrong results. For example, "Apple" might be classified as a fruit topic because the old model tagged it that way 3 times vs. 2 times as "organization."

**Prevention:**
- Contact reclassification must run AFTER: (1) entity type taxonomy enforcement, (2) backfill re-enrichment with corrected prompts, and (3) entity deduplication.
- Add a "dry run" mode that shows proposed reclassifications without applying them.
- The existing safeguards (requiring 3x ratio of non-person to person counts, minimum 2 occurrences) are good but insufficient when the underlying entity types are garbage.

**Phase:** Contact reclassification is the LAST step in the data quality pipeline, after all entity data is clean.

---

### Pitfall 13: Qdrant Indexing Pressure During Bulk Payload Updates

**What goes wrong:** Updating 2,099 Qdrant point payloads (for photo source_type fix) triggers re-indexing on the `source_type` payload field. If done as 2,099 individual `setPayload` calls, each triggers incremental index updates, causing CPU spikes and potential timeouts on the Qdrant container.

**Prevention:**
- Use Qdrant's filter-based batch `set_payload` as described in Pitfall 1 (single operation, not per-point).
- Verify with `getCollectionInfo()` that collection status returns to `green` (indexing complete) before running searches that depend on the updated payload values.
- The existing `ensureIndexed()` method (qdrant.service.ts) sets `indexing_threshold: 1000`. With 7,000+ points, HNSW indexing is already active, so payload updates will trigger incremental re-indexing but not a full rebuild.

**Phase:** Source type reclassification phase. Use the filter-based batch approach.

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Schema prerequisites | Missing enrichVersion column (Pitfall 4) | Add column FIRST, before any pipeline changes |
| Schema prerequisites | Missing QdrantService.setPayload (Pitfall 1) | Add method FIRST, before any data migration |
| Source type reclassification | Qdrant/SQLite/rawEvents desync (Pitfalls 1, 10) | Update all four stores atomically (memories, rawEvents, rawEvent payload, Qdrant) |
| Source type reclassification | NLQ alias staleness (Pitfall 7) | Remove alias only after ALL records migrated and verified |
| Source type reclassification | Qdrant indexing pressure (Pitfall 13) | Use filter-based batch update, verify indexing completes |
| Entity format unification | Dual format loss (Pitfall 6) | Normalize ALL entities to {type, value} before anything else |
| Entity type taxonomy enforcement | Garbage values slip through (Pitfall 11) | Add post-extraction validation filters |
| Backfill pipeline | Ollama overload (Pitfall 2) | Separate queue, concurrency 2-3, batch enqueuing, pause during live syncs |
| Backfill pipeline | Cannot resume (Pitfall 9) | Use enrichVersion column to track per-memory completion |
| Backfill pipeline | Link duplication (Pitfall 8) | Add skipLinks flag to enrich(), add unique constraint on links |
| Backfill pipeline | Pipeline version mismatch (Pitfall 4) | Drain queues before deploying new prompts |
| Backfill pipeline | SQLite contention (Pitfall 5) | Batch 100 rows per transaction, yield between batches |
| Entity deduplication | False positive merges (Pitfall 3) | Never merge across types, exact-match for auto, human review for fuzzy |
| Contact reclassification | Bad input data (Pitfall 12) | Run LAST after all entity data is clean; dry run first |

## Recommended Phase Ordering (Derived from Pitfall Dependencies)

The pitfall analysis strongly constrains the execution order. Each step depends on the previous step's data quality:

1. **Schema & tooling prerequisites** -- Add `enrichVersion` column to memories. Add `setPayload()` to QdrantService. Fix photos connector to emit `sourceType: 'photo'`. (Zero-risk additions, unblock everything else.)

2. **Source type reclassification** -- Fix `file` -> `photo` in all four stores (memories, rawEvents, rawEvent payloads, Qdrant). Remove NLQ alias. Verify counts match. (Independent of entity work, high-value, relatively simple.)

3. **Entity format unification** -- Normalize all entity JSON to canonical `{type, value}` format. Remove garbage values. (Must precede taxonomy enforcement to have clean input data.)

4. **Pipeline improvements** -- Update prompts with structured output schema, add validation filters, build backfill orchestrator with batching + resume support + skipLinks flag. Deploy new pipeline code. (Must precede backfill execution.)

5. **Backfill execution** -- Re-enrich all memories with `enrichVersion < TARGET`. Rate-limited, resumable, separate queue. (Must complete before dedup can work on consistent data.)

6. **Entity deduplication** -- Deduplicate within same type only. Exact-match auto-merge, fuzzy human review. (Only meaningful after backfill produces clean, consistently-typed entities.)

7. **Contact reclassification** -- Re-run entity type voting on clean data. Dry run first. (Only accurate after entity dedup provides correct voting data.)

**Violating this order multiplies work:** running dedup before backfill means deduplicating dirty data, then re-deduplicating after backfill. Running contact reclassification before entity cleanup means wrong classifications that must be re-done.

## Sources

- Direct codebase analysis (all findings HIGH confidence):
  - `apps/api/src/db/schema.ts` -- table definitions, column types, no unique constraint on memory_links
  - `apps/api/src/memory/enrich.service.ts` -- entity extraction, factuality, link creation, entity overwrite behavior
  - `apps/api/src/memory/embed.processor.ts` -- Qdrant payload structure, entity format from connector.embed()
  - `apps/api/src/memory/qdrant.service.ts` -- no setPayload method, upsert-only API
  - `apps/api/src/memory/ollama.service.ts` -- timeout configuration (60s embed, 180s generate), retry logic
  - `apps/api/src/memory/memory.service.ts` -- SOURCE_TYPE_ALIASES, search filtering, entity resolution
  - `apps/api/src/memory/prompts.ts` -- ENTITY_FORMAT_SCHEMA with 10 canonical types
  - `apps/api/src/memory/nlq-parser.ts` -- source type detection mapping
  - `apps/api/src/memory/backfill.processor.ts` -- existing backfill infrastructure
  - `apps/api/src/contacts/contacts.service.ts` -- reclassifyEntityTypes voting logic
  - `apps/api/src/me/me.service.ts` -- dual entity format evidence (name || value)
  - `apps/api/src/migrations/backfill-entity-types.ts` -- existing migration pattern
- `.planning/PROJECT.md` -- v2.1 milestone definition, known issues

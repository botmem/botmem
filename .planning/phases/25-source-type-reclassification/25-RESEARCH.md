# Phase 25: Source Type Reclassification - Research

**Researched:** 2026-03-08
**Domain:** Source type classification fix in personal memory RAG pipeline
**Confidence:** HIGH

## Summary

Phase 25 is a surgical data correction phase. The photos-immich connector currently emits `sourceType: 'file'` instead of `'photo'`, causing photo memories to share the same source type as Slack file attachments. A workaround hack (`SOURCE_TYPE_ALIASES`) in the memory service maps NLQ `photo` queries to `file`, which returns both photos and Slack files in search results.

The fix requires changes in exactly four places: (1) the connector emit call, (2) SQLite memories table, (3) Qdrant vector payloads, and (4) the alias hack removal. The `rawEvents` table also has a `source_type` column that should be updated for consistency, though it is a metadata column not a JSON payload field (the out-of-scope note about rawEvents immutability refers to the `payload` JSON column, not the `source_type` column).

**Primary recommendation:** Fix the connector first (SRC-01), then run a migration script that atomically updates SQLite memories + rawEvents + Qdrant payloads (SRC-02, SRC-03), then remove the alias hack (SRC-04) -- all in a single deployment.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SRC-01 | Photos connector emits `photo` source type instead of `file` | One-line change at `packages/connectors/photos-immich/src/index.ts:214`, plus test update at line 238 |
| SRC-02 | Existing photo memories reclassified from `file` to `photo` in SQLite | SQL UPDATE on `memories` and `rawEvents` tables WHERE `connector_type = 'photos'` AND `source_type = 'file'` |
| SRC-03 | Qdrant vector payloads updated with corrected `source_type` for photos | Qdrant JS client v1.17.0 has `setPayload()` with filter support -- single batch call, no re-embedding needed |
| SRC-04 | `SOURCE_TYPE_ALIASES` hack removed from NLQ parser and memory service | Remove lines 208-210 in `memory.service.ts` -- the alias is ONLY in memory.service.ts, not in nlq-parser.ts |
</phase_requirements>

## Standard Stack

### Core (Already in Project)

| Library | Version | Purpose | Relevant API |
|---------|---------|---------|--------------|
| `@qdrant/js-client-rest` | 1.17.0 | Vector DB client | `client.setPayload(collection, {payload, filter})` |
| `better-sqlite3` | (project dep) | SQLite driver | Direct SQL for migration script |
| `drizzle-orm` | (project dep) | ORM for application code | Schema type already allows `'photo'` |

### No New Dependencies Needed

This phase requires zero new packages. All tools are already available.

## Architecture Patterns

### Source Type Flow (Current)

```
Connector.sync() emits ConnectorDataEvent.sourceType
  --> SyncProcessor writes to rawEvents.source_type column
  --> EmbedProcessor reads event.sourceType
      --> Writes to memories.source_type column
      --> Writes to Qdrant payload { source_type: '...' }
  --> Memory search uses:
      --> NLQ parser detects "photo" from query text
      --> SOURCE_TYPE_ALIASES maps "photo" -> "file"
      --> buildQdrantFilter matches Qdrant source_type
      --> SQL WHERE also checks memories.sourceType
```

### Files to Modify (Exhaustive List)

| File | Change | Risk |
|------|--------|------|
| `packages/connectors/photos-immich/src/index.ts:214` | `sourceType: 'file'` -> `sourceType: 'photo'` | LOW -- `ConnectorDataEvent.sourceType` already includes `'photo'` in the union type |
| `packages/connectors/photos-immich/src/__tests__/immich.test.ts:238` | Update assertion from `'file'` to `'photo'` | LOW |
| `apps/api/src/memory/memory.service.ts:208-210` | Remove `SOURCE_TYPE_ALIASES` constant and the mapping logic | LOW -- must happen AFTER backfill |
| `apps/api/src/memory/qdrant.service.ts` | Add `setPayload()` method wrapping `client.setPayload()` | LOW -- additive, no existing behavior changed |
| New: `apps/api/src/migrations/backfill-source-types.ts` | Migration script for SQLite + Qdrant | MEDIUM -- must be correct on first run |

### Migration Script Pattern

Follow the existing pattern from `apps/api/src/migrations/backfill-entity-types.ts`:
- Standalone script run with `npx tsx apps/api/src/migrations/backfill-source-types.ts`
- Direct `better-sqlite3` for SQLite updates (not through NestJS)
- For Qdrant: instantiate `QdrantClient` directly (not through NestJS DI)
- Wrap SQLite changes in a transaction
- Print counts before and after for verification

### Execution Order (Critical)

```
1. Fix connector (SRC-01)           -- new syncs produce correct type
2. Add QdrantService.setPayload()   -- infrastructure for backfill
3. Run backfill migration (SRC-02 + SRC-03)
   a. SQLite: UPDATE memories SET source_type = 'photo' WHERE connector_type = 'photos' AND source_type = 'file'
   b. SQLite: UPDATE raw_events SET source_type = 'photo' WHERE connector_type = 'photos' AND source_type = 'file'
   c. Qdrant: setPayload with filter { connector_type = 'photos', source_type = 'file' } -> { source_type: 'photo' }
4. Remove SOURCE_TYPE_ALIASES (SRC-04) -- alias no longer needed
```

Steps 1 and 4 can be in the same code commit, but step 4 must NOT take effect before step 3 completes. In practice, since the migration script runs separately before deployment, committing all code changes together is safe as long as the migration runs first.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Qdrant payload updates | Scroll + delete + re-insert with vector | `client.setPayload()` with filter | Single API call updates all matching points without touching vectors |
| Per-point Qdrant updates | Loop over memory IDs calling setPayload one by one | Batch setPayload with filter condition | One call vs potentially thousands |

## Common Pitfalls

### Pitfall 1: Forgetting Qdrant (SQLite-only fix)
**What goes wrong:** SQLite memories updated to `photo` but Qdrant payloads still say `file`. Search uses Qdrant filter first, then SQLite, so photo searches return nothing.
**How to avoid:** Migration script MUST update both stores. Verify with count queries on both after migration.

### Pitfall 2: Removing Alias Before Backfill
**What goes wrong:** If `SOURCE_TYPE_ALIASES` is removed before Qdrant/SQLite are updated, searching "my photos" maps to `source_type = 'photo'` but all existing data still has `'file'`. Zero results.
**How to avoid:** Backfill migration runs BEFORE the alias removal code ships. Since the migration is a standalone script, run it first, then deploy the code.

### Pitfall 3: Missing rawEvents Update
**What goes wrong:** `rawEvents.source_type` still says `file` for photos. If any future code re-processes raw events (like the backfill pipeline in Phase 27), it will recreate memories with wrong source type.
**How to avoid:** Update `rawEvents.source_type` in the same migration. Note: the `rawEvents.payload` JSON is immutable (per v2.1 out-of-scope rules), but the `source_type` COLUMN is metadata that should be corrected.

### Pitfall 4: Slack Files Affected by Overly Broad Update
**What goes wrong:** SQL update `WHERE source_type = 'file'` without `connector_type = 'photos'` condition accidentally reclassifies Slack file attachments to `photo`.
**How to avoid:** Always filter by BOTH `source_type = 'file'` AND `connector_type = 'photos'` in all update queries.

### Pitfall 5: NLQ Parser Confusion
**What goes wrong:** The requirements mention "SOURCE_TYPE_ALIASES hack removed from NLQ parser and memory service" but the alias is ONLY in `memory.service.ts:208`. The NLQ parser (`nlq-parser.ts`) has `SOURCE_TYPE_MAP` which correctly maps "photos" -> `'photo'`. This is NOT a hack and should NOT be removed.
**How to avoid:** Only remove the `SOURCE_TYPE_ALIASES` object in `memory.service.ts`. Leave `nlq-parser.ts` unchanged -- its `SOURCE_TYPE_MAP` correctly produces `'photo'` which will now match the database directly.

## Code Examples

### SRC-01: Connector Fix
```typescript
// packages/connectors/photos-immich/src/index.ts line 213-214
// BEFORE:
this.emitData({
  sourceType: 'file',
  // ...

// AFTER:
this.emitData({
  sourceType: 'photo',
  // ...
```

### QdrantService.setPayload() Method
```typescript
// apps/api/src/memory/qdrant.service.ts -- new method
async setPayload(
  payload: Record<string, unknown>,
  filter: Record<string, unknown>,
): Promise<void> {
  await this.client.setPayload(QdrantService.COLLECTION, {
    payload,
    filter,
    wait: true,
  });
}
```

### Backfill Migration Script
```typescript
// apps/api/src/migrations/backfill-source-types.ts
import Database from 'better-sqlite3';
import { QdrantClient } from '@qdrant/js-client-rest';
import { resolve } from 'path';

const dbPath = resolve(process.env.DB_PATH || './data/botmem.db');
const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Count before
const before = db.prepare(
  `SELECT source_type, COUNT(*) as cnt FROM memories WHERE connector_type = 'photos' GROUP BY source_type`
).all();
console.log('Before:', before);

// SQLite updates in transaction
const tx = db.transaction(() => {
  const m = db.prepare(
    `UPDATE memories SET source_type = 'photo' WHERE connector_type = 'photos' AND source_type = 'file'`
  ).run();
  console.log(`memories updated: ${m.changes}`);

  const r = db.prepare(
    `UPDATE raw_events SET source_type = 'photo' WHERE connector_type = 'photos' AND source_type = 'file'`
  ).run();
  console.log(`raw_events updated: ${r.changes}`);
});
tx();

// Qdrant update (single batch call with filter)
const qdrant = new QdrantClient({ url: qdrantUrl });
await qdrant.setPayload('memories', {
  payload: { source_type: 'photo' },
  filter: {
    must: [
      { key: 'source_type', match: { value: 'file' } },
      { key: 'connector_type', match: { value: 'photos' } },
    ],
  },
  wait: true,
});
console.log('Qdrant payloads updated');

// Verify
const after = db.prepare(
  `SELECT source_type, COUNT(*) as cnt FROM memories WHERE connector_type = 'photos' GROUP BY source_type`
).all();
console.log('After:', after);

db.close();
```

### SRC-04: Alias Removal
```typescript
// apps/api/src/memory/memory.service.ts lines 206-211
// BEFORE:
    // Apply source type hint from NLQ (only if caller didn't provide explicit sourceType)
    // Map user-friendly NLQ terms to actual DB source_type values
    const SOURCE_TYPE_ALIASES: Record<string, string> = { photo: 'file' };
    if (nlq.sourceTypeHint && !filters?.sourceType) {
      effectiveFilters.sourceType = SOURCE_TYPE_ALIASES[nlq.sourceTypeHint] ?? nlq.sourceTypeHint;
    }

// AFTER:
    // Apply source type hint from NLQ (only if caller didn't provide explicit sourceType)
    if (nlq.sourceTypeHint && !filters?.sourceType) {
      effectiveFilters.sourceType = nlq.sourceTypeHint;
    }
```

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 3 |
| Config file | `apps/api/vitest.config.ts`, `packages/connectors/photos-immich/vitest.config.ts` |
| Quick run command | `pnpm --filter @botmem/connector-photos-immich test` |
| Full suite command | `pnpm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SRC-01 | Photos connector emits `photo` source type | unit | `pnpm --filter @botmem/connector-photos-immich test` | Yes -- update assertion at line 238 |
| SRC-02 | SQLite memories reclassified | integration | `npx tsx apps/api/src/migrations/backfill-source-types.ts` (verify counts) | No -- Wave 0 |
| SRC-03 | Qdrant payloads updated | integration | Part of migration script verification | No -- Wave 0 |
| SRC-04 | Alias hack removed, photo search still works | unit | `pnpm --filter api test -- nlq-parser` | Yes -- existing tests verify NLQ produces `photo` |

### Sampling Rate
- **Per task commit:** `pnpm --filter @botmem/connector-photos-immich test && pnpm --filter api test -- nlq-parser`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] Migration script itself (`apps/api/src/migrations/backfill-source-types.ts`) -- covers SRC-02, SRC-03
- [ ] `QdrantService.setPayload()` method -- infrastructure for SRC-03

*(Existing tests for nlq-parser and immich connector already cover the behavioral assertions, just need value updates)*

## Open Questions

1. **Should rawEvents.source_type be updated?**
   - What we know: The v2.1 out-of-scope says "rawEvents payload JSON mutation -- Treat rawEvents as immutable audit log." However, `source_type` is a column, not inside the payload JSON. Phase 27 (backfill) will re-process raw events, and if source_type is wrong there, it could propagate bad data.
   - Recommendation: Update `rawEvents.source_type` column. This is NOT payload mutation -- it is metadata correction. The existing research (PITFALLS.md) also recommends this.

2. **What about the `ConnectorDataEvent.sourceType` type union?**
   - What we know: The type at `packages/connector-sdk/src/types.ts:64` already includes `'photo'` in the union: `'email' | 'message' | 'photo' | 'location' | 'file'`. No type changes needed.
   - Status: Resolved -- no action needed.

## Sources

### Primary (HIGH confidence)
- Direct codebase analysis of all files listed above
- `packages/connector-sdk/src/types.ts:64` -- `ConnectorDataEvent.sourceType` type definition
- `packages/connectors/photos-immich/src/index.ts:214` -- current `'file'` emission
- `apps/api/src/memory/memory.service.ts:208` -- `SOURCE_TYPE_ALIASES` hack location
- `apps/api/src/memory/nlq-parser.ts:46-48` -- `SOURCE_TYPE_MAP` (correctly produces `'photo'`)
- `apps/api/src/memory/embed.processor.ts:108,197-202` -- sourceType flow to memories + Qdrant
- `apps/api/src/memory/qdrant.service.ts` -- current API (no setPayload method yet)
- `@qdrant/js-client-rest@1.17.0` type definitions -- `setPayload()` method confirmed available
- `apps/api/src/migrations/backfill-entity-types.ts` -- existing migration script pattern

### Secondary (MEDIUM confidence)
- `.planning/research/ARCHITECTURE.md` -- prior v2.1 research confirming the same analysis
- `.planning/research/PITFALLS.md` -- prior research on dual-store consistency risks

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all tools already in project, no new dependencies
- Architecture: HIGH -- direct codebase inspection, exact line numbers identified
- Pitfalls: HIGH -- prior research in PITFALLS.md confirmed through independent analysis

**Research date:** 2026-03-08
**Valid until:** Indefinitely (this is a one-time data fix, not dependent on external library versions)

# Phase 28: Verification - Research

**Researched:** 2026-03-09
**Domain:** End-to-end data quality verification (search, graph, NLQ, entity pipeline)
**Confidence:** HIGH

## Summary

Phase 28 is a verification-only phase -- no code changes required. It validates that the data quality fixes from Phases 25-27 (source type reclassification, entity format/quality, data backfill) produce correct end-to-end behavior. The verification involves four concrete checks: (1) fresh re-sync produces correct source types and clean entities without backfill, (2) photo search returns only photos, (3) the memory graph shows clean deduplicated entities, and (4) NLQ queries use `photo` source type directly.

All prerequisite code changes are already in place. The `SOURCE_TYPE_ALIASES` hack has been confirmed removed from the codebase (zero occurrences in `apps/api/src/`). The photos-immich connector emits `sourceType: 'photo'`. The NLQ parser's `SOURCE_TYPE_MAP` maps `\bphotos?\b` to `'photo'` and passes it through directly. The entity normalizer enforces the 10-type canonical taxonomy with garbage filtering and deduplication. The enrich service uses `normalizeEntities()` for all entity extraction.

**Primary recommendation:** This phase should be planned as a single verification plan with 4 tasks (one per VER requirement), each performing live API queries and inspecting results. No code changes expected -- if issues are found, they should be documented and tracked as bugs, not fixed inline.

<phase_requirements>

## Phase Requirements

| ID     | Description                                                                     | Research Support                                                                                                                                                                                                                                                                         |
| ------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VER-01 | Fresh re-sync produces correct source types and clean entities without backfill | Photos connector emits `sourceType: 'photo'` (confirmed in `packages/connectors/photos-immich/src/index.ts:214`). Embed processor passes `event.sourceType` directly to memory record and Qdrant payload. Entity normalizer is wired into both embed and enrich pipelines.               |
| VER-02 | Photo search returns only photos (not Slack file attachments)                   | NLQ parser maps `\bphotos?\b` to `'photo'` source type hint. Memory service passes `sourceTypeHint` directly to `effectiveFilters.sourceType` (no alias). Qdrant filter uses `source_type` match. `SOURCE_TYPE_ALIASES` confirmed removed.                                               |
| VER-03 | Entity graph shows deduplicated, correctly-typed entities                       | Entity normalizer enforces canonical types via `TYPE_MAP` + `canonicalSet`. Deduplication by `type::lowercaseValue` key. Garbage filtering strips pronouns, generic terms, URLs, single chars. Graph building reads entities from memory metadata and displays as entity names on nodes. |
| VER-04 | NLQ queries for photos use `photo` source type naturally                        | `nlq-parser.ts` `SOURCE_TYPE_MAP` produces `sourceTypeHint: 'photo'`. Memory service `search()` at line 258-259 sets `effectiveFilters.sourceType = nlq.sourceTypeHint` directly. No alias resolution anywhere in the path.                                                              |

</phase_requirements>

## Verification Approach

This is NOT a coding phase. It is an end-to-end validation phase that tests the live system.

### What Must Be Verified

| VER ID | Verification Method                                                                                                                                       | Data Needed                                        |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| VER-01 | Trigger a fresh re-sync of a connector (e.g., Gmail), inspect resulting memories in SQLite for correct `sourceType` and clean `entities` JSON             | An active connector account with valid credentials |
| VER-02 | Search API call `GET /api/memories/search?q=photos` and inspect results -- all should have `sourceType: 'photo'`, none should be Slack `file` attachments | Existing photo and Slack data in database          |
| VER-03 | Fetch graph data via `GET /api/memories/graph` and inspect entity nodes -- check for canonical types, no duplicates per memory, no garbage values         | Enriched memories with entities in database        |
| VER-04 | Search API call `GET /api/memories/search?q=show+me+photos+from+last+week` and inspect `parsed.sourceType` in response -- should be `'photo'`             | NLQ-enabled search endpoint                        |

### Verification Commands

**VER-01: Fresh re-sync verification**

```bash
# Trigger sync via API (requires auth token)
curl -X POST http://localhost:12412/api/jobs/sync \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"accountId": "<ACCOUNT_ID>"}'

# After sync completes, check new memories
curl http://localhost:12412/api/memories/search?q=recent \
  -H "Authorization: Bearer $TOKEN" | jq '.items[] | {sourceType, entities: (.entities | fromjson | length)}'
```

**VER-02: Photo search isolation**

```bash
curl "http://localhost:12412/api/memories/search?q=photos" \
  -H "Authorization: Bearer $TOKEN" | jq '.items[] | {sourceType, connectorType, text: .text[:60]}'
# Expected: all sourceType == "photo", all connectorType == "photos"
# Fail if: any sourceType == "file" or connectorType == "slack"
```

**VER-03: Graph entity inspection**

```bash
curl "http://localhost:12412/api/memories/graph" \
  -H "Authorization: Bearer $TOKEN" | jq '[.nodes[] | select(.nodeType == "memory")] | .[0:5] | .[] | {id: .id[:8], entities, type}'
# Check: entities use canonical types, no garbage values
```

**VER-04: NLQ photo query**

```bash
curl "http://localhost:12412/api/memories/search?q=show+me+photos+from+last+week" \
  -H "Authorization: Bearer $TOKEN" | jq '.parsed'
# Expected: parsed.sourceType == "photo"
# NO alias resolution step visible
```

## Architecture Patterns

### Verification Flow

This phase follows a UAT (User Acceptance Testing) pattern:

1. **Setup**: Ensure dev services are running (API, Redis, Qdrant, Ollama)
2. **Execute**: Run each verification check against the live system
3. **Assert**: Compare actual results against expected behavior
4. **Document**: Record pass/fail with evidence (response snippets)

### Key Code Paths to Understand

| Path               | Files                                                  | What It Does                                                                         |
| ------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| NLQ -> Search      | `nlq-parser.ts` -> `memory.service.ts:search()`        | Parses query, extracts `sourceTypeHint`, applies as filter                           |
| Embed -> Memory    | `embed.processor.ts:process()`                         | Creates memory with `event.sourceType`, upserts to Qdrant with `source_type` payload |
| Enrich -> Entities | `enrich.service.ts:enrich()` -> `entity-normalizer.ts` | Extracts entities via Ollama, normalizes with canonical types                        |
| Graph Build        | `memory.service.ts:getGraphData()`                     | Builds nodes from memories + contacts, reads entities from metadata                  |

## Don't Hand-Roll

| Problem                 | Don't Build           | Use Instead                        | Why                                                       |
| ----------------------- | --------------------- | ---------------------------------- | --------------------------------------------------------- |
| Verification automation | Custom test framework | Manual API calls + `jq` inspection | This is a one-time verification, not regression testing   |
| Data inspection         | Custom DB query tool  | `botmem` CLI or direct API calls   | CLI already supports `--json` for machine-readable output |

## Common Pitfalls

### Pitfall 1: Stale Data Confusion

**What goes wrong:** Verification sees old un-backfilled data alongside correctly processed new data, causing mixed results.
**Why it happens:** Phase 27 backfill may not have completed for all memories, or some memories were ingested before the Phase 26 normalizer was deployed.
**How to avoid:** Check `enrichedAt` column -- memories with NULL `enrichedAt` were not re-enriched by the backfill. The backfill (Phase 27) uses `enrichedAt` as the resumability marker.
**Warning signs:** Entities with non-canonical types (e.g., "GREETING", "SCHEDULE") in search results.

### Pitfall 2: Assuming Services Are Running

**What goes wrong:** Verification fails because Ollama, Qdrant, or Redis is not running.
**How to avoid:** Check `GET /api/health` first. Per project conventions, assume dev services are already running but tell the user if they're not.

### Pitfall 3: Missing Auth Token

**What goes wrong:** All API calls return 401 because no JWT token is provided.
**How to avoid:** Log in first via `POST /api/user-auth/login` with test credentials (amroessams@gmail.com / password123), extract the access token from the response.

### Pitfall 4: Re-sync Overwrites Good Data

**What goes wrong:** VER-01 asks for a "fresh re-sync" but if the connector re-ingests all data, it may duplicate memories.
**How to avoid:** Use a small connector or a connector with few items. The sync uses `sourceId` for deduplication, so re-syncing should not create duplicates -- but verify this assumption.

## Validation Architecture

### Test Framework

| Property           | Value                       |
| ------------------ | --------------------------- |
| Framework          | Vitest 3                    |
| Config file        | `apps/api/vitest.config.ts` |
| Quick run command  | `pnpm test`                 |
| Full suite command | `pnpm test`                 |

### Phase Requirements -> Test Map

| Req ID | Behavior                                    | Test Type    | Automated Command                                                                   | File Exists?               |
| ------ | ------------------------------------------- | ------------ | ----------------------------------------------------------------------------------- | -------------------------- |
| VER-01 | Fresh re-sync produces correct source types | manual / e2e | Manual API verification against live system                                         | N/A -- manual verification |
| VER-02 | Photo search returns only photos            | manual / e2e | Manual API verification against live system                                         | N/A -- manual verification |
| VER-03 | Entity graph shows clean entities           | manual / e2e | Manual API verification against live system                                         | N/A -- manual verification |
| VER-04 | NLQ photo query uses photo source type      | unit         | `pnpm --filter @botmem/api exec vitest run src/memory/__tests__/nlq-parser.test.ts` | Yes                        |

### Sampling Rate

- **Per task commit:** No commits expected (verification-only phase)
- **Per wave merge:** N/A
- **Phase gate:** All 4 VER checks pass with documented evidence

### Wave 0 Gaps

None -- this is a verification phase, not an implementation phase. Existing unit tests for `nlq-parser` and `entity-normalizer` already cover the code paths. What this phase adds is live system validation.

## Code Examples

### NLQ Parser Source Type Detection (verified from source)

```typescript
// Source: apps/api/src/memory/nlq-parser.ts:45-49
const SOURCE_TYPE_MAP: [RegExp, string][] = [
  [/\bphotos?\b/i, 'photo'],
  [/\bemails?\b/i, 'email'],
  [/\bmessages?\b/i, 'message'],
];
```

### Memory Service Search - Source Type Filter Application (verified from source)

```typescript
// Source: apps/api/src/memory/memory.service.ts:257-259
// Apply source type hint from NLQ (only if caller didn't provide explicit sourceType)
if (nlq.sourceTypeHint && !filters?.sourceType) {
  effectiveFilters.sourceType = nlq.sourceTypeHint;
}
```

### Entity Normalizer - Canonical Type Enforcement (verified from source)

```typescript
// Source: apps/api/src/memory/entity-normalizer.ts:147-149
const rawType = (entity.type ?? 'other').toLowerCase();
const type: CanonicalEntityType =
  TYPE_MAP[rawType] ?? (canonicalSet.has(rawType) ? (rawType as CanonicalEntityType) : 'other');
```

### Photos Connector - Correct Source Type (verified from source)

```typescript
// Source: packages/connectors/photos-immich/src/index.ts:214
sourceType: 'photo',
```

## State of the Art

| Old Approach                             | Current Approach                                      | When Changed          | Impact                                     |
| ---------------------------------------- | ----------------------------------------------------- | --------------------- | ------------------------------------------ |
| `SOURCE_TYPE_ALIASES: { photo: 'file' }` | Direct passthrough of NLQ sourceTypeHint              | Phase 25 (2026-03-08) | Photo queries now filter correctly         |
| Unvalidated entity types from LLM        | `normalizeEntities()` with 10-type canonical taxonomy | Phase 26 (2026-03-08) | No more hallucinated types like "GREETING" |
| No entity dedup per memory               | Dedup by `type::lowercaseValue` key                   | Phase 26 (2026-03-08) | Graph shows clean entities                 |
| No garbage entity filtering              | Pronoun/generic/URL/short-value filtering             | Phase 26 (2026-03-08) | No garbage nodes in graph                  |

## Open Questions

1. **Does re-sync deduplicate correctly?**
   - What we know: Embed processor uses `sourceId` for uniqueness, but there may not be a unique constraint -- it inserts a new memory with a new UUID each time
   - What's unclear: Whether re-syncing a connector creates duplicate memories or updates existing ones
   - Recommendation: Verify during VER-01 by checking memory count before and after re-sync

2. **Are all existing memories backfilled?**
   - What we know: Phase 27 backfill uses `enrichedAt` as marker and is resumable
   - What's unclear: Whether the backfill completed for ALL memories or was stopped partway
   - Recommendation: Check `SELECT COUNT(*) FROM memories WHERE enrichedAt IS NULL` before starting verification

## Sources

### Primary (HIGH confidence)

- `apps/api/src/memory/nlq-parser.ts` - SOURCE_TYPE_MAP verified, no aliases
- `apps/api/src/memory/memory.service.ts` - search() source type filter logic verified
- `apps/api/src/memory/entity-normalizer.ts` - canonical types, dedup, garbage filter verified
- `apps/api/src/memory/embed.processor.ts` - sourceType passthrough to memory and Qdrant verified
- `apps/api/src/memory/enrich.service.ts` - normalizeEntities() wiring verified
- `packages/connectors/photos-immich/src/index.ts` - `sourceType: 'photo'` verified
- `grep -r "SOURCE_TYPE_ALIASES" apps/api/src/` - zero results confirmed

### Secondary (MEDIUM confidence)

- `.planning/phases/25-source-type-reclassification/25-VERIFICATION.md` - Phase 25 verification results
- `.planning/phases/26-entity-format-quality/` - Phase 26 completion evidence

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH - no new libraries, all verification against existing code
- Architecture: HIGH - code paths are well-understood from source inspection
- Pitfalls: HIGH - common issues documented from project history

**Research date:** 2026-03-09
**Valid until:** 2026-04-09 (stable -- verification of completed work)

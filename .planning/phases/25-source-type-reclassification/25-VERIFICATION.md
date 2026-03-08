---
phase: 25-source-type-reclassification
verified: 2026-03-08T16:00:00Z
status: passed
score: 9/9 must-haves verified
re_verification: false
---

# Phase 25: Source Type Reclassification Verification Report

**Phase Goal:** Fix the photos-immich connector to emit the correct `photo` source type, add QdrantService.setPayload, create backfill migration, and remove SOURCE_TYPE_ALIASES hack.
**Verified:** 2026-03-08T16:00:00Z
**Status:** passed
**Re-verification:** No -- initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Photos connector emits source_type 'photo' not 'file' | VERIFIED | `packages/connectors/photos-immich/src/index.ts:214` has `sourceType: 'photo'` |
| 2 | Existing photo memories in SQLite have source_type 'photo' | VERIFIED | Migration script `backfill-source-types.ts` runs UPDATE with dual filter `connector_type='photos' AND source_type='file'` |
| 3 | Existing photo memories in Qdrant have source_type 'photo' in payload | VERIFIED | Migration script calls `qdrant.setPayload('memories', ...)` with matching filter |
| 4 | rawEvents for photos also corrected to source_type 'photo' | VERIFIED | Migration script line 62: `UPDATE raw_events SET source_type = 'photo' WHERE connector_type = 'photos' AND source_type = 'file'` |
| 5 | Slack file attachments are NOT affected by any update | VERIFIED | All SQL UPDATEs and Qdrant filters include both `source_type = 'file'` AND `connector_type = 'photos'` conditions |
| 6 | SOURCE_TYPE_ALIASES constant is removed from memory.service.ts | VERIFIED | `grep SOURCE_TYPE_ALIASES apps/api/src/` returns 0 results |
| 7 | NLQ photo queries use 'photo' source type directly without alias mapping | VERIFIED | `memory.service.ts:208` directly assigns `effectiveFilters.sourceType = nlq.sourceTypeHint` |
| 8 | Searching for 'photos' returns correct results using native source_type | VERIFIED | NLQ parser produces `sourceTypeHint: 'photo'`, passed through without alias mapping |
| 9 | NLQ parser SOURCE_TYPE_MAP is NOT touched | VERIFIED | No changes to `nlq-parser.ts` in phase commits |

**Score:** 9/9 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/connectors/photos-immich/src/index.ts` | Corrected sourceType emission | VERIFIED | Line 214: `sourceType: 'photo'` |
| `apps/api/src/memory/qdrant.service.ts` | setPayload method | VERIFIED | Lines 168-177: public `setPayload(payload, filter)` method wrapping client call with `wait: true` |
| `apps/api/src/migrations/backfill-source-types.ts` | Standalone migration script | VERIFIED | 119 lines, connects to SQLite + Qdrant, dual-filter updates, before/after counts, `main().catch()` pattern |
| `apps/api/src/memory/memory.service.ts` | Clean NLQ passthrough | VERIFIED | Line 208: direct assignment, no alias lookup |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `backfill-source-types.ts` | SQLite memories + raw_events | better-sqlite3 direct connection | WIRED | Lines 57, 62: parameterized UPDATE statements with dual filter |
| `backfill-source-types.ts` | Qdrant memories collection | QdrantClient.setPayload with filter | WIRED | Lines 87-96: setPayload call with `must` filter on both source_type and connector_type |
| `memory.service.ts` | NLQ sourceTypeHint | Direct assignment to effectiveFilters.sourceType | WIRED | Line 208: `effectiveFilters.sourceType = nlq.sourceTypeHint` confirmed |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| SRC-01 | 25-01 | Photos connector emits `photo` source type instead of `file` | SATISFIED | Connector emits `sourceType: 'photo'`; test asserts `toBe('photo')` |
| SRC-02 | 25-01 | Existing photo memories reclassified from `file` to `photo` in SQLite | SATISFIED | Migration script updates both `memories` and `raw_events` tables |
| SRC-03 | 25-01 | Qdrant vector payloads updated with corrected `source_type` for photos | SATISFIED | Migration script calls Qdrant `setPayload` with correct filter |
| SRC-04 | 25-02 | `SOURCE_TYPE_ALIASES` hack removed from memory service | SATISFIED | Zero occurrences of `SOURCE_TYPE_ALIASES` in codebase; direct passthrough confirmed |

No orphaned requirements. All four requirement IDs (SRC-01 through SRC-04) mapped to Phase 25 in REQUIREMENTS.md are accounted for across Plans 01 and 02.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| None | - | - | - | No anti-patterns detected |

No TODOs, FIXMEs, placeholders, empty implementations, or stub patterns found in any modified files.

### Human Verification Required

### 1. Migration Script on Live Data

**Test:** Run `npx tsx apps/api/src/migrations/backfill-source-types.ts` on a database with actual photo memories
**Expected:** Before-counts show `source_type='file'` entries; after-counts show all reclassified to `source_type='photo'`; Qdrant payload updated
**Why human:** Verification requires a populated database with photo memories to confirm actual data transformation

### 2. End-to-End Photo Search

**Test:** Search for "show me my photos" in the memory explorer
**Expected:** Returns only photo memories (not Slack file attachments); results use `source_type: 'photo'`
**Why human:** Requires running application with populated data to verify full query pipeline

### Gaps Summary

No gaps found. All nine observable truths verified. All four artifacts pass existence, substance, and wiring checks. All four requirements (SRC-01 through SRC-04) satisfied. All three commits (acea9c1, a6364a2, c10ca97) verified in git history.

---

_Verified: 2026-03-08T16:00:00Z_
_Verifier: Claude (gsd-verifier)_

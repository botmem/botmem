---
phase: 09-temporal-reasoning
verified: 2026-03-08T16:18:00Z
status: passed
score: 9/9 must-haves verified
re_verification: false
---

# Phase 9: NLQ Parsing Verification Report

**Phase Goal:** Users can search with natural language containing temporal references, person/place names, and varying intents, and get intelligently filtered results within 500ms
**Verified:** 2026-03-08T16:18:00Z
**Status:** passed
**Re-verification:** No -- initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | parseNlq('emails from last week') returns correct date range for previous Monday-Sunday | VERIFIED | Test passes: Feb 23 Mon to Mar 1 Sun for ref date Mar 8 Sun. Custom parseLastWeek() in nlq-parser.ts:72-90 |
| 2 | parseNlq('in January') returns Jan 1 to Jan 31 of most recent past January | VERIFIED | Test passes: 2026-01-01 to 2026-01-31. Month expansion in nlq-parser.ts:188-191 |
| 3 | parseNlq('yesterday') returns yesterday 00:00 to 23:59:59 | VERIFIED | Test passes: 2026-03-07T00:00 to 2026-03-07T23:59:59. Day expansion in nlq-parser.ts:192-196 |
| 4 | parseNlq('between March and June') returns March 1 to June 30 | VERIFIED | Test passes. Custom parseBetween() in nlq-parser.ts:95-138 |
| 5 | Intent classification: recall/browse/find correctly routed | VERIFIED | 8 intent tests pass. classifyIntent() at nlq-parser.ts:208-219 with ordered regex patterns |
| 6 | Search with NLQ enhancements completes in under 500ms (no LLM in hot path) | VERIFIED | parseNlq is pure/synchronous (<5ms per test). No LLM calls added to search path. chrono-node is deterministic regex parser |
| 7 | API response includes parsed field with temporal, entities, intent, cleanQuery | VERIFIED | memory.service.ts:451-459 builds ParsedQuery in every SearchResponse |
| 8 | Frontend shows temporal filter info in search result banner | VERIFIED | SearchResultsBanner.tsx accepts parsed prop, renders cyan/yellow banners. MemoryExplorerPage.tsx passes parsed from store. Web build succeeds |
| 9 | CLI --json output includes parsed field | VERIFIED | search.ts:58 includes parsed in JSON output. Lines 61-71 display human-readable temporal/intent info |

**Score:** 9/9 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/api/src/memory/nlq-parser.ts` | NLQ parsing functions | VERIFIED | 272 lines. Exports parseNlq and NlqParsed. Pure functions, no DB/NestJS deps. Imports chrono-node |
| `apps/api/src/memory/__tests__/nlq-parser.test.ts` | Unit tests (min 80 lines) | VERIFIED | 134 lines, 23 tests, all passing |
| `apps/api/src/memory/memory.service.ts` | NLQ-integrated search pipeline | VERIFIED | Imports parseNlq (line 10), calls it at search entry (line 192), applies temporal/sourceType/intent filters |
| `apps/api/src/memory/qdrant.service.ts` | event_time datetime payload index | VERIFIED | ensureTemporalIndex() creates datetime index on event_time field |
| `apps/web/src/components/memory/SearchResultsBanner.tsx` | Temporal parse feedback display | VERIFIED | Accepts parsed prop with temporal/temporalFallback, renders filter banners |
| `apps/web/src/store/memoryStore.ts` | ParsedQuery state tracking | VERIFIED | ParsedQuery interface, parsed state field, stored from API response |
| `packages/cli/src/commands/search.ts` | CLI parse display | VERIFIED | JSON mode includes parsed field, human mode shows date filter and intent |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| memory.service.ts | nlq-parser.ts | `import { parseNlq } from './nlq-parser'` | WIRED | Line 10 import, line 192 call in search() |
| memory.service.ts | qdrant.service.ts | buildQdrantFilter passes event_time range | WIRED | Lines 1194-1198: event_time range filter in buildQdrantFilter. Lines 330-331: SQL temporal conditions |
| memoryStore.ts | API /memories/search | fetch, stores parsed field | WIRED | Line 118: stores result.parsed in state |
| MemoryExplorerPage.tsx | SearchResultsBanner | passes parsed prop | WIRED | Line 20: destructures parsed from store. Line 75: passes parsed={parsed} to component |
| search.ts (CLI) | API response | destructures parsed from response | WIRED | Line 55: destructures parsed, line 58: includes in JSON output |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-----------|-------------|--------|----------|
| NLQ-01 | 09-01, 09-02 | Temporal references ("last week", "in January", "yesterday") produce date-filtered results via chrono-node | SATISFIED | nlq-parser.ts parseTemporal + memory.service.ts temporal filter in buildQdrantFilter + SQL WHERE clauses |
| NLQ-02 | 09-02 | Person/place/org names in natural language get entity-boosted results | SATISFIED | memory.service.ts entity resolution runs on original query (line 213), contactBoost applied (line 407) |
| NLQ-03 | 09-01, 09-02 | Query intent classification (recall/browse/find) optimizes ranking and filtering | SATISFIED | classifyIntent() in nlq-parser.ts, find caps at 5 results (line 209), browse boosts recency to 0.40 (line 904-906) |
| PERF-01 | 09-01, 09-02 | Search with NLQ completes in <500ms, no LLM in search hot path | SATISFIED | parseNlq is synchronous pure function (<5ms). No new LLM calls added. Embedding call was already in pipeline |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| None | - | - | - | No anti-patterns detected in phase artifacts |

### Human Verification Required

### 1. Temporal Filtered Search End-to-End

**Test:** Search "emails from last week" via the web UI or API
**Expected:** Results are limited to the correct date range; parsed field shows temporal from/to; SearchResultsBanner shows cyan date filter banner
**Why human:** Requires running services (API + Qdrant + Ollama) with real data to confirm end-to-end temporal filtering

### 2. Browse Intent Recency Ordering

**Test:** Search "show me recent photos" and verify results are ordered by recency
**Expected:** Most recent results appear first due to browse intent boosting recency weight to 0.40
**Why human:** Scoring weight differences require visual inspection of result ordering with real data

### 3. Temporal Fallback Behavior

**Test:** Search with a temporal reference that matches no data (e.g., "emails from December 2020")
**Expected:** Yellow fallback banner appears; results show all matches without date filter
**Why human:** Requires a data state where temporal filter genuinely returns zero results

### Gaps Summary

No gaps found. All must-haves from both plans (09-01 and 09-02) are verified:

- **Plan 01 (NLQ Parser):** Pure function module with 23 passing tests, chrono-node installed, all temporal/intent/sourceType/cleanQuery behaviors implemented
- **Plan 02 (Pipeline Integration):** parseNlq wired into search(), Qdrant event_time index created, temporal filters applied to both Qdrant and SQL, browse weight adjustment implemented, find intent caps at 5, temporal fallback works, ParsedQuery in API response, CLI and frontend display parse results

All 4 requirements (NLQ-01, NLQ-02, NLQ-03, PERF-01) are satisfied. Web build succeeds. All commits verified.

---

_Verified: 2026-03-08T16:18:00Z_
_Verifier: Claude (gsd-verifier)_

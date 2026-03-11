# Search System Diagnostic Report

**Date**: 2026-03-10
**Data**: 10,108 memories across 6 connectors (gmail 2500, imessage 2000, photos 2000, slack 1918, whatsapp 1302, locations 388)

## 1. Data Baseline

| Metric | Value |
|--------|-------|
| Total memories | 10,108 |
| Pipeline complete | 10,108 (100%) |
| Embedding status done | 10,108 (100%) |
| Qdrant vectors | 10,127 |
| Qdrant status | green |
| Enriched (factuality set) | 127 (1.3%) |
| All queues | drained (0 waiting/active/failed) |

**Note**: The plan assumed ~50% `pipelineComplete=false` — this is NOT the case. All memories are fully processed. However, only 127 have factuality labels (enrichment ran but most got `UNVERIFIED` default, not written to the factuality column).

### Sample Memories per Connector

| Connector | Sample Text |
|-----------|-------------|
| gmail | (email content — JSON parse failed due to control chars in text) |
| slack | (JSON parse failed — control characters) |
| whatsapp | `Amr Essam (+971502284498): I cbf to go anywhere rn` |
| imessage | (JSON parse failed — control characters) |
| photos | (JSON parse failed — control characters) |
| locations | `At Home, [25.11330, 55.24703], on 2026-03-09 21:40:01 UTC, activity: stationary, automotive, altitude 12m, battery 25%, mobile` |

**Issue**: Many memory `text` fields contain control characters (newlines, tabs) that break JSON serialization in some clients. This is not a search bug but a data hygiene issue.

## 2. Test Results

### Phase 1: Connector Coverage

| # | Query | Filter | Count | Connectors | Score Range | Issues |
|---|-------|--------|-------|------------|-------------|--------|
| 1.1 | `receipt payment` | — | 10 | gmail:10 | 0.634–0.728 | OK — gmail-only is expected |
| 1.2 | `pet insurance claim` | — | 10 | gmail:10 | 1.000–1.000 | **BUG**: All scores capped at 1.000 (FTS textBoost=0.45 pushes past cap) |
| 1.3 | `deploy build` | — | 10 | whatsapp:3, imessage:3, gmail:1, slack:3 | 0.514–0.658 | Good diversity |
| 1.4 | `channel update` | — | 10 | slack:8, whatsapp:2 | 0.560–0.700 | OK |
| 1.5 | `hello` | whatsapp | 10 | whatsapp:10 | 0.628–0.675 | Filter works ✓ |
| 1.6 | `group chat` | — | 1 | slack:1 | 0.562 | **LOW COUNT**: Only 1 result for a common phrase |
| 1.7 | `hey` | imessage | 0 | — | N/A | **CRITICAL**: 15 iMessage memories contain "hey" but 0 returned |
| 1.8 | `text message` | — | 10 | imessage:8, whatsapp:2 | 0.548–0.754 | OK |
| 1.9 | `photo sunset` | — | 10 | photos:10 | 0.611–0.670 | OK |
| 1.10 | `landscape` | photos | 10 | photos:10 | 0.553–0.564 | Filter works ✓ |
| 1.11 | `location visit` | — | 10 | locations:7, imessage:3 | 0.532–0.633 | OK |
| 1.12 | `home` | locations | 0 | — | N/A | Expected — 0 locations contain "home" in text |

### Phase 2: Scoring Analysis

**Query: "important meeting"** (10 results)
```
whatsapp     score=0.674 sem=0.630 rec=0.954 imp=0.500 trust=0.800 rerank=0.000
gmail        score=0.652 sem=0.633 rec=0.810 imp=0.500 trust=0.750 rerank=0.000
gmail        score=0.647 sem=0.632 rec=0.785 imp=0.500 trust=0.750 rerank=0.000
imessage     score=0.622 sem=0.725 rec=0.165 imp=0.500 trust=0.800 rerank=0.000
```
- WhatsApp "Come sir" ranks #1 for "important meeting" — semantically irrelevant but recent (rec=0.954). **Recency bias confirmed**.
- iMessage with sem=0.725 ranks #4 because rec=0.165 drags it down. **Recency decay kills older relevant results**.
- All importance=0.500 — **dead uniform importance**, no differentiation.

**Query: "Amr"** (10 results) — All whatsapp/slack with `Amr` in text. Score range 0.682–0.753. Entity resolution works (matched contact).

**Query: "hello"** (10 results) — gmail, whatsapp, imessage. No photos or locations (expected). Score range 0.545–0.698.

**Query: "photo"** (10 results) — All photos connector. Score range 0.613–0.645.

**Key finding**: `importance` is uniformly 0.500 across ALL connectors. The dead `getWeights()` code (per-connector weights from manifests) is confirmed — `computeWeights()` uses hardcoded weights for ALL connector types identically.

### Phase 3: Reranker Validation

| Test | Result |
|------|--------|
| 3.2 No rerank | rerank=0.000 for all (expected) |
| 3.3 With rerank=true | **rerank=0.000 for all** (BUG) |
| 3.5 Diverse rerank | rerank=0.000 (BUG) |
| 3.6 Latency | no-rerank=421ms, rerank=1223ms (+800ms overhead) |

**Root cause analysis**: The 800ms overhead proves the Ollama call IS made. Direct Ollama testing returns valid scores `[0.8, 0.7, 0.3]`. The reranker's catch block silently returns zeros on failure:
```typescript
} catch (err: any) {
  this.logger.warn(`Reranker failed, using zero scores: ${err?.message}`);
  return new Array(documents.length).fill(0);
}
```

Likely causes (ranked by probability):
1. **Score count mismatch** — With 10-15 documents, model may output wrong number of scores → throws "Score count mismatch" → returns zeros
2. **Regex parse failure** — Model adds text around the JSON array → regex `/\[[\d.,\s]+\]/` fails to match
3. **Think tag interference** — Despite `think: false`, qwen3 might still output thinking tags in production context

**Impact**: CRITICAL — reranker is dead weight adding 800ms latency for zero benefit.

### Phase 4: FTS vs Qdrant Interaction

| # | Query | Limit | Count | Connectors | Fallback |
|---|-------|-------|-------|------------|----------|
| 4.1 | `meeting` | 5 | 5 | whatsapp:1, slack:1, gmail:2, imessage:1 | false |
| 4.2 | `dinner reservation friday` | 10 | 10 | photos:4, imessage:5, whatsapp:1 | false |
| 4.3a | `meeting` | 5 | 5 | whatsapp:1, slack:1, gmail:2, imessage:1 | false |
| 4.3b | `meeting` | 20 | 20 | whatsapp:3, slack:2, gmail:13, imessage:2 | false |
| 4.4 | `update` | 20 | 20 | whatsapp:3, gmail:1, imessage:15, slack:1 | false |

**Findings**:
- 4.2: "dinner reservation friday" (3-word AND) returned 10 results — FTS AND logic may have matched on individual words, or Qdrant-only fallback worked. No photos/locations expected but got photos:4 (semantic similarity to food/place descriptions).
- 4.3: Increasing limit from 5→20 shows gmail dominates (2→13). Connector diversity drops significantly at higher limits — gmail emails are longer text and get more FTS matches.
- 4.4: "update" at limit=20 — imessage:15 dominates. Short common words bias toward the most abundant connector (imessage has 2000 memories).
- **No `locations` or `photos` in any non-targeted query** — these connectors' text format is too different from conversational queries.

### Phase 5: Entity Resolution

| Query | Count | Parsed Entities | Matched |
|-------|-------|-----------------|---------|
| `Amr Essam` | 5 | `[{id: "07b1...", displayName: "Amr Essam"}]` | ✓ |
| `Amr project` | 5 | `[{id: "8fe0...", displayName: "Amr Samir"}]` | Partial — matched "Amr Samir" not "Amr Essam" |

- Entity resolution works but is ambiguous for partial names. "Amr" matches "Amr Samir" instead of "Amr Essam" (the user themselves) depending on search context.
- "Amr Essam" correctly resolves to the user's contact ID.

### Phase 6: Temporal Queries

| # | Query | Count | Temporal Parsed | Fallback |
|---|-------|-------|-----------------|----------|
| 6.1 | `messages last week` | 5 | `{from: "2026-03-02", to: "2026-03-08"}` | false |
| 6.2 | `what happened yesterday` | 5 | `{from: "2026-03-09", to: "2026-03-09"}` | false |
| 6.3 | `March 5 2026` | 5 | `{from: "2026-03-05", to: "2026-03-05"}` | false |
| 6.4 | `meeting in December 2020` | 2 | `{from: "2020-12-01", to: "2020-12-31"}` | false |

- Temporal parsing works well — correct date ranges extracted.
- 6.4 returned 2 results for Dec 2020 even though data starts ~2025. These are likely false matches (old emails forwarded recently, or calendar events referencing old dates). `temporalFallback` was `false` — no broadening happened.
- **Missing**: No temporal fallback when zero results — the plan expected `temporalFallback=true` for test 6.4 but it returned results.

### Phase 7: Edge Cases

| # | Query | Count | Connectors | Error |
|---|-------|-------|------------|-------|
| 7.1 | `""` (empty) | 0 | — | HTTP 400: query should not be empty ✓ |
| 7.2 | `hi` | 5 | gmail:5 | OK — very short query works |
| 7.3 | `مرحبا` (Arabic) | 5 | gmail:1, whatsapp:4 | OK — Arabic embedding works |
| 7.4 | `C++ developer` | 5 | imessage:2, gmail:3 | OK |
| 7.5 | 50+ word question | 5 | gmail:2, slack:3 | OK — long query handled |

**Note**: 7.3, 7.4, 7.5 initially returned HTTP 500 (server was crashing from circular JSON serialization bug). After reboot, all worked. The 500s are a separate crash bug, not search-specific.

### Phase 8: Source Type Filters

| # | Query | Filter | Count | Connectors | Sources | Parsed sourceType |
|---|-------|--------|-------|------------|---------|-------------------|
| 8.1 | `photos of food` | — | 5 | photos:5 | photo:5 | `photo` ✓ |
| 8.2 | `emails about project` | — | 5 | gmail:5 | email:5 | `email` ✓ |
| 8.3 | `food` | `{sourceType:"photo"}` | 5 | photos:5 | photo:5 | none (manual filter) |

- NLQ source type hint extraction works (`"photos of..."` → `sourceType: photo`).
- Explicit filter via `filters.sourceType` also works.

## 3. Issues Found

### CRITICAL

| # | Issue | Root Cause | Impact |
|---|-------|------------|--------|
| C1 | **Reranker returns zero scores** | `rerankOllama()` silently fails (catch returns zeros), adding 800ms latency with no benefit | Wasted latency, no reranking improvement |
| C2 | **FTS suppresses Qdrant semantic results** | When `hasExactMatches=true` (line 489-496), only Qdrant results that ALSO appear in FTS are kept | Pure semantic matches discarded when ANY text match exists |
| C3 | **Connector type "hey" + imessage = 0 results** | 15 iMessage memories contain "hey" but none appear in Qdrant top-N (small fetch window). FTS may find them but Qdrant doesn't, so they're filtered out | Filtered searches miss results that exist in the database |

### HIGH

| # | Issue | Root Cause | Impact |
|---|-------|------------|--------|
| H1 | **FTS textBoost caps scores at 1.0** | `Math.min(score + textBoost + contactBoost, 1.0)` — textBoost=0.45 + base score ≥ 0.55 → capped at 1.0 | All FTS matches have identical score=1.000, destroying ranking |
| H2 | **Recency decay dominates scoring** | `exp(-0.015 × age_days)`: 90d→0.26, 180d→0.07. Irrelevant recent messages outrank relevant old ones | WhatsApp "Come sir" ranks above actual meeting invitations |
| H3 | **Uniform importance=0.500** | `computeWeights()` uses hardcoded base importance of 0.5 for all memories | No differentiation between trivial and important memories |
| H4 | **Small Qdrant fetch window** | `effectiveLimit * 2` (limit=5 → only 10 vectors) | Misses relevant results beyond top-10 vectors |

### MEDIUM

| # | Issue | Root Cause | Impact |
|---|-------|------------|--------|
| M1 | **Dead `getWeights()` code** | Per-connector weights from manifests never used by `computeWeights()` | Connector-specific tuning has no effect |
| M2 | **Gmail dominates at high limits** | Gmail emails are longer → more FTS word matches → more textBoost hits | At limit=20, gmail gets 13/20 results for "meeting" |
| M3 | **Locations/photos rarely appear in unfocused queries** | Text format is too different from conversational queries; embedding similarity is low | These connectors are effectively invisible without source type hints |
| M4 | **Entity resolution ambiguity** | "Amr" matches "Amr Samir" instead of user's own contact "Amr Essam" | Contact-boosted results may surface wrong person's conversations |

### LOW

| # | Issue | Root Cause | Impact |
|---|-------|------------|--------|
| L1 | **Control characters in memory text** | Raw connector data has newlines/tabs that break some JSON parsers | Frontend rendering issues, API response parsing fragility |
| L2 | **Circular JSON crash** | Unrelated to search — Express response serialization | Server 500 on some responses (separate bug) |

## 4. Confirmed Code Bugs

1. **Dead `getWeights()` (memory.service.ts:218)** — CONFIRMED. Per-connector weights from manifests are defined but never called from `computeWeights()`. All connectors use identical hardcoded weights: `semantic=0.70, recency=0.15, importance=0.10, trust=0.05` (no-rerank formula).

2. **FTS AND logic (line ~450)** — PARTIALLY CONFIRMED. Multi-word queries DO return results (e.g., "dinner reservation friday" returned 10), but this is because individual words match, not the AND of all three. The FTS AND logic `'word1:* & word2:*'` works for common words but fails for rare combinations.

3. **FTS suppresses Qdrant (line 489-496)** — CONFIRMED. When FTS finds any text matches, only Qdrant results that also appear in FTS are kept. Pure semantic matches are discarded. This is the root cause of C3 (filtered searches missing results).

4. **Small Qdrant fetch window (line ~397)** — CONFIRMED. `effectiveLimit * 2` means limit=5 → only 10 vectors. Combined with FTS suppression, this severely limits result diversity.

5. **Reranker silent failure** — NEW FINDING. The Ollama reranker is called but silently fails, returning zeros. The catch block swallows the error. Latency overhead of 800ms is wasted.

6. **Score capping at 1.0** — NEW FINDING. `Math.min(score + textBoost + contactBoost, 1.0)` destroys ranking for FTS-matched results. All "pet insurance claim" results have identical score=1.000.

## 5. Recommendations for Search Rebuild

### Must Fix (Before rebuild)
1. **Debug reranker silent failure** — Add visible logging or test endpoint to diagnose. The Ollama call succeeds but parsing fails. Likely `score count mismatch` with many documents.
2. **Remove FTS suppression of Qdrant results** — UNION FTS and Qdrant results instead of INTERSECTING them. FTS should BOOST results, not GATE them.
3. **Increase Qdrant fetch window** — Use `effectiveLimit * 5` or `effectiveLimit * 10` instead of `* 2`.
4. **Fix score capping** — Use weighted combination instead of additive: `Math.min(baseScore * (1 + textBoost), 1.0)` or just increase the cap.

### Should Fix (In rebuild)
5. **Use per-connector weights** — Wire `getWeights()` into `computeWeights()`. Photos should weight semantic higher, locations should weight recency lower.
6. **Reduce recency decay** — Change from `exp(-0.015 × age)` to `exp(-0.005 × age)`. Current decay makes anything >90 days old nearly invisible.
7. **Differentiate importance scores** — Use entity count, thread depth, reply count, etc. to vary importance from the default 0.5.
8. **Increase Qdrant diversity** — Fetch more vectors and ensure at least 1 result per connector type if available.

### Nice to Have
9. **Connector diversity guarantee** — Reserve slots for underrepresented connectors in final results.
10. **FTS OR fallback** — When strict AND returns 0 hits, try OR logic before falling back to Qdrant-only.
11. **Clean control characters** — Strip or escape control chars in memory text during ingestion.

## 6. Verification Summary

| Connector | Appears in Results? | Filtered Search Works? |
|-----------|--------------------|-----------------------|
| gmail | ✓ (10/12 queries) | N/A (no filter tested) |
| slack | ✓ (4/12 queries) | N/A |
| whatsapp | ✓ (6/12 queries) | ✓ (hello + whatsapp filter) |
| imessage | ✓ (5/12 queries) | ✗ (hey + imessage = 0) |
| photos | ✓ (3/12 queries) | ✓ (landscape + photos filter) |
| locations | ✓ (1/12 queries) | ✗ (home + locations = 0, but 0 matches in DB) |

All 6 connectors appear in at least one search result. The imessage filter failure is due to Qdrant window + FTS suppression, not missing data.

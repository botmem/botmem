---
quick_task: 1
description: Fix semantic search 500 errors, timeouts, and empty results
date: 2026-03-07
status: complete
commit: (part of v1.3 Phase 7 changes)
---

# Summary: Fix Semantic Search

## What was wrong
Agent testing (convo.md) found semantic search completely broken:
- "AWS rocket Bahrain" → No results
- "discount" → No results (42s timeout)
- "Amelie" → Hung >45s, killed
- "suhoor" → 500 Internal Server Error

## Root cause
Qdrant HNSW index was never built. Default `indexing_threshold=10,000` but collection only had ~3,064 points, so Qdrant used brute-force scan instead of indexed search.

## Fixes applied (v1.3 Phase 7, same session)
1. Lowered `indexing_threshold` to 1,000 in `ensureCollection()`
2. Added `ensureIndexed()` call on module init to update existing collections
3. Fixed NestJS route ordering — specific routes before parameterized `:id`

## Verification results
| Query | Before | After |
|-------|--------|-------|
| "AWS rocket Bahrain" | ❌ No results | ✅ 1 result (0.725) |
| "discount" | ❌ 42s timeout | ✅ 5 results (1.0) |
| "Amelie" | ⏸️ Hung >45s | ✅ 5 results, contact resolved |
| "suhoor" | ❌ 500 error | ✅ 5 results (0.732) |

Qdrant status: `indexedVectorsCount=3064`, `status=green`

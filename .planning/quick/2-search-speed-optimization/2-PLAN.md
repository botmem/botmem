---
quick_task: 2
description: Search speed optimization — fast regardless of data volume
date: 2026-03-08
status: planned
---

# Quick Task 2: Search Speed Optimization

## Benchmark Baseline (3,450 memories, 1,048 contacts)

| Query | Time | Notes |
|-------|------|-------|
| "discount" | 17ms | Cached embed, few text matches |
| "suhoor" | 17ms | Cached embed, few text matches |
| "birthday" | 53ms | More text matches |
| "meeting" | 562ms | Many text matches + reranker |
| "amelie" | 2,829ms | Contact resolution + reranker on 15 docs |

## Root Cause Analysis

### Bottleneck 1: Reranker — 7.5s worst case (CRITICAL)
`ollama.rerank()` calls Ollama SEQUENTIALLY for each of 15 documents (~0.5s each warm).
This is the dominant cost for any query that triggers reranking.

**Fix**: Parallelize all 15 rerank calls with `Promise.all()`. Expected: 15×0.5s → 0.5s.

### Bottleneck 2: Entity resolution loads all contacts every query
`resolveEntities()` does `db.select().from(contacts)` on EVERY search — 1,048 rows.
At current scale this is ~2ms, but at 10K+ contacts it becomes significant.

**Fix**: Cache contacts in memory with TTL. Contacts change rarely (only during sync).

### Bottleneck 3: fetchMemoryRow() called one-by-one in loop
Lines 293-300: loops through all candidate IDs calling `fetchMemoryRow()` individually.
Each is a separate SQLite query with a LEFT JOIN.

**Fix**: Batch fetch using `WHERE id IN (...)` single query.

### Bottleneck 4: No FTS index for text search
`LIKE '%word%'` on `memories.text` is a full table scan. Currently ~5ms at 3,450 rows,
but at 100K+ memories this becomes a real problem.

**Fix**: Add SQLite FTS5 virtual table for full-text search. This is the key scalability fix.

### Bottleneck 5: Embed call latency on cold model
First query after idle takes ~14s (Ollama loads model). Subsequent: ~0.3s.

**Fix**: Add keep-alive ping on module init to pre-warm the embedding model.

## Tasks (ordered by impact)

### Task 1: Parallelize reranker calls
- **files**: `apps/api/src/memory/ollama.service.ts`
- **action**: Change `rerank()` to use `Promise.allSettled()` for all documents simultaneously
- **impact**: 15×0.5s → 0.5s (15x speedup on reranked queries)
- **verify**: "amelie" search < 1s

### Task 2: Batch fetch memory rows
- **files**: `apps/api/src/memory/memory.service.ts`
- **action**: Replace `fetchMemoryRow()` loop with single `WHERE id IN (...)` query
- **impact**: N queries → 1 query
- **verify**: No per-candidate SQL queries in search path

### Task 3: Cache contacts for entity resolution
- **files**: `apps/api/src/memory/memory.service.ts`
- **action**: Add `contactsCache` with 60s TTL, invalidated on contact writes
- **impact**: Eliminates repeated full-table scan of contacts
- **verify**: Only 1 contacts query per 60s window

### Task 4: Add SQLite FTS5 for text search
- **files**: `apps/api/src/db/db.service.ts`, `apps/api/src/memory/memory.service.ts`
- **action**: Create `memories_fts` FTS5 table, sync on memory insert/update, use MATCH in search
- **impact**: LIKE '%word%' O(n) → FTS5 O(log n), critical at scale
- **verify**: Text search uses FTS5 MATCH, EXPLAIN shows virtual table scan

### Task 5: Pre-warm embedding model
- **files**: `apps/api/src/memory/ollama.service.ts`
- **action**: On module init, fire a dummy embed call to keep model loaded
- **impact**: Eliminates 14s cold-start on first query
- **verify**: First search after restart < 1s

## Expected Results

| Query | Before | After (projected) |
|-------|--------|-------------------|
| "amelie" | 2,829ms | < 500ms |
| "meeting" | 562ms | < 100ms |
| "discount" | 17ms | < 15ms |
| At 100K memories | would degrade | stable < 500ms |

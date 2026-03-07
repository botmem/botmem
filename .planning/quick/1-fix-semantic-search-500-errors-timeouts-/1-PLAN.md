---
quick_task: 1
description: Fix semantic search 500 errors, timeouts, and empty results based on agent feedback in convo.md
date: 2026-03-07
status: complete
---

# Quick Task 1: Fix Semantic Search

## Context
Agent feedback in convo.md reported critical search issues: 500 errors, timeouts (>45s), and empty results.

## Root Cause
Qdrant's HNSW index was not being built because the default `indexing_threshold` (10,000) exceeded the collection size (~3,064 points), forcing brute-force search which caused timeouts and errors.

## Tasks

### Task 1: Already applied in v1.3 Phase 7
- **files**: `apps/api/src/memory/qdrant.service.ts`
- **action**: Lowered indexing_threshold from 10,000→1,000, added `ensureIndexed()` on startup
- **verify**: `curl http://localhost:6333/collections/memories` shows `indexed_vectors_count > 0`
- **done**: ✅ indexed_vectors_count=3064

### Task 2: Route ordering fix (already applied)
- **files**: `apps/api/src/memory/memory.controller.ts`
- **action**: Moved specific GET routes (timeline, entities) before parameterized `:id` route
- **verify**: `curl /api/memories/timeline` returns data instead of being caught by `:id`
- **done**: ✅ All routes respond correctly

### Task 3: Write summary
- **files**: `.planning/quick/1-fix-semantic-search-500-errors-timeouts-/1-SUMMARY.md`
- **action**: Document resolution and verification results
- **done**: Pending

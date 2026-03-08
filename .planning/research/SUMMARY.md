# Research Summary: Botmem v2.1 Data Quality & Pipeline Integrity

**Domain:** Data quality fixes for memory RAG pipeline (source types, entity extraction, dedup, backfill)
**Researched:** 2026-03-08
**Overall confidence:** HIGH

## Executive Summary

Botmem's pipeline has three data quality problems that undermine search, filtering, and graph visualization. First, the photos-immich connector emits `sourceType: 'file'` instead of `'photo'`, causing photo searches to return Slack file attachments alongside actual photos. The NLQ parser and memory service have a workaround hack (`SOURCE_TYPE_ALIASES`) that papers over this but does not fix the root cause. Second, entity extraction via Ollama produces garbage values (pronouns, single characters, generic terms), misclassifies entities (persons as locations), and has no deduplication. Third, the embed and enrich pipeline steps produce entities in incompatible formats (`{type, id, role}` vs `{type, value}`) that never merge -- the embed-step entities are consumed for contact resolution then discarded.

All three problems are fixable with targeted changes to existing components plus a pure-function normalizer. No new queue stages or schema changes are needed. The source type fix is deterministic (SQL migration + Qdrant payload update), while entity quality requires an improved Ollama prompt and a normalizer that runs inline within EnrichService. Historical data needs two separate backfills: a fast script for source types and a queue-based job for entity re-extraction.

The existing codebase has good infrastructure for this work. The `backfill-entity-types.ts` migration establishes the pattern for data correction scripts. The `backfill` BullMQ queue exists and works. The `ENTITY_FORMAT_SCHEMA` already constrains entity types via JSON schema enum. The changes are surgical -- modify 5 existing files, add 3 new files.

## Key Findings

**Stack:** No new dependencies needed. All fixes use existing Ollama, Qdrant, BullMQ, and Drizzle infrastructure.

**Architecture:** Fix at the source (connector + enrichment), backfill historical data. New pure-function EntityNormalizer handles dedup/clean/validate. No new queue stages.

**Critical pitfall:** Entity backfill is Ollama-bound (~500ms-2s per memory). At 50K memories with 8 concurrency, expect ~7 hours. Must be interruptible and resumable.

## Implications for Roadmap

Based on research, suggested phase structure:

1. **Source Type Reclassification** - Fix the connector, backfill SQLite + Qdrant, remove hack
   - Addresses: photo search returning wrong results, source type filtering broken
   - Avoids: No Ollama dependency, fast and deterministic
   - Estimated: 2-4 hours

2. **Entity Quality Infrastructure** - EntityNormalizer + improved prompts + pipeline integration
   - Addresses: garbage entities, misclassification, no dedup, format mismatch
   - Avoids: Adding pipeline complexity (normalizer is inline, not a new stage)
   - Estimated: 4-6 hours

3. **Entity Backfill** - Re-extract entities for existing memories with improved pipeline
   - Addresses: historical data quality
   - Avoids: Re-embedding (only updates entities column, vectors unchanged)
   - Estimated: 2-4 hours development + hours of Ollama processing time

4. **Validation** - Verify search, graph, and NLQ improvements
   - Addresses: confidence that fixes actually improved data quality
   - Estimated: 1-2 hours

**Phase ordering rationale:**
- Phase 1 is independent and immediately improves photo searches. Ship it first for quick value.
- Phase 2 must complete before Phase 3 (backfill uses improved prompt + normalizer).
- Phase 4 depends on all prior phases completing.

**Research flags for phases:**
- Phase 1: No research needed. Fix is fully deterministic.
- Phase 2: Prompt engineering may need iteration. Test with sample memories before deploying.
- Phase 3: May need to limit scope (only re-enrich memories from specific connectors, or only those with known-bad entities) if full backfill is too slow.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | No new dependencies, all existing tools |
| Features | HIGH | Problems clearly identified in code, fixes are straightforward |
| Architecture | HIGH | Integration points identified from direct code reading |
| Pitfalls | HIGH | Backfill performance is the main risk, mitigations clear |

## Gaps to Address

- Prompt engineering for entity extraction needs empirical testing -- cannot predict quality improvement from research alone
- Cross-memory entity dedup (same entity with different types across memories) is out of scope for this milestone but should be noted for future work
- The Slack `file` sourceType is technically correct for Slack -- only photos-immich needs reclassification. If other connectors emit file types that should be more specific, that is a separate concern.

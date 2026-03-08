---
phase: 08-full-data-import
plan: 01
subsystem: api
tags: [ollama, structured-output, entity-extraction, enrichment]

requires:
  - phase: 07-test-infrastructure-fixes
    provides: stable test infrastructure and search pipeline
provides:
  - Canonical entity type taxonomy enforced via Ollama structured output
  - OllamaService format parameter support for constrained generation
  - ENTITY_FORMAT_SCHEMA JSON schema constant
affects: [08-02, 09-temporal-reasoning, 10-entity-graph-api]

tech-stack:
  added: []
  patterns: [ollama-structured-output-format-parameter, canonical-entity-taxonomy]

key-files:
  created: []
  modified:
    - apps/api/src/memory/prompts.ts
    - apps/api/src/memory/ollama.service.ts
    - apps/api/src/memory/enrich.service.ts

key-decisions:
  - "Use Ollama format parameter (JSON schema) to enforce entity type enum at model level"
  - "Drop confidence field from entities -- structured output guarantees valid types, confidence is redundant"
  - "Exclude time/amount/metric from entity types -- those are memory metadata, not entities"

patterns-established:
  - "Structured output: pass JSON schema via format parameter to OllamaService.generate() for constrained generation"
  - "Entity taxonomy: 10 canonical types (person, organization, location, event, product, topic, pet, group, device, other)"

requirements-completed: [ENT-01]

duration: 2min
completed: 2026-03-08
---

# Phase 8 Plan 01: Canonical Entity Types Summary

**Ollama structured output enforces 10 canonical entity types during extraction, replacing freeform regex parsing with JSON schema-constrained generation**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-08T03:05:15Z
- **Completed:** 2026-03-08T03:06:48Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- OllamaService.generate() now accepts optional `format` parameter for structured output
- Entity extraction prompt rewritten with 10 canonical types, excluding time/amount/metric
- ENTITY_FORMAT_SCHEMA exported as JSON schema with enum constraint
- EnrichService uses structured output directly -- no more regex-based JSON extraction for entities

## Task Commits

Each task was committed atomically:

1. **Task 1: Add format parameter to OllamaService.generate() and rewrite entity extraction prompt** - `8cc23d9` (feat)
2. **Task 2: Wire structured output into EnrichService entity extraction** - `76bbd0a` (feat)

## Files Created/Modified
- `apps/api/src/memory/prompts.ts` - New ENTITY_FORMAT_SCHEMA constant and rewritten entityExtractionPrompt with canonical types
- `apps/api/src/memory/ollama.service.ts` - Added optional format parameter to generate() method
- `apps/api/src/memory/enrich.service.ts` - Uses structured output format, parses JSON directly, returns {type, value}[]

## Decisions Made
- Used Ollama format parameter (JSON schema) to enforce entity type enum at model level -- eliminates invalid types at generation time
- Dropped confidence field from entity objects -- structured output guarantees valid types, making confidence redundant
- Excluded time, amount, and metric from entity types -- these are memory metadata handled elsewhere in the pipeline

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Entity extraction now produces clean canonical types ready for downstream filtering
- Entity graph API (Phase 10) can rely on consistent type taxonomy
- Backfill of existing entities can use SQL string replacement (no LLM re-run needed)

---
*Phase: 08-full-data-import*
*Completed: 2026-03-08*

---
phase: 26-entity-format-quality
plan: 01
subsystem: api
tags: [entities, nlp, normalization, vitest, pure-function]

# Dependency graph
requires: []
provides:
  - "normalizeEntities() pure function for entity cleanup"
  - "CANONICAL_ENTITY_TYPES 10-type taxonomy"
  - "TYPE_MAP for legacy/hallucinated type mapping"
  - "Updated ENTITY_FORMAT_SCHEMA with canonical enum"
  - "Improved entityExtractionPrompt with examples and constraints"
affects: [26-02-entity-format-quality, memory, enrich]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure function normalizer pattern for post-processing LLM output"
    - "Canonical type taxonomy with TYPE_MAP for migration"

key-files:
  created:
    - apps/api/src/memory/entity-normalizer.ts
    - apps/api/src/memory/__tests__/entity-normalizer.test.ts
  modified:
    - apps/api/src/memory/prompts.ts

key-decisions:
  - "10-type canonical taxonomy: person, organization, location, date, event, product, concept, quantity, language, other"
  - "Normalizer is a pure function (no DI, no side effects) for easy testing and reuse"
  - "Embed-shape entities (type/id/role) handled by parsing compound id format"

patterns-established:
  - "Entity normalization: always run normalizeEntities() after LLM extraction or connector emit"
  - "TYPE_MAP as single source of truth for legacy type migration"

requirements-completed: [FMT-01, ENT-01, ENT-02, ENT-03, ENT-04, ENT-05]

# Metrics
duration: 3min
completed: 2026-03-08
---

# Phase 26 Plan 01: Entity Normalizer & Prompt Summary

**Pure normalizeEntities() function with 10-type canonical taxonomy, garbage filtering, dedup, and updated extraction prompt with positive/negative examples**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-08T17:27:45Z
- **Completed:** 2026-03-08T17:30:18Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Entity normalizer pure function handling type mapping (12 legacy types), garbage filtering (pronouns, URLs, generic terms), case-insensitive dedup, and entity cap (default 30)
- Both embed-shape ({type, id, role}) and enrich-shape ({type, value}) entity formats produce unified {type, value} output
- ENTITY_FORMAT_SCHEMA updated to 10-type canonical enum, entityExtractionPrompt rewritten with per-type examples and explicit negative examples
- 35 unit tests covering all normalization paths

## Task Commits

Each task was committed atomically:

1. **Task 1: Create entity normalizer with tests** - `88280f6` (feat, TDD)
2. **Task 2: Update entity extraction prompt and schema** - `d44bbee` (feat)

## Files Created/Modified
- `apps/api/src/memory/entity-normalizer.ts` - Pure normalizer: normalizeEntities(), CANONICAL_ENTITY_TYPES, TYPE_MAP, NormalizedEntity type
- `apps/api/src/memory/__tests__/entity-normalizer.test.ts` - 35 unit tests covering type mapping, garbage filtering, dedup, cap, format unification
- `apps/api/src/memory/prompts.ts` - Updated ENTITY_FORMAT_SCHEMA enum and rewritten entityExtractionPrompt

## Decisions Made
- 10-type canonical taxonomy (lowercase) matching research recommendations -- avoids breaking contacts system
- Normalizer is a pure function with no DI dependencies for easy testing and reuse across processors
- Compound embed-shape id format (name:X|email:Y) parsed to extract name part as value
- Pre-existing test failures (encrypted column) documented as out-of-scope

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- Pre-existing test failures in memory.service.test.ts, embed.processor.test.ts, enrich.processor.test.ts due to missing "encrypted" column in test schema -- unrelated to this plan's changes. Logged as out-of-scope.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- normalizeEntities() ready to be wired into EmbedProcessor and EnrichProcessor (Plan 02)
- ENTITY_FORMAT_SCHEMA and entityExtractionPrompt aligned with canonical taxonomy

---
*Phase: 26-entity-format-quality*
*Completed: 2026-03-08*

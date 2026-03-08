# Phase 8: Entity Type Taxonomy - Context

**Gathered:** 2026-03-08
**Status:** Ready for planning

<domain>
## Phase Boundary

Every entity in the system has a consistent canonical type, new memories produce clean entities via Ollama structured output, existing data is backfilled to the canonical taxonomy, and users can filter entity search by type. Contact entityType is aligned with the entity taxonomy.

</domain>

<decisions>
## Implementation Decisions

### Canonical type set
- Types: person, organization, location, event, product, topic, pet, group, device, other
- "other" is the catch-all for edge cases the model can't classify into the canonical set
- Drop time, amount, metric from extraction entirely -- they're memory metadata, not entities
- Pet detection is context-only -- only tag as "pet" when text clearly describes an animal (no prompt hints with known pet names)
- Drop the confidence field from entity schema -- entities are now {type, value} only
- Use Ollama structured output (`format` parameter with JSON schema) to enforce the type enum

### Backfill strategy
- One-time migration script (not a BullMQ job)
- Delete entities with non-canonical types (time, amount, metric) from the JSON array entirely
- Strip confidence field from all existing entities to make schema uniform {type, value}
- Run silently -- no logging of counts/changes
- Also normalize contact entityType values to match the unified type set

### Entity search UX
- Add optional `?type=` parameter to GET /entities/search supporting comma-separated multi-type filtering (e.g. ?type=pet,person)
- Omitting type returns all types (current behavior preserved)
- Each entity search result includes the entity type in the response
- Add GET /entities/types endpoint returning the canonical type list (for UI dropdowns and CLI autocomplete)
- CLI (`botmem entities search`) also supports --type flag for type-filtered entity search

### Contact entity alignment
- Unified type set for both contacts.entityType and memory entities: person, organization, location, event, product, topic, pet, group, device, other
- Contact entityType expanded from person|group|organization|device to the full canonical set
- Backfill updates both memories.entities JSON and contacts.entityType for full consistency
- Entity extraction and contact resolution are SEPARATE concerns -- enrichment entity extraction only writes to memories.entities. Contact resolution (creating/resolving contacts from participants) is a separate pipeline step, not triggered by entity extraction.

### Claude's Discretion
- Exact JSON schema shape for Ollama's `format` parameter
- How to structure the migration SQL for JSON array manipulation in SQLite
- Order of operations for the migration (entities first vs contacts first)
- Whether to add the `format` parameter as a new method on OllamaService or extend `generate()`

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `OllamaService.generate()` at `apps/api/src/memory/ollama.service.ts:79` -- needs `format` parameter added to support structured output
- `searchEntities()` at `apps/api/src/memory/memory.service.ts:953` -- exists, needs type filter added
- `entityExtractionPrompt()` at `apps/api/src/memory/prompts.ts:1` -- needs rewrite with canonical types
- `EnrichService.extractEntities()` at `apps/api/src/memory/enrich.service.ts:124` -- currently parses freeform JSON, will use structured output
- `contacts.entityType` schema at `apps/api/src/db/schema.ts:99` -- currently defaults to 'person', needs expanded type set

### Established Patterns
- Entities stored as JSON text in `memories.entities` column (JSON array of objects)
- Contact resolution uses `resolveContact(identifiers, entityType)` pattern
- Entity extraction happens in enrich pipeline via `EnrichService.enrich()`
- Memory processor and embed processor both do contact resolution from entities (duplicate logic at `memory.processor.ts:175` and `embed.processor.ts:139`)

### Integration Points
- `GET /entities/search` controller at `memory.controller.ts:214` -- add type query param
- `GET /entities/types` -- new endpoint needed in memory.controller.ts
- CLI entities command -- new command in `packages/cli/src/commands/`
- Migration script -- new file, run standalone

</code_context>

<specifics>
## Specific Ideas

- Success criteria example: searching `/entities/search?q=Nugget&type=pet` returns Nugget as a pet entity
- The unified type set must work for both extracted entities (from text) and contact types (from connectors)
- Separating entity extraction from contact resolution is a refactor of the current embed/memory processor logic where entities feed directly into resolveContact

</specifics>

<deferred>
## Deferred Ideas

- Contact resolution refactoring (separating from entity extraction) may need its own cleanup pass if the processor logic is deeply entangled -- keep scope to the extraction side
- Entity deduplication across memories (e.g., "Google" and "Google Inc." being the same entity) -- future phase

</deferred>

---

*Phase: 08-full-data-import*
*Context gathered: 2026-03-08*

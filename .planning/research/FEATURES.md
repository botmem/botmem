# Feature Landscape

**Domain:** Data quality and pipeline integrity for a personal memory RAG system
**Researched:** 2026-03-08

## Table Stakes

Features that are expected behaviors in any production entity extraction and data quality pipeline. Missing these means the system produces garbage results that undermine search, graph visualization, and downstream AI consumption.

| Feature | Why Expected | Complexity | Dependencies | Notes |
|---------|--------------|------------|--------------|-------|
| **Source type correctness** | Source type drives filtering, graph coloring, and search scoping. Photos classified as `file` means 2,099 records are invisible to photo-specific queries. The SDK already defines the union type `'email' | 'message' | 'photo' | 'location' | 'file'` -- connectors just need to use the right value. | Low | `photos-immich` connector, `ConnectorDataEvent.sourceType` type definition | One-line fix in `photos-immich/src/index.ts` (change `'file'` to `'photo'`). Slack files should remain `file`. Backfill needed for existing records in both `rawEvents` and `memories` tables, plus Qdrant payload. |
| **Canonical entity type enforcement** | Every NER/entity extraction system uses a fixed taxonomy. Without it, LLM hallucinations create unbounded type proliferation (the current 100+ types problem). Ollama's `format` parameter with JSON schema already supports `enum` constraints -- the schema `ENTITY_FORMAT_SCHEMA` is defined in `prompts.ts` with the correct enum, and it IS being passed to `ollama.generate()`. The model is simply not respecting it reliably at the 0.6B parameter scale. | Low | Existing `ENTITY_FORMAT_SCHEMA` in `prompts.ts`, Ollama structured output via `format` param | The schema is already passed. The fix is adding a post-processing validation layer that rejects any entity whose `type` is not in the canonical list. Belt-and-suspenders: trust the constraint but verify after. Grammar-based constrained generation (GBNF) in Ollama should enforce this at token level, but small models still produce invalid output occasionally. |
| **Empty entity filtering** | Extracting entities with empty string values is a known failure mode of LLM-based NER. Post-processing must strip entities where `value` is empty or whitespace-only. Standard NER pipelines always include a validation/filtering step after extraction. 107 empty locations, 94 empty events, 80 empty orgs in the current DB. | Low | `enrich.service.ts` `extractEntities()` method | Add `.filter(e => e.value?.trim())` after parsing. Trivial fix. |
| **Intra-memory entity deduplication** | Extracting the same entity twice within a single memory (e.g., same IP address appearing twice) inflates entity counts and clutters the graph. Standard NER post-processing deduplicates by (type, normalized_value) within a single document. | Low | `enrich.service.ts` `extractEntities()` method | Deduplicate by `type + value.toLowerCase().trim()` after extraction. Keep first occurrence. |
| **Garbage entity value rejection** | Entity types like "battery", "wifi", "appium:platformVersion", "yes", "usdt" exist because the structured output constraint was not enforced or the model hallucinated despite it. With proper post-processing, any entity whose `type` is not in the canonical 10 gets discarded. | Low | Depends on canonical type enforcement above | Validate extracted entity types against the canonical list; discard non-matching. Combined with empty filtering into a single post-processing function. |
| **Entity format unification** | Two pipeline steps produce incompatible entity shapes: embed step emits `{type, id, role}` for contact resolution (in `EmbedResult.entities`), enrich step emits `{type, value}` for storage (in `memories.entities` column). These serve different purposes but the stored format in the `memories.entities` column must be consistent. Currently both may write to the column at different times. | Med | `EmbedResult.entities` in connector-sdk, `enrich.service.ts`, `memories.entities` column, `embed.processor.ts` | The embed step entities are consumed during embed for contact linking -- they should NOT be persisted to `memories.entities`. The enrich step produces the final entities for storage. Ensure the embed step does not write entities to the memories table (currently it does not -- the `memories.entities` default is `[]` and only `enrich.service.ts` updates it). Verify this is actually the case and document the canonical format as `{type, value}`. |
| **Entity misclassification fix** | "Amr Essam" appearing 181x as person but also 58x as location and 58x as organization means the LLM is misclassifying the same entity differently across memories. This is a prompt quality issue -- the current prompt does not provide enough guidance to distinguish entity types. | Med | `prompts.ts` `entityExtractionPrompt()`, possibly model size | Improve the prompt with clearer type definitions and examples. Add rules like: "A person's name is always 'person', never 'location' or 'organization' even if they are associated with a place or company." Consider few-shot examples in the prompt. |
| **Backfill pipeline for corrections** | After fixing extraction logic, existing records (40K+ memories) contain dirty data. A backfill mechanism re-runs enrichment on existing memories with the corrected pipeline. The system already has a `backfill` BullMQ queue defined but unused. | Med | `backfill` queue (exists but unused), `enrich.service.ts`, idempotent Qdrant upserts, all extraction fixes must be complete first | Must be idempotent: re-enrich without creating duplicate memory links. Must be throttled to not starve live sync jobs. Needs a way to track which memories have been re-enriched. |

## Differentiators

Features that go beyond fixing bugs -- they make Botmem's entity extraction and data quality genuinely better than typical personal knowledge management tools. Not expected, but valuable.

| Feature | Value Proposition | Complexity | Dependencies | Notes |
|---------|-------------------|------------|--------------|-------|
| **Source type auto-detection** | Instead of relying solely on connectors to set the right source type, infer it from content/metadata as a safety net. If an event has image MIME type metadata, it is a photo regardless of what the connector says. Defense-in-depth for source type correctness. | Low | `embed.processor.ts`, event metadata inspection | Check `metadata.mimetype` for `image/*` and override `sourceType` to `photo`. Low effort, prevents recurrence of the photos-as-files bug for any connector. |
| **Cross-memory entity resolution** | Resolving "Amr Essam" (181 occurrences) into a single canonical entity reference enables accurate entity counts, relationship graphs, and "show me everything about X" queries. The contact system already does this for person entities via identifier matching. The gap is non-person entities (organizations, locations, products). | High | Contact system (already handles person entities), new entity registry or canonicalization layer | The contact system is the right model to follow. For non-person entities, a lightweight entity registry table with canonical names and aliases could work. But the complexity is in the resolution algorithm (fuzzy matching, handling abbreviations, context-dependent classification). Defer unless the graph is unusable without it. |
| **Entity confidence scoring** | Adding per-entity confidence allows filtering low-confidence extractions and improving graph quality. The JSON schema can include a `confidence` float field. | Med | `ENTITY_FORMAT_SCHEMA` update, `enrich.service.ts` | Caution: qwen3:0.6b produces unreliable confidence scores. Small models are notoriously overconfident. More useful as a heuristic filter (drop below 0.3) than a precision metric. Better to fix extraction quality first. |
| **Entity normalization** | "New York", "NYC", "new york city" should all resolve to the same entity. Normalization (lowercasing, alias resolution, canonicalization) improves dedup and graph connectivity. | High | Entity registry infrastructure, potentially external gazetteer | Full solution requires embedding-based similarity or an external knowledge base. A pragmatic first step is case-insensitive dedup + simple alias rules. Defer to a later milestone. |
| **Enrichment quality metrics** | Track entity extraction quality over time: entities per memory, type distribution, empty rate, duplicate rate. Detect when the LLM is producing garbage (e.g., after a model update) and alert. | Med | New metrics collection in `enrich.service.ts`, PostHog integration | Useful for ongoing quality monitoring. Without this, data quality silently degrades after model updates or prompt changes. Could be a simple dashboard counter or PostHog events. |
| **Backfill progress UI** | Show backfill progress in the frontend -- how many memories re-enriched, how many remaining, estimated time. The job system already supports progress tracking via WebSocket. | Low | Backfill pipeline (table stakes), existing job progress UI | Reuse the existing job progress WebSocket infrastructure. The backfill job just needs to report progress/total like sync jobs do. |

## Anti-Features

Features to explicitly NOT build. These seem useful but create more problems than they solve in this context.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **Re-prompting / self-correction loops** | Sending extraction results back to the LLM to "verify" or "fix" doubles inference cost per memory. With 40K+ memories and a 0.6B model on remote Ollama, latency and compute cost compound. The structured output constraint plus post-processing is more reliable than asking the LLM to check itself. | Use structured output constraints (already in place) + deterministic post-processing validation. Let the schema enforce correctness at generation time, validate after. |
| **Custom fine-tuned NER model** | Fine-tuning a model specifically for Botmem's entity types requires training data, evaluation infrastructure, and ongoing maintenance. The generic model + structured output + post-processing is sufficient for a personal system. | Stay with qwen3:0.6b + JSON schema constraints + post-processing. If quality is still poor after all fixes, upgrade to a larger model (qwen3:1.7b) rather than fine-tuning. Model upgrade is a config change, not a code change. |
| **Real-time entity resolution across all memories** | Running entity resolution against the full memory corpus on every new ingestion is computationally prohibitive. Comparing each new entity against all existing entities creates O(n) growth per ingest. | Batch entity resolution as a periodic maintenance job (nightly or weekly). During ingestion, do simple exact-match dedup within the single memory only. |
| **Complex ontology / OWL schema** | Building a formal ontology (class hierarchies, property constraints, reasoning rules) is massive overkill for 10 entity types in a personal system. The taxonomy does not need inheritance or property constraints. | Keep the flat enum taxonomy. Add a simple alias table only if normalization is needed later. The 10 canonical types are: person, organization, location, event, product, topic, pet, group, device, other. |
| **User-defined entity types** | Allowing users to add custom entity types re-opens the taxonomy proliferation problem and requires schema migration, UI updates, and prompt changes for every new type. | The 10 canonical types cover personal memory use cases comprehensively. "other" exists as escape hatch. If a new type is genuinely needed, add it as a code change with prompt update. |
| **Retroactive entity linking to contacts** | Trying to link all extracted "person" entities back to the contacts table after enrichment creates a coupling between the entity extraction and contact resolution systems that does not exist today. Contact resolution happens during the embed step, not the enrich step. | Keep contact resolution in the embed step where it already works. Entity extraction in the enrich step produces standalone entity references. They serve different purposes: contacts are for identity resolution, entities are for knowledge graph nodes. |

## Feature Dependencies

```
Source type fix (photos-immich) --- independent, no dependencies
    |
    +---> Source type backfill (re-tag existing records in rawEvents, memories, Qdrant)

Entity post-processing layer --- independent
  (combines: empty filtering + intra-memory dedup + garbage type rejection + type validation)

Entity misclassification fix (prompt improvement) --- independent
    |
    +---> Benefits from post-processing layer being in place first (catches remaining errors)

Entity format unification --- independent
    |
    +---> Audit: verify embed step does not write to memories.entities

Source type auto-detection --- independent (defense-in-depth, can ship anytime)
    |
    +---> Goes in embed.processor.ts, before memory record creation

Backfill pipeline --- depends on ALL extraction fixes being complete first
    +--- Requires: source type fix, entity post-processing, prompt improvement, format unification
    +--- Must be idempotent (handle existing memory links)
    +--- Must be throttled (not starve live sync/embed/enrich jobs)
    +--- Needs progress tracking for UI

Backfill progress UI --- depends on backfill pipeline
    +--- Reuses existing job progress WebSocket infrastructure
```

## MVP Recommendation

The v2.1 milestone should focus exclusively on table stakes. The problems are concrete, the fixes are well-scoped, and the current data quality is actively harming search and graph usability.

**Prioritize (Phase 1 -- Extraction Fixes):**
1. Source type fix in photos-immich connector (one-line change)
2. Entity post-processing layer: empty filtering + intra-memory dedup + type validation + garbage rejection (single function in `enrich.service.ts`, applied after `extractEntities()`)
3. Entity misclassification prompt improvement (add type definitions and disambiguation rules to `entityExtractionPrompt()`)
4. Entity format audit and unification (verify stored format, document canonical shape)
5. Source type auto-detection safety net in embed processor

**Prioritize (Phase 2 -- Backfill):**
6. Source type backfill for existing photo records (SQL UPDATE on `rawEvents`, `memories`, and Qdrant `set_payload`)
7. Entity re-enrichment backfill using corrected pipeline (BullMQ batch job via existing `backfill` queue, throttled)
8. Backfill progress UI (reuse existing job WebSocket infrastructure)

**Defer to later milestone:**
- Cross-memory entity resolution: High complexity, requires new infrastructure, not blocking basic functionality
- Entity normalization: Requires resolution infrastructure first
- Entity confidence scoring: Small model produces unreliable confidence; fix extraction quality first
- Enrichment quality metrics: Valuable but not blocking; add after backfill proves fixes work

## Complexity Assessment

| Feature | Effort | Risk | Rationale |
|---------|--------|------|-----------|
| Source type fix | Hours | None | Literal one-line change in connector + SQL backfill |
| Entity post-processing | Hours | Low | Pure validation/filtering code, no model changes |
| Prompt improvement | Hours | Low | Prompt engineering, testable with sample inputs |
| Entity format audit | Hours | Low | Read code, verify behavior, document |
| Source type auto-detection | Hours | Low | Metadata inspection in embed processor |
| Source type backfill | Half day | Low | SQL UPDATE + Qdrant scroll/set_payload batch |
| Entity re-enrichment backfill | 2-3 days | Med | Must be idempotent, handle link dedup, throttle, track progress |
| Backfill progress UI | Hours | Low | Reuses existing job infrastructure |
| Cross-memory entity resolution | 1-2 weeks | High | New table, resolution algorithm, migration, fuzzy matching |

## Sources

- Ollama structured outputs documentation: https://docs.ollama.com/capabilities/structured-outputs
- Reliable Structured Output from Local LLMs: https://markaicode.com/ollama-structured-output-pipeline/
- Constrained LLM output with Ollama and Qwen3: https://medium.com/@rosgluk/constraining-llms-with-structured-output-ollama-qwen3-python-or-go-2f56ff41d720
- Entity Resolution at Scale (knowledge graph dedup strategies): https://medium.com/@shereshevsky/entity-resolution-at-scale-deduplication-strategies-for-knowledge-graph-construction-7499a60a97c3
- Entity-Resolved Knowledge Graphs (Neo4j tutorial): https://neo4j.com/blog/developer/entity-resolved-knowledge-graphs/
- NER complete guide (post-processing patterns): https://kairntech.com/blog/articles/the-complete-guide-to-named-entity-recognition-ner/
- LLM-empowered Knowledge Graph Construction survey: https://arxiv.org/html/2510.20345v1
- Taxonomy-Driven Knowledge Graph Construction: https://aclanthology.org/2025.findings-acl.223.pdf
- Botmem codebase: `apps/api/src/memory/prompts.ts`, `enrich.service.ts`, `embed.processor.ts`, `ollama.service.ts`, `packages/connector-sdk/src/types.ts`, `packages/connectors/photos-immich/src/index.ts`

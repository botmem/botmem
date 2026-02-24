
# Personal Memory RAG System (Single-Person, Multimodal, Fact/Fiction-Aware)

## Summary
Build a local-first memory platform that ingests atomic events (emails, messages, photos, locations), normalizes them into a unified memory schema, and supports cross-modal retrieval with weighted ranking (semantic relevance + recency + importance + trust).  
Use Qwen embedding/reranker models via Ollama at `192.168.10.250` (configured by env var), optimized for latency on RTX 3070.  
Add a separate fact/fiction pipeline that stores all memories but labels confidence and provenance.

## Scope and Goals
1. In scope:
1. Ingest and normalize messages, emails, photos (textified), and locations.
2. Store searchable memory with vector + metadata + relationship links.
3. Retrieve memory from text, message snippets, contact context, image-derived text, and location/time filters.
4. Compute memory weights for relevance, recency, importance, and trust.
5. Classify incoming memory as `FACT`, `UNVERIFIED`, or `FICTION` with confidence.
6. Ship a Docker Compose stack with DB, vector DB, visualization, workers, and API.
2. Out of scope (v1):
1. Native image embedding retrieval (deferred; image retrieval via OCR/caption/metadata).
2. Multi-person identity graph (single target person only).
3. Automatic deletion policy engine (manual/admin-driven in v1).

## System Architecture
1. `ingest-api`:
1. Receives connector events and manual uploads.
2. Validates, deduplicates, and enqueues normalization jobs.
2. `normalizer-worker`:
1. Converts raw input into canonical `MemoryEvent`.
2. Extracts entities, claims, and evidence references.
3. Generates embeddings and sparse terms.
3. `retrieval-api`:
1. Handles query parsing, ANN/hybrid retrieval, reranking, weighted scoring, and response assembly.
4. `fact-fiction-worker`:
1. Runs claim extraction + evidence retrieval + factuality inference.
2. Persists label, confidence, and explanation.
5. Storage:
1. PostgreSQL for canonical memory/events/claims/weights/audit.
2. Qdrant for dense vectors and filtered ANN search.
3. MinIO for raw artifacts (image/email attachments).
4. Redis for queue/cache/job state.
6. Visualization:
1. `vector-viz` service (Streamlit) for PCA/UMAP projection from Qdrant + metadata overlays.
2. `pgadmin` for relational inspection.
3. Qdrant dashboard for collection-level ops.

## Public APIs / Interfaces / Types
1. `POST /v1/memories/ingest`
1. Input: `source_type`, `source_id`, `person_id`, `event_time`, `payload`, `provenance`.
2. Output: `memory_id`, `status`, `dedupe_status`.
2. `POST /v1/memories/query`
1. Input: `query`, optional `query_type` (`text|image_text|location|contact|hybrid`), filters, `top_k`.
2. Output: ranked list with `memory_id`, `score_breakdown`, `fact_label`, `confidence`, `citations`.
3. `GET /v1/memories/{id}`
1. Returns canonical event + linked claims + source artifacts + weight timeline.
4. `POST /v1/factuality/evaluate`
1. Re-evaluates factuality for one memory or a set.
5. `POST /v1/weights/recompute`
1. Recomputes recency/importance/trust scores in batch.
6. Core types:
1. `MemoryEvent`: atomic normalized unit (message/email/photo/location event).
2. `MemoryClaim`: extracted proposition linked to event.
3. `EvidenceLink`: supports/contradicts/related references.
4. `MemoryWeight`: `{semantic, rerank, recency, importance, trust, final}`.
5. `FactualityLabel`: `FACT | UNVERIFIED | FICTION`.

## Data Model (Decision Complete)
1. PostgreSQL tables:
1. `persons(id, display_name, timezone, created_at)`
2. `memories(id, person_id, source_type, source_id, event_time, ingest_time, canonical_text, metadata_json, dedupe_hash, artifact_uri, status)`
3. `memory_entities(memory_id, entity_type, entity_value, confidence)`
4. `memory_claims(id, memory_id, claim_text, claim_type, extracted_at)`
5. `memory_evidence(id, claim_id, evidence_memory_id, relation, score)`
6. `memory_weights(memory_id, semantic, rerank, recency, importance, trust, final, computed_at)`
7. `factuality(memory_id, label, confidence, rationale_json, model_version, evaluated_at)`
8. `memory_links(src_memory_id, dst_memory_id, link_type, strength)`
9. `ingest_audit(id, source_type, source_id, outcome, reason, created_at)`
2. Qdrant collections:
1. `memory_dense_v1`: vector + payload (`memory_id`, `person_id`, `source_type`, `event_time`, tags).
2. `memory_sparse_v1` (optional v1.1 for hybrid sparse+dense if needed).

## Ingestion and Normalization
1. Connector adapters:
1. Email (IMAP/API export), message exports/APIs, photo library metadata, location history.
2. Normalize all to event schema with strict UTC timestamps + source provenance.
2. Content extraction:
1. Messages/emails: clean text, participants, thread ids.
2. Photos: OCR text + caption generation + EXIF + geodata.
3. Locations: semantic place label + lat/lon + dwell intervals.
3. Dedupe:
1. Deterministic hash on `(source_type, source_id, canonical_text_digest, event_time_bucket)`.
2. Near-duplicate detection via embedding cosine threshold for merge candidates.
4. Embedding instruction strategy (from Qwen paper direction):
1. Use task instruction prefixes consistently by memory/query type.
2. Store normalized vectors and keep room for Matryoshka-style dim truncation policy later.

## Retrieval and Ranking
1. Query understanding:
1. Detect intent type (`who/when/where/what/media`) and constraints.
2. Convert image/text/location input into text query + structured filters.
2. Candidate generation:
1. Qdrant ANN top `N=200`.
2. Postgres metadata filter pre/post ANN (`person_id`, date range, source type, contact ids, location bbox).
3. Optional lexical boost from Postgres FTS.
3. Reranking:
1. Qwen reranker on top `K=50` candidate memory snippets.
2. Return rerank logits and normalized rerank score.
4. Final weighted score:
1. `final = 0.40*semantic + 0.30*rerank + 0.15*recency + 0.10*importance + 0.05*trust` (v1 defaults).
2. `recency = exp(-lambda * age_days)` with `lambda=0.015`.
3. `importance` boosted by repeated recall, direct person mention, and user pinning.
4. `trust` from provenance reliability + factuality confidence.
5. Reinforcement:
1. Each successful retrieval click/save raises `importance` with capped increment.
2. Nightly decay job updates recency and final score.

## Fact/Fiction Subsystem
1. Policy:
1. Always store memories.
2. Label memories with factuality instead of dropping.
2. Pipeline:
1. Extract claims from canonical text.
2. Retrieve internal evidence memories relevant to each claim.
3. Score support/contradiction using reranker + LLM judge prompt.
4. Produce `FACT`, `UNVERIFIED`, or `FICTION` with confidence and rationale.
3. Provenance-driven truth weighting:
1. Each source has base trust weight (manual config).
2. Contradictions resolved by weighted evidence and recency.
4. UI/Query behavior:
1. Default retrieval includes all labels.
2. Filters: `facts_only`, `exclude_fiction`, `confidence >= x`.
3. Result cards show provenance and factuality explanation.

## Model Strategy for RTX 3070 + Remote Ollama
1. Connection:
1. Use env var `OLLAMA_BASE_URL=http://192.168.10.250:11434`.
2. No Ollama container in compose; app points to external endpoint.
2. Latency-first model defaults:
1. Embedding: smallest available new Qwen embedding variant (`0.6B` class) on Ollama.
2. Reranker: smallest available new Qwen reranker variant (`0.6B` class) on Ollama.
3. Quantization:
1. Prefer `Q8_0` if latency target is met.
2. Fallback to `Q4_K_M` when VRAM pressure appears.
4. Startup benchmark gate (automatic):
1. Run fixed micro-benchmark on service boot over 200 sample chunks.
2. Select fastest model tag meeting minimum quality threshold.
3. Persist chosen tags in DB/settings for reproducibility.

## Docker Compose Dependencies (v1)
1. Services:
1. `api` (FastAPI)
2. `worker` (Celery/Arq)
3. `postgres` (+ `pgvector`)
4. `qdrant`
5. `redis`
6. `minio`
7. `pgadmin`
8. `vector-viz` (Streamlit + UMAP/Plotly)
9. `prometheus` + `grafana` (basic observability)
2. Volumes:
1. Persistent volumes for Postgres, Qdrant, MinIO.
3. Secrets/config:
1. `.env` includes `OLLAMA_BASE_URL`, model tags, trust weights, and connector creds.
2. App startup fails fast if Ollama endpoint is unreachable.

## Testing and Acceptance Criteria
1. Ingestion tests:
1. Each modality maps to valid `MemoryEvent`.
2. Dedupe blocks exact duplicates and flags near duplicates.
2. Retrieval tests:
1. Text query retrieves expected memory in top 5 for curated benchmark set.
2. Contact/time/location filters strictly constrain results.
3. Image-textified query returns relevant photos via OCR/caption fields.
3. Ranking tests:
1. Recency decay changes ordering as expected.
2. Importance reinforcement increases rank after repeated access.
4. Fact/fiction tests:
1. Conflicting claims produce non-default label and confidence.
2. Low-evidence claims become `UNVERIFIED`, not forced `FACT`.
5. Performance tests (3070 + remote Ollama):
1. P95 query latency target: `<1200ms` for `top_k=10`.
2. Ingest embedding throughput target: `>=40 memory events/sec` batch mode.
6. Reliability tests:
1. Ollama endpoint down triggers clear error and retry behavior.
2. Queue backpressure does not lose ingest events.

## Rollout Plan
1. Phase 0: skeleton services, schemas, compose stack, health checks.
2. Phase 1: ingestion + normalization + embedding + ANN retrieval.
3. Phase 2: reranker integration + weighted scoring + recency/importance jobs.
4. Phase 3: fact/fiction labeling pipeline + query filters + rationale exposure.
5. Phase 4: vector visualization dashboards + tuning + benchmark harness.

## Assumptions and Defaults Locked
1. Single-person memory system in v1.
2. Modalities in v1: messages, emails, photos (textified), locations.
3. Memory unit: atomic events.
4. Fact/fiction policy: store all, label with confidence.
5. Truth conflict policy: provenance-weighted evidence + recency.
6. Deployment: external Ollama endpoint via env var; testing on RTX 3070 host.
7. Priority: latency-first model selection.

## Source References
1. Qwen paper you provided: [arXiv 2601.04720 PDF](https://arxiv.org/pdf/2601.04720)
2. Qwen official model repo/docs: [QwenLM GitHub](https://github.com/QwenLM/Qwen3-Embedding)
3. Ollama model library reference (for tag availability/workflow): [Ollama Library](https://ollama.com/library)


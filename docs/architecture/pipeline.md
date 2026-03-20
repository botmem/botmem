# Ingestion Pipeline

The pipeline transforms raw data from external services into searchable, enriched memories. It operates as a multi-stage process driven by BullMQ queues.

## Pipeline Overview

```
Connector.sync()
  |
  v
[raw_events table] ---- immutable payload store
  |
  v
[sync queue] SyncProcessor (concurrency: 2)
  |
  v
[clean queue] CleanProcessor
  |-- Normalize text (strip HTML, collapse whitespace)
  |-- Validate payload structure
  |
  v
[embed queue] EmbedProcessor (concurrency: 4)
  |-- Parse raw event payload
  |-- Create Memory record in PostgreSQL
  |-- Resolve participants -> Contacts (dedup by email/phone/handle)
  |-- Generate embedding via AI backend (mxbai-embed-large 1024d / Gemini 3072d)
  |-- Upsert document into Typesense
  |-- Route file events to file queue
  |-- Enqueue enrich job
  |
  +-- [file queue] FileProcessor (for photo/document events)
  |     |-- Download file from source (using account auth)
  |     |-- Extract content by MIME type:
  |     |     Images  -> VL model description
  |     |     PDF     -> pdf-parse text extraction
  |     |     DOCX    -> mammoth text extraction
  |     |     XLSX    -> xlsx to markdown tables
  |     |     Text    -> direct content
  |     |-- Update memory text with extracted content
  |     |-- Re-embed with new text
  |     |-- Enqueue enrich job
  |
  v
[enrich queue] EnrichProcessor (concurrency: 2)
  |-- Extract entities via text model (qwen3:8b / mistral-nemo)
  |     Returns: [{type, value, confidence}]
  |-- Classify factuality
  |     Returns: {label, confidence, rationale}
  |-- Compute importance weights
  |-- Find similar memories via Typesense (threshold: 0.8)
  |-- Create graph links (memory_links table)
  |-- Store final weights in memory record
```

## Stage Details

### Stage 1: Sync

The `SyncProcessor` orchestrates the connector's `sync()` method:

1. Loads the account and its auth context (decrypting credentials with the user's recovery key)
2. Creates a job record for tracking
3. Calls `connector.sync(ctx)` with a `SyncContext`
4. Listens for `data`, `progress`, and `log` events
5. Each `data` event is written to the `rawEvents` table and a clean job is enqueued
6. Updates the account's cursor and sync timestamp on completion

The sync queue has a concurrency of 2, meaning two connectors can sync simultaneously.

### Stage 2: Clean

The `CleanProcessor` normalizes raw event payloads:

1. Strips HTML tags, styles, and scripts
2. Collapses excessive whitespace
3. Validates the payload structure
4. Enqueues the cleaned event for embedding

### Stage 3: Embed

The `EmbedProcessor` is the core of the pipeline:

**Input:** `{ rawEventId: string }`

1. **Read raw event** — fetches the immutable payload from `rawEvents`
2. **Parse payload** — extracts the `ConnectorDataEvent` from JSON
3. **Skip empty** — events with no text content are discarded
4. **Create memory** — inserts a new record in the `memories` table with status `pending`
5. **Route files** — if `sourceType === 'file'`, routes to the file queue instead of embedding directly
6. **Resolve contacts** — connector-specific logic to extract and merge participants:
   - **Gmail:** parses From/To/CC headers; for Google Contacts, stores full metadata and avatars
   - **Slack:** looks up profiles from `participantProfiles` metadata
   - **WhatsApp:** resolves sender phone number and push name
   - **iMessage:** handles email and phone identifiers
   - **Photos:** resolves Immich face tags and downloads thumbnails
7. **Generate embedding** — calls the AI backend with the text (truncated to 8000 chars)
8. **Upsert into Typesense** — upserts the document with embedding and metadata
9. **Update status** — sets `embeddingStatus` to `done`
10. **Enqueue enrichment** — adds an enrich job to the queue

The embed queue has configurable concurrency (default 4, adjustable via settings API).

### Stage 4: File Processing

The `FileProcessor` handles photo and document events:

**Input:** `{ memoryId: string }`

1. **Read memory** — fetches the memory record for file URL and MIME type
2. **Build auth headers** — constructs authentication headers based on connector type
3. **Download file** — fetches the file from the source service
4. **Extract content** — routes by MIME type:
   - **Images** (`image/*`): converts to base64, sends to VL model for description
   - **PDFs** (`application/pdf`): uses `pdf-parse` for text extraction
   - **DOCX**: uses `mammoth` for raw text extraction
   - **Spreadsheets** (XLSX, XLS, CSV): uses `xlsx` to convert to markdown tables
   - **Plain text** (`text/*`): reads directly
5. **Truncate** — content is capped at 10,000 characters
6. **Update memory** — appends extracted content to the memory text
7. **Re-embed** — generates a new embedding for the updated text
8. **Enqueue enrichment** — sends to the enrich queue

### Stage 5: Enrichment

The `EnrichProcessor` adds intelligence to memories:

**Input:** `{ memoryId: string }`

1. **Entity extraction** — sends the memory text to the text model with a structured prompt. Extracts entities like:

   ```json
   [
     { "type": "person", "value": "John Smith", "confidence": 0.95 },
     { "type": "organization", "value": "Acme Corp", "confidence": 0.88 },
     { "type": "topic", "value": "Q3 budget", "confidence": 0.82 }
   ]
   ```

2. **Factuality classification** — classifies the memory as FACT, UNVERIFIED, or FICTION:

   ```json
   {
     "label": "FACT",
     "confidence": 0.9,
     "rationale": "Direct email from verified sender with specific details"
   }
   ```

3. **Graph link creation** — queries Typesense for the top 5 similar memories (by vector similarity). Creates `related` links for any with similarity >= 0.8.

4. **Weight computation** — calculates and stores base weights:
   ```typescript
   const recency = Math.exp(-0.015 * ageDays);
   const importance = 0.5 + Math.min(entityCount * 0.1, 0.4);
   const trust = TRUST_SCORES[connectorType] || 0.7;
   ```

## Error Handling

Each stage uses exponential backoff for retries:

| Queue  | Attempts | Initial Delay |
| ------ | -------- | ------------- |
| embed  | 2        | 2,000 ms      |
| file   | 2        | 2,000 ms      |
| enrich | 2        | 1,000 ms      |

Failed embed jobs set the memory's `embeddingStatus` to `failed`. These can be retried via:

```bash
curl -X POST http://localhost:12412/api/memories/retry-failed \
  -H "Authorization: Bearer $TOKEN"
```

## Performance Characteristics

- **Embed latency**: ~200-500ms per memory (depending on text length and AI backend response time)
- **File processing**: ~5-15 seconds for images (VL model), ~1-3 seconds for documents
- **Enrichment**: ~2-5 seconds per memory (two AI calls + Typesense search)
- **Throughput**: with Ollama concurrency 4, ~500-1000 memories/minute; with OpenRouter concurrency 64, significantly higher

## Monitoring

Pipeline progress is visible through:

1. **WebSocket events** — real-time updates on `/events` channel `logs`
2. **Queue statistics** — `GET /api/jobs/queues` returns counts for each queue
3. **Job logs** — `GET /api/logs?accountId=...` returns per-job log entries
4. **Memory stats** — `GET /api/memories/stats` shows totals by source and connector

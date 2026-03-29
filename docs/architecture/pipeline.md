# Ingestion Pipeline

The pipeline transforms raw data from external services into searchable, enriched memories. It operates as a 2-stage process driven by BullMQ queues.

## Pipeline Overview

```
Connector.sync()
  |
  v
[raw_events table] ---- immutable payload store
  |
  v
[sync queue] SyncProcessor (concurrency: 2)
  |  Orchestrates connector, writes raw events, enqueues memory jobs
  |
  v
[memory queue] MemoryProcessor (concurrency: 4)
  |-- 1.  Load raw event (one DB query)
  |-- 2.  Parse: extract text + metadata per sourceType
  |-- 3.  File parse: ContentCleaner.parseFile() via liteparse
  |-- 4.  Clean: ContentCleaner.cleanText() per sourceType
  |-- 5.  Resolve contacts: PeopleService.resolveParticipants()
  |-- 6.  Create Memory record (embeddingStatus: 'pending')
  |-- 7.  Embed: generate vector via AiService
  |-- 8.  Enrich inline (best-effort):
  |       - Entity extraction (emails/documents only)
  |       - Factuality classification
  |       - Compute weights
  |-- 9.  Encrypt: single AES-256-GCM pass
  |-- 10. Compute search_tokens from plaintext (before encryption)
  |-- 11. Update memory: one DB write, pipelineComplete=true
  |-- 12. Upsert document into Typesense
  |-- 13. Create links + corroborate factuality
```

## Stage Details

### Stage 1: Sync

The `SyncProcessor` orchestrates the connector's `sync()` method:

1. Loads the account and its auth context (decrypting credentials with the user's recovery key)
2. Creates a job record for tracking
3. Calls `connector.sync(ctx)` with a `SyncContext`
4. Listens for `data`, `progress`, and `log` events
5. Each `data` event is written to the `rawEvents` table and a memory job is enqueued
6. Updates the account's cursor and sync timestamp on completion

The sync queue has a concurrency of 2, meaning two connectors can sync simultaneously.

### Stage 2: Memory Processing

The `MemoryProcessor` handles the entire lifecycle from raw event to queryable memory in a single pass. This replaces the previous multi-stage pipeline (clean, embed, enrich) with one unified processor.

**Input:** `{ rawEventId: string }`

#### Step 1: Load Raw Event

Fetches the immutable payload from `rawEvents` in a single DB query.

#### Step 2: Parse Payload

Extracts the `ConnectorDataEvent` from JSON. Events with no text content are discarded.

#### Step 3: File Parsing (ContentCleaner)

If the event has a file attachment, `ContentCleaner.parseFile()` extracts text content using `liteparse`:

| Format | Library | Notes |
| ------ | ------- | ----- |
| PDF | liteparse | Replaces pdf-parse |
| DOCX | liteparse | Replaces mammoth |
| XLSX, XLS | liteparse | Spreadsheet to text |
| PPTX | liteparse | Presentation slides |
| ODS | liteparse | OpenDocument spreadsheets |
| CSV, TSV | liteparse | Tabular data |
| RTF | liteparse | Rich text |
| Images | VL model / multimodal embedding | Description or direct embedding |
| Plain text | Direct read | No conversion needed |

#### Step 4: Content Cleaning (ContentCleaner)

`ContentCleaner.cleanText()` applies source-type-specific cleaning rules:

**Email cleaning** (`sourceType: 'email'`):
- HTML to plain text conversion via `html-to-text`
- Signature stripping (`-- \n`, `Sent from my iPhone`, etc.) via `email-reply-parser`
- Quoted reply chain removal (`> On Mar 15, John wrote:`)
- Forwarded message header stripping

**Message cleaning** (`sourceType: 'message'`):
- Slack formatting: `<@U123456>` to `@user`, `<#C123|channel>` to `#channel`
- WhatsApp formatting: `*bold*` to `bold`, `_italic_` to `italic`, `~strike~` to `strike`
- System message filtering (joined, left, changed topic)
- "shared contact:" noise removal

**All source types**:
- Sanitize control characters
- Normalize whitespace
- Collapse excessive line breaks

#### Step 5: Contact Resolution

Connector-specific logic to extract and merge participants:
- **Gmail:** parses From/To/CC headers; for Google Contacts, stores full metadata and avatars
- **Slack:** looks up profiles from `participantProfiles` metadata
- **WhatsApp:** resolves sender phone number and push name
- **iMessage:** handles email and phone identifiers
- **Photos:** resolves Immich face tags and downloads thumbnails

#### Step 6: Create Memory

Inserts a new record in the `memories` table with status `pending`.

#### Step 7: Generate Embedding

Calls the AI backend with the cleaned text (truncated to 6,000 chars). Supports `mxbai-embed-large` (1024d), Gemini multimodal (3072d), or OpenRouter models.

#### Step 8: Inline Enrichment

Best-effort enrichment via `enrichInline()` (wrapped in try/catch so failures do not block the memory):

1. **Entity extraction** — sends the memory text to the text model with a structured prompt. Extracts entities like persons, organizations, topics, dates, amounts, locations.

2. **Factuality classification** — classifies the memory as FACT, UNVERIFIED, or FICTION based on source reliability, specificity, language cues, and connector trust.

3. **Weight computation** — calculates base weights for importance and trust.

This runs inline rather than in a separate queue, eliminating a round-trip DB load/decrypt cycle.

#### Step 9: Encryption

A single AES-256-GCM encryption pass encrypts sensitive fields (text, entities, metadata, factuality). The previous pipeline performed double encryption across separate processors.

#### Step 10: Search Tokens

Computes `search_tokens` from the plaintext (before encryption) for fast filtered lookups.

#### Step 11: Database Update

A single DB write updates the memory with all enriched fields and sets `pipelineComplete=true`.

#### Step 12: Typesense Upsert

Upserts the document into the Typesense `memories` collection with embedding, metadata, and search fields.

#### Step 13: Link Creation + Factuality Corroboration

1. **`createLinks()`** — queries Typesense for the top 5 similar memories by vector similarity. Creates `supports` links (similarity >= 0.92) and `contradicts` links (similarity >= 0.85 when one side is FICTION). Creates `related` links for any with similarity >= 0.8.

2. **`corroborateFactuality()`** — rule-based promotion from UNVERIFIED to FACT when cross-connector `supports` links exist. See [Memory Model: Factuality Corroboration](/architecture/memory-model#factuality-corroboration) for thresholds.

## Error Handling

The memory queue uses exponential backoff for retries:

| Queue  | Attempts | Initial Delay |
| ------ | -------- | ------------- |
| memory | 2        | 2,000 ms      |

Failed jobs set the memory's `embeddingStatus` to `failed`. These can be retried via:

```bash
curl -X POST http://localhost:12412/api/memories/retry-failed \
  -H "Authorization: Bearer $TOKEN"
```

## Performance Characteristics

- **Memory processing latency**: ~2-8 seconds per memory (parsing + embedding + enrichment combined)
- **File processing**: ~5-15 seconds for images, ~1-3 seconds for documents (included in memory processing)
- **Throughput**: with Ollama concurrency 4, ~500-1000 memories/minute; with OpenRouter/Gemini, significantly higher

## Monitoring

Pipeline progress is visible through:

1. **WebSocket events** — real-time `job:progress` updates on `/events`
2. **Job list** — `GET /api/jobs` returns job records with progress/total
3. **Memory stats** — `GET /api/memories/stats` shows totals by source and connector

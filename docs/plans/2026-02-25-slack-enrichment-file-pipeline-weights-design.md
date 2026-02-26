# Slack Enrichment, Shared File Pipeline, Weight Breakdown Fix

Date: 2026-02-25

## 1. Contact Enrichment with Slack Profiles

### Problem
`fetchUserMap()` in Slack sync only stores `id -> name`. Contacts created from Slack have only a `slack_id` identifier, preventing cross-connector merge when the same person appears in Gmail (email), WhatsApp (phone), etc.

### Solution
Expand `fetchUserMap()` to return full profile data: `{name, realName, email, phone, title, avatarUrl}`. The `users.list` API already returns profile fields when the token has `users:read.email` and `users.profile:read` scopes.

Emit profile data in event metadata as `participantProfiles: Record<string, UserProfile>`. Participants array stays as usernames for text display.

Update `resolveSlackContacts` in `embed.processor.ts` to read `metadata.participantProfiles` and create multiple identifier types per participant: `slack_id`, `email`, `phone`, `name`. This enables automatic cross-connector contact merge.

## 2. Shared File Processing Pipeline

### Problem
Slack file attachments are noted as `[file: IMG_7914.png (png)]` in message text but the actual content is never downloaded or embedded. Immich photos have their own VL description logic hardcoded in `enrich.processor.ts`. No shared infrastructure for processing files from any connector.

### Solution
New BullMQ queue `file` with `FileProcessor` in `apps/api/src/memory/file.processor.ts`.

### Flow
```
Connector sync emits file event (sourceType: 'file')
  -> rawEvent
  -> [embed queue] creates memory shell + enqueues file job
  -> [file queue] FileProcessor:
      1. Download file using stored account credentials
      2. Route by MIME type:
         - image/* -> Ollama VL model -> text description
         - text/*, text/csv -> read content directly
         - application/pdf -> pdf-parse -> extracted text
      3. Update memory text with extracted content
      4. Re-embed with new text (generate vector, upsert Qdrant)
      5. Enqueue to enrich queue
```

### Connector changes

**Slack sync**: When a message has files, emit a separate event per file with `sourceType: 'file'` containing `{url_private, mimetype, name, size, parentMessageId}` in metadata. Parent message keeps `[file: name.png]` annotation.

**Immich migration**: Move `describePhoto` logic from `enrich.processor.ts` into `FileProcessor`. Immich sync emits `sourceType: 'file'` with image URL + auth in metadata. VL description logic becomes shared.

### File handling by type

| MIME | Handler | Output |
|------|---------|--------|
| `image/*` | Ollama VL model | Description text |
| `application/pdf` | `pdf-parse` | Markdown (preserves structure) |
| `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | `mammoth` | Markdown (headings, lists, tables) |
| `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `.xls`, `.csv` | `xlsx` | Markdown tables per sheet |
| `text/*` | Direct read | Markdown-wrapped text |

### Storage
Downloaded files stored temporarily in `data/tmp/` during processing, deleted after embedding. No permanent file storage — the extracted text/description IS the memory.

## 3. Weight Breakdown Fix

### Problem
The `weights` column in the memories table has defaults `{semantic:0, rerank:0, recency:0, importance:0.5, trust:0.5, final:0}`. The enrich processor never updates it. Search computes weights live but only returns a single `score`. List view shows raw DB defaults — hence all zeros in the UI.

### Solution
**Enrich processor** computes and stores base weights after entity extraction + factuality:
```
recency = exp(-0.015 * ageDays)
importance = 0.5 + min(entityCount * 0.1, 0.4)
trust = TRUST_SCORES[connectorType]
weights = {semantic: 0, rerank: 0, recency, importance, trust, final: 0}
```

**Search endpoint** overrides with live-computed weights including semantic score from Qdrant, computes final score, returns full breakdown alongside results.

**List endpoint** returns stored weights as-is (recency slightly stale but acceptable).

**Frontend** already reads `memory.weights` — no changes needed.

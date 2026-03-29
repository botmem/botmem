# Memory Model

The memory model is the core data structure in Botmem. Every piece of ingested data — an email, a chat message, a photo, a location point — becomes a memory with standardized fields, vector embeddings, and quality scores.

## Memory Schema

```typescript
interface Memory {
  id: string; // UUID primary key
  userId: string; // Owner user ID
  accountId: string | null; // Source account reference
  connectorType: string; // gmail, slack, whatsapp, etc.
  sourceType: string; // email, message, photo, location, file
  sourceId: string; // Unique ID from the source service
  text: string; // Searchable text content
  eventTime: string; // When the event occurred (ISO 8601)
  ingestTime: string; // When Botmem ingested it (ISO 8601)
  factuality: string; // JSON: {label, confidence, rationale}
  weights: string; // JSON: {semantic, recency, importance, trust, final}
  entities: string; // JSON array: [{type, value, confidence}]
  metadata: string; // JSON: connector-specific data
  embeddingStatus: string; // pending, done, or failed
  createdAt: string; // Record creation time (ISO 8601)
}
```

All JSON fields are stored as text in PostgreSQL and parsed at the application layer.

## Scoring Formula

When you search for memories, each result receives a **final score** computed from multiple weighted factors.

### Weights

Weights are intent-dependent (`recall` vs `browse`) with per-connector scaling adjustments. All scoring constants are defined in `apps/api/src/memory/search.constants.ts`.

```
# With reranker (recall intent):
final = 0.40 * semantic + 0.30 * rerank + 0.15 * recency + 0.10 * importance + 0.05 * trust

# Without reranker (recall intent):
final = 0.40 * semantic + 0.25 * recency + 0.20 * importance + 0.15 * trust

# Browse intent:
final = 0.40 * semantic + 0.40 * recency + 0.15 * importance + 0.05 * trust
```

### Weight Components (recall intent)

| Weight | Factor       | Range     | Description                                                            |
| ------ | ------------ | --------- | ---------------------------------------------------------------------- |
| 0.40   | `semantic`   | 0.0 - 1.0 | Typesense vector similarity between query and memory embeddings        |
| 0.30   | `rerank`     | 0.0 - 1.0 | Optional second-pass reranker score (TEI, Ollama, or Jina backends)    |
| 0.25   | `recency`    | 0.0 - 1.0 | Exponential decay from event time: `exp(-0.005 * age_days)` in search  |
| 0.20   | `importance` | 0.0 - 1.0 | Base 0.5, boosted by entity count: `0.5 + min(entityCount * 0.1, 0.4)` |
| 0.15   | `trust`      | 0.0 - 1.0 | Connector-specific base trust score                                    |

### Recency Decay

Search uses a gentle decay rate (`-0.005`) so older memories still surface. The decay processor uses a steeper rate (`-0.015`) for batch importance decay:

```typescript
// Search scoring
const recency = Math.exp(-0.005 * ageDays);

// Decay processor (batch job)
const decayRate = Math.exp(-0.015 * ageDays);
```

| Age      | Search Recency | Decay Processor |
| -------- | -------------- | --------------- |
| Today    | 1.00           | 1.00            |
| 1 week   | 0.97           | 0.90            |
| 1 month  | 0.86           | 0.64            |
| 3 months | 0.64           | 0.26            |
| 6 months | 0.41           | 0.07            |
| 1 year   | 0.16           | 0.004           |

This means recent memories are strongly preferred, but old memories with high semantic relevance can still surface.

### Trust Scores by Connector

| Connector   | Trust | Rationale                                   |
| ----------- | ----- | ------------------------------------------- |
| `gmail`     | 0.95  | Verified email with authenticated sender    |
| `slack`     | 0.90  | Workspace-authenticated, identity verified  |
| `photos`    | 0.85  | EXIF-verified timestamps, GPS data          |
| `locations` | 0.85  | Device GPS sensor data                      |
| `whatsapp`  | 0.80  | E2E encrypted, phone-based identity         |
| `imessage`  | 0.80  | Local database, no server verification      |
| `manual`    | 0.70  | User or agent input, no source verification |

### Importance Calculation

Base importance is 0.5. It increases with the number of extracted entities (people, organizations, topics):

```typescript
const importance = 0.5 + Math.min(entityCount * 0.1, 0.4);
```

| Entities | Importance |
| -------- | ---------- |
| 0        | 0.50       |
| 1        | 0.60       |
| 3        | 0.80       |
| 4+       | 0.90       |

## Factuality System

Every memory carries a factuality assessment with three components:

```json
{
  "label": "FACT",
  "confidence": 0.9,
  "rationale": "Direct email from verified sender with specific dates and amounts"
}
```

### Labels

| Label        | Description                                               | Example                            |
| ------------ | --------------------------------------------------------- | ---------------------------------- |
| `FACT`       | Corroborated by multiple sources or high-trust connectors | Official email with specific dates |
| `UNVERIFIED` | Default; single-source, no contradiction found            | A casual mention in a chat message |
| `FICTION`    | Contradicted by evidence or flagged by model              | A joke or hypothetical scenario    |

### How Factuality is Classified

The enrichment processor sends the memory text to the AI backend with context about the source type and connector type. The model returns a classification based on:

- **Source reliability** — emails from known senders are more trustworthy than anonymous chat messages
- **Specificity** — memories with specific dates, amounts, or references are more likely to be factual
- **Language cues** — hedging language ("I think", "maybe") reduces confidence
- **Connector trust** — the base trust score of the connector influences the classification

## Entity Extraction

The enrichment processor extracts structured entities from memory text:

```json
[
  { "type": "person", "value": "John Smith", "confidence": 0.95 },
  { "type": "organization", "value": "Acme Corporation", "confidence": 0.88 },
  { "type": "topic", "value": "Q3 budget review", "confidence": 0.82 },
  { "type": "date", "value": "March 15, 2026", "confidence": 0.9 },
  { "type": "amount", "value": "$250,000", "confidence": 0.85 }
]
```

Entity types include: `person`, `organization`, `topic`, `date`, `amount`, `location`, `product`, `event`.

## Contact Resolution

During the embed phase, person/group/organization entities are resolved into unified contacts in the `people` table. The goal is **one contact per real person across all connectors**.

### Merge Rules

Contacts merge automatically when they share any of these **universal identifiers**:

| Identifier         | Example            | Drives merge?                      |
| ------------------ | ------------------ | ---------------------------------- |
| `email`            | `john@example.com` | Yes                                |
| `phone`            | `+14155551234`     | Yes                                |
| `name` (2+ words)  | `John Smith`       | Yes (exact match, accent-stripped) |
| `slack_id`         | `U0ABC123`         | No — stored but not mergeable      |
| `telegram_id`      | `12345678`         | No — stored but not mergeable      |
| `immich_person_id` | `uuid`             | No — stored but not mergeable      |

### Name Normalization

Display names are normalized before hashing for dedup:

- Accents stripped (NFD decompose, remove combining marks): `Amélie` → `Amelie`
- Lowercased: `John Smith` → `john smith`
- Whitespace collapsed, zero-width chars removed
- Single-word names (e.g. "John") do **not** trigger merges — too ambiguous

### Entity Type

Entity type (`person`, `group`, `organization`, `device`) is set at contact creation and never overwritten. A contact created as `person` stays `person` even if later referenced from a group entity.

### Connector Entity Patterns

| Connector        | Entity ID format                          | Merge-driving fields |
| ---------------- | ----------------------------------------- | -------------------- |
| Gmail            | `email:x@y.com\|name:John`                | email, name          |
| Slack (messages) | `name:John\|email:x@y.com`                | email, name          |
| Slack (contacts) | `name:John\|slack_id:U123\|email:x@y.com` | email, name          |
| WhatsApp         | `phone:+1234\|name:John`                  | phone, name          |
| iMessage         | `email:x@y.com` or `phone:+1234`          | email, phone         |

## Vector Embeddings

Each memory is embedded using the configured AI backend:

- **Ollama** (default): `mxbai-embed-large` — 1024-dimensional vectors
- **OpenRouter**: `google/gemini-embedding-001` — 3072-dimensional vectors

Vectors are stored in Typesense with a cosine similarity index. The embedding text is truncated to 8,000 characters to stay within model context limits.

### Typesense Document

Each document in Typesense carries metadata for filtered search:

```json
{
  "memory_id": "memory-uuid",
  "source_type": "email",
  "connector_type": "gmail",
  "event_time": "2026-01-15T10:30:00Z",
  "account_id": "account-uuid",
  "user_id": "user-uuid"
}
```

This enables queries like "search only Gmail emails" or "search photos from last month."

## Factuality Corroboration

After link creation, `corroborateFactuality()` runs a rule-based promotion from UNVERIFIED to FACT based on cross-connector `supports` links. This is pure SQL + logic with no AI calls.

### Promotion Rules

1. Query all `supports` links for the memory
2. Count distinct `connectorType` values among supporting neighbors
3. Promote (never demote):

| Condition | New Label | Confidence |
| --------- | --------- | ---------- |
| 2+ cross-connector supports | FACT | 0.90 |
| 1 cross-connector support | FACT | 0.80 |
| Same-connector supports only | UNVERIFIED (unchanged) | 0.65 |

4. One-level cascade: when a memory is promoted, its immediate neighbors are re-evaluated

Cross-connector corroboration means the same information appears in different data sources (e.g., an email and a Slack message both reference the same meeting), providing independent verification.

## Search Diversity

Search results use greedy interleaved reranking to prevent a single connector from dominating results.

### Algorithm

1. Sort all candidates by score descending
2. Group candidates by `connectorType`
3. For each slot: pick the highest-scored candidate from the **least-represented** connector, if its score is within `diversityFactor` of the globally best remaining candidate
4. If no diverse candidate is within the threshold, pick the globally best candidate

### Parameters

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `diversityFactor` | number (0-1) | 0.15 | Maximum score sacrifice for diversity. 0 = no diversity, 1 = full round-robin |

Pass `diversityFactor` in the `POST /memories/search` request body.

## Scoring Constants

All magic numbers for scoring, linking, and search are centralized in `apps/api/src/memory/search.constants.ts`. Key values:

| Constant | Value | Purpose |
| -------- | ----- | ------- |
| `MIN_SCORE` | 0.35 | Minimum score to include in results |
| `HYBRID_K_MULTIPLIER` | 3 | Overfetch factor for Typesense |
| `HYBRID_K_CAP` | 250 | Max k for Typesense queries |
| `RECENCY_DECAY_RATE` | 0.005 | Search recency decay |
| `DIVERSITY_FACTOR_DEFAULT` | 0.15 | Default diversity threshold |
| `SUPPORTS_THRESHOLD` | 0.92 | Min similarity for `supports` link |
| `CONTRADICTS_THRESHOLD` | 0.85 | Min similarity for `contradicts` link |
| `MAX_EMBED_CHARS` | 6000 | Truncate text before embedding |

Scoring profiles (browse, recall, recall+rerank, recall+rerank-no-semantic) are also defined in this file as `SCORING_PROFILES`.

## Content Cleaning

Text stored in memories is cleaned before embedding and indexing. The `ContentCleaner` service applies per-sourceType rules:

### Email (`sourceType: 'email'`)
- HTML converted to plain text via `html-to-text`
- Signatures stripped (`-- \n`, `Sent from my iPhone`, corporate disclaimers)
- Quoted reply chains removed (`> On Mar 15, John wrote:`)
- Forwarded message headers stripped

### Message (`sourceType: 'message'`)
- Slack formatting normalized: `<@U123>` to `@user`, `<#C123|channel>` to `#channel`
- WhatsApp formatting stripped: `*bold*` to `bold`, `_italic_` to `italic`
- System messages filtered (joined, left, changed topic)
- "shared contact:" low-value messages removed

### All Source Types
- Control characters sanitized
- Whitespace normalized and collapsed
- Excessive line breaks removed

This means search queries match against cleaned text, not raw HTML or formatting markup.

## Quota Enforcement

In cloud mode (Firebase auth, Stripe billing), free-plan users are limited to **500 memories total** across all connectors. Pro subscribers and self-hosted deployments have no limit.

### Enforcement points

1. **EmbedProcessor** (primary) — before the memory INSERT, `QuotaService.canCreateMemory()` checks the user's total memory count. If the limit is reached, the memory is skipped (not thrown — the job succeeds with a warning log). Raw events are preserved in `rawEvents` so they can be re-processed after an upgrade.

2. **Sync trigger** (advisory) — when a sync is triggered via `JobsService.triggerSync()`, a pre-check emits a `quota:warning` WebSocket event if the user is at the limit. The sync still proceeds (contacts and groups update regardless).

### What counts

- Only rows in the `memories` table count toward the quota.
- Contacts, contact identifiers, memory-contact links, and raw events are excluded.
- The count query: `SELECT COUNT(*) FROM memories WHERE account_id IN (SELECT id FROM accounts WHERE user_id = $userId)`.

### Caching

Memory counts are cached in-process for 30 seconds to avoid repeated DB queries during high-throughput sync. After each successful INSERT, the cache is incremented in-place.

### API

- `GET /api/billing/quota` — returns `{ quota: { used, limit, remaining }, unlimited }`.
- `GET /api/billing/info` — includes `quota` field alongside plan/status info.

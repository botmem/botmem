# Memory Model

The memory model is the core data structure in Botmem. Every piece of ingested data -- an email, a chat message, a photo, a location point -- becomes a memory with standardized fields, vector embeddings, and quality scores.

## Memory Schema

```typescript
interface Memory {
  id: string;                  // UUID primary key
  accountId: string | null;    // Source account reference
  connectorType: string;       // gmail, slack, whatsapp, etc.
  sourceType: string;          // email, message, photo, location, file
  sourceId: string;            // Unique ID from the source service
  text: string;                // Searchable text content
  eventTime: string;           // When the event occurred (ISO 8601)
  ingestTime: string;          // When Botmem ingested it (ISO 8601)
  factuality: string;          // JSON: {label, confidence, rationale}
  weights: string;             // JSON: {semantic, rerank, recency, importance, trust, final}
  entities: string;            // JSON array: [{type, value, confidence}]
  claims: string;              // JSON array: extracted factual claims
  metadata: string;            // JSON: connector-specific data
  embeddingStatus: string;     // pending, done, or failed
  createdAt: string;           // Record creation time (ISO 8601)
}
```

All JSON fields are stored as text in SQLite and parsed at the application layer.

## Scoring Formula

When you search for memories, each result receives a **final score** computed from multiple weighted factors:

```
final = 0.40 * semantic + 0.25 * recency + 0.20 * importance + 0.15 * trust
```

### Weight Components

| Weight | Factor | Range | Description |
|---|---|---|---|
| 0.40 | `semantic` | 0.0 - 1.0 | Qdrant cosine similarity between query and memory embeddings |
| 0.25 | `recency` | 0.0 - 1.0 | Exponential decay from event time: `exp(-0.015 * age_days)` |
| 0.20 | `importance` | 0.0 - 1.0 | Base 0.5, boosted by entity count: `0.5 + min(entityCount * 0.1, 0.4)` |
| 0.15 | `trust` | 0.0 - 1.0 | Connector-specific base trust score |

### Recency Decay

The recency function uses exponential decay with a half-life of approximately 46 days:

```typescript
const recency = Math.exp(-0.015 * ageDays);
```

| Age | Recency Score |
|---|---|
| Today | 1.00 |
| 1 week | 0.90 |
| 1 month | 0.64 |
| 3 months | 0.26 |
| 6 months | 0.07 |
| 1 year | 0.004 |

This means recent memories are strongly preferred, but old memories with high semantic relevance can still surface.

### Trust Scores by Connector

| Connector | Trust | Rationale |
|---|---|---|
| `gmail` | 0.95 | Verified email with authenticated sender |
| `slack` | 0.90 | Workspace-authenticated, identity verified |
| `photos` | 0.85 | EXIF-verified timestamps, GPS data |
| `locations` | 0.85 | Device GPS sensor data |
| `whatsapp` | 0.80 | E2E encrypted, phone-based identity |
| `imessage` | 0.80 | Local database, no server verification |
| `manual` | 0.70 | User or agent input, no source verification |

### Importance Calculation

Base importance is 0.5. It increases with the number of extracted entities (people, organizations, topics):

```typescript
const importance = 0.5 + Math.min(entityCount * 0.1, 0.4);
```

| Entities | Importance |
|---|---|
| 0 | 0.50 |
| 1 | 0.60 |
| 3 | 0.80 |
| 4+ | 0.90 |

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

| Label | Description | Example |
|---|---|---|
| `FACT` | Corroborated by multiple sources or high-trust connectors | Official email with specific dates |
| `UNVERIFIED` | Default; single-source, no contradiction found | A casual mention in a chat message |
| `FICTION` | Contradicted by evidence or flagged by model | A joke or hypothetical scenario |

### How Factuality is Classified

The enrichment processor sends the memory text to Ollama with context about the source type and connector type. The model returns a classification based on:

- **Source reliability** -- emails from known senders are more trustworthy than anonymous chat messages
- **Specificity** -- memories with specific dates, amounts, or references are more likely to be factual
- **Language cues** -- hedging language ("I think", "maybe") reduces confidence
- **Connector trust** -- the base trust score of the connector influences the classification

## Entity Extraction

The enrichment processor extracts structured entities from memory text:

```json
[
  {"type": "person", "value": "John Smith", "confidence": 0.95},
  {"type": "organization", "value": "Acme Corporation", "confidence": 0.88},
  {"type": "topic", "value": "Q3 budget review", "confidence": 0.82},
  {"type": "date", "value": "March 15, 2026", "confidence": 0.90},
  {"type": "amount", "value": "$250,000", "confidence": 0.85}
]
```

Entity types include: `person`, `organization`, `topic`, `date`, `amount`, `location`, `product`, `event`.

## Vector Embeddings

Each memory is embedded using Ollama's `nomic-embed-text` model, producing a 768-dimensional vector. These vectors are stored in Qdrant with a cosine similarity index.

The embedding text is truncated to 8,000 characters to stay within the model's context window (4,096 tokens, approximately 4 characters per token, with a safety margin).

### Qdrant Payload

Each vector point in Qdrant carries metadata for filtered search:

```json
{
  "source_type": "email",
  "connector_type": "gmail",
  "event_time": "2026-01-15T10:30:00Z",
  "account_id": "account-uuid"
}
```

This enables queries like "search only Gmail emails" or "search photos from last month."

# Memories API

::: info Authentication
All endpoints require `Authorization: Bearer <token>` header. See [Authentication](/guide/authentication).
:::

## Search Memories

Performs semantic search across all memories using vector similarity in Qdrant.

```
POST /api/memories/search
```

### Request Body

```json
{
  "query": "coffee meeting with John",
  "filters": {
    "connectorType": "gmail",
    "sourceType": "email",
    "contactId": "contact-uuid",
    "factualityLabel": "FACT"
  },
  "limit": 10
}
```

| Field                     | Type   | Required | Description                               |
| ------------------------- | ------ | -------- | ----------------------------------------- |
| `query`                   | string | Yes      | Natural language search query             |
| `filters`                 | object | No       | Optional filters                          |
| `filters.connectorType`   | string | No       | Filter by connector type                  |
| `filters.sourceType`      | string | No       | Filter by source type                     |
| `filters.contactId`       | string | No       | Filter to memories involving this contact |
| `filters.factualityLabel` | string | No       | Filter by factuality label                |
| `limit`                   | number | No       | Max results (default: 20)                 |

### Response

```json
[
  {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "text": "Hi team, let's meet for coffee tomorrow at 10am...",
    "sourceType": "email",
    "connectorType": "gmail",
    "eventTime": "2026-01-15T10:30:00Z",
    "accountIdentifier": "user@gmail.com",
    "score": 0.87,
    "weights": {
      "semantic": 0.92,
      "rerank": 0,
      "recency": 0.78,
      "importance": 0.7,
      "trust": 0.95,
      "final": 0.87
    },
    "factuality": "{\"label\":\"FACT\",\"confidence\":0.9,\"rationale\":\"Direct email from known sender\"}",
    "entities": "[{\"type\":\"person\",\"value\":\"John\",\"confidence\":0.95}]",
    "metadata": "{\"from\":\"boss@company.com\",\"subject\":\"Coffee meeting\"}"
  }
]
```

Results are sorted by the `final` score (descending). The scoring formula is:

```
final = 0.40 * semantic + 0.30 * rerank + 0.15 * recency + 0.10 * importance + 0.05 * trust
```

---

## List Memories

List memories with pagination and optional filters, ordered by event time (newest first).

```
GET /api/memories
```

### Query Parameters

| Parameter       | Type   | Default | Description              |
| --------------- | ------ | ------- | ------------------------ |
| `limit`         | number | 50      | Page size                |
| `offset`        | number | 0       | Pagination offset        |
| `connectorType` | string | -       | Filter by connector type |
| `sourceType`    | string | -       | Filter by source type    |

### Response

```json
{
  "items": [
    {
      "id": "memory-uuid",
      "accountId": "account-uuid",
      "connectorType": "gmail",
      "sourceType": "email",
      "sourceId": "msg-12345",
      "text": "Email content...",
      "eventTime": "2026-01-15T10:30:00Z",
      "ingestTime": "2026-01-16T02:00:00Z",
      "factuality": "{...}",
      "weights": "{...}",
      "entities": "[...]",
      "claims": "[]",
      "metadata": "{...}",
      "embeddingStatus": "done",
      "createdAt": "2026-01-16T02:00:00Z",
      "accountIdentifier": "user@gmail.com"
    }
  ],
  "total": 15420
}
```

---

## Get Memory Stats

Returns aggregate statistics about the memory store.

```
GET /api/memories/stats
```

### Response

```json
{
  "total": 15420,
  "bySource": {
    "email": 8200,
    "message": 5100,
    "photo": 1800,
    "location": 320
  },
  "byConnector": {
    "gmail": 8500,
    "slack": 3200,
    "whatsapp": 1900,
    "photos": 1800
  },
  "byFactuality": {
    "FACT": 4200,
    "UNVERIFIED": 10800,
    "FICTION": 420
  }
}
```

---

## Get Memory Graph

Returns the relationship graph for visualization. Includes up to 500 recent memories with their links and associated contacts.

```
GET /api/memories/graph
```

### Response

```json
{
  "nodes": [
    {
      "id": "memory-uuid",
      "label": "Email about Q3 budget...",
      "type": "email",
      "connectorType": "gmail",
      "factuality": "FACT",
      "importance": 0.8,
      "cluster": 0,
      "nodeType": "memory",
      "entities": ["John", "Q3 budget"]
    },
    {
      "id": "contact-contact-uuid",
      "label": "John Smith",
      "type": "contact",
      "connectorType": "gmail",
      "factuality": "FACT",
      "importance": 0.8,
      "cluster": 0,
      "nodeType": "contact",
      "connectors": ["gmail", "slack"]
    }
  ],
  "edges": [
    {
      "source": "memory-uuid-1",
      "target": "memory-uuid-2",
      "type": "related",
      "strength": 0.85
    },
    {
      "source": "contact-contact-uuid",
      "target": "memory-uuid-1",
      "type": "involves",
      "strength": 0.7
    }
  ]
}
```

---

## Get Memory by ID

```
GET /api/memories/:id
```

### Response

Returns the full memory object, or `null` if not found.

---

## Create Memory

Create a manual memory. The memory will be automatically embedded and enqueued for enrichment.

```
POST /api/memories
```

### Request Body

```json
{
  "text": "The project deadline was moved to March 15th.",
  "sourceType": "manual",
  "connectorType": "manual"
}
```

| Field           | Type   | Required | Default  | Description          |
| --------------- | ------ | -------- | -------- | -------------------- |
| `text`          | string | Yes      | -        | Memory text content  |
| `sourceType`    | string | No       | `manual` | Source type label    |
| `connectorType` | string | No       | `manual` | Connector type label |

### Response

```json
{
  "id": "new-uuid",
  "text": "The project deadline was moved to March 15th.",
  "sourceType": "manual",
  "connectorType": "manual",
  "eventTime": "2026-02-20T10:00:00Z",
  "createdAt": "2026-02-20T10:00:00Z"
}
```

---

## Delete Memory

Removes a memory from both PostgreSQL and Qdrant.

```
DELETE /api/memories/:id
```

### Response

```json
{
  "ok": true
}
```

---

## Retry Failed Embeddings

Re-enqueues all memories with `embeddingStatus` of `failed` or stuck `pending`.

```
POST /api/memories/retry-failed
```

### Response

```json
{
  "enqueued": 15,
  "total": 15
}
```

---

## Backfill Contacts

Enqueues contact resolution for memories that do not yet have contact links.

```
POST /api/memories/backfill-contacts
```

### Response

```json
{
  "enqueued": 200,
  "total": 200
}
```

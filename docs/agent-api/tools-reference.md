# Tools Reference

The Botmem API exposes REST endpoints for querying and managing memories. All endpoints require authentication via Bearer token (access token or API key).

::: info Authentication
All requests must include `Authorization: Bearer <token>` header. See [Authentication](/guide/authentication) for details.
:::

## Agent Endpoints

### POST /api/agent/ask

Ask a question — the AI synthesizes an answer from relevant memories.

**Request:**

```json
{
  "question": "What did John say about the project deadline?",
  "limit": 10
}
```

**Response:**

```json
{
  "answer": "Based on your memories, John mentioned in a Slack message on Jan 15 that...",
  "sources": [
    {
      "id": "memory-uuid",
      "text": "John: the deadline is March 1st...",
      "score": 0.92
    }
  ]
}
```

### POST /api/agent/timeline

Build a chronological timeline for a topic.

**Request:**

```json
{
  "topic": "project launch",
  "limit": 20
}
```

### POST /api/agent/context

Get relevant context for a conversation topic.

**Request:**

```json
{
  "topic": "Q3 budget review"
}
```

### POST /api/agent/remember

Store a new memory.

**Request:**

```json
{
  "text": "The project deadline was moved to March 15th per John's email."
}
```

### GET /api/agent/entities

List extracted entities across all memories.

**Query Parameters:** `type` (optional, e.g. `person`, `organization`)

## Search & Memory Endpoints

### POST /api/memories/search

Semantic search across all memories. Returns scored, ranked results.

**Request:**

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

**Response:**

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
    "factuality": "{\"label\":\"FACT\",\"confidence\":0.9}",
    "entities": "[{\"type\":\"person\",\"value\":\"John\",\"confidence\":0.95}]",
    "metadata": "{\"from\":\"boss@company.com\",\"subject\":\"Coffee meeting\"}"
  }
]
```

### GET /api/memories

List memories with pagination. Query params: `limit`, `offset`, `connectorType`, `sourceType`.

### GET /api/memories/:id

Get a single memory by UUID.

### POST /api/memories

Create a manual memory. Body: `{ "text": "...", "sourceType": "manual", "connectorType": "manual" }`.

### DELETE /api/memories/:id

Delete a memory from PostgreSQL and Qdrant.

### GET /api/memories/stats

Aggregate statistics (totals by source, connector, factuality).

### GET /api/memories/graph

Relationship graph (nodes and edges) for visualization.

### POST /api/memories/retry-failed

Re-enqueue all failed or stuck memories.

## Contact Endpoints

### POST /api/contacts/search

Search contacts by name, email, phone, or any identifier.

**Request:**

```json
{
  "query": "John"
}
```

**Response:**

```json
[
  {
    "id": "contact-uuid-1",
    "displayName": "John Smith",
    "avatars": "[{\"url\":\"data:image/jpeg;base64,...\",\"source\":\"google\"}]",
    "metadata": "{\"organizations\":[{\"name\":\"Acme Corp\"}]}",
    "identifiers": [
      { "type": "email", "value": "john@acme.com", "connectorType": "gmail" },
      { "type": "slack_id", "value": "U0123ABCD", "connectorType": "slack" }
    ]
  }
]
```

### GET /api/contacts/:id

Get full contact details including all identifiers and metadata.

### GET /api/contacts/:id/memories

List all memories associated with a contact, including role (sender/recipient/mentioned).

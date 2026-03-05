# MCP Tools Reference

Every tool exposed by the Botmem MCP server is documented below with its input schema, description, and example request/response.

## search_memories

Semantic search across all memories. Returns scored, ranked results.

### Input Schema

```typescript
{
  query: z.string().describe("Natural language search query"),
  connectorType: z.string().optional().describe("Filter by connector: gmail, slack, whatsapp, imessage, photos, locations"),
  sourceType: z.string().optional().describe("Filter by type: email, message, photo, location, file"),
  contactId: z.string().optional().describe("Filter to memories involving this contact ID"),
  factualityLabel: z.string().optional().describe("Filter by factuality: FACT, UNVERIFIED, FICTION"),
  limit: z.number().optional().default(10).describe("Maximum results to return (default 10)")
}
```

### Example

**Request:**
```json
{
  "query": "coffee meeting with John",
  "connectorType": "gmail",
  "limit": 5
}
```

**Response:**
```json
[
  {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "text": "Hi team, let's meet for coffee tomorrow at 10am to discuss the Q3 budget. John will present the numbers.",
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
    "entities": "[{\"type\":\"person\",\"value\":\"John\",\"confidence\":0.95},{\"type\":\"topic\",\"value\":\"Q3 budget\",\"confidence\":0.88}]",
    "metadata": "{\"from\":\"boss@company.com\",\"to\":\"team@company.com\",\"subject\":\"Coffee meeting tomorrow\"}"
  }
]
```

## get_memory

Retrieve a single memory by its UUID.

### Input Schema

```typescript
{
  id: z.string().uuid().describe("Memory UUID")
}
```

### Example

**Request:**
```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

**Response:**
```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "accountId": "account-uuid",
  "connectorType": "gmail",
  "sourceType": "email",
  "sourceId": "msg-id-12345",
  "text": "Hi team, let's meet for coffee tomorrow...",
  "eventTime": "2026-01-15T10:30:00Z",
  "ingestTime": "2026-01-16T02:00:00Z",
  "factuality": "{\"label\":\"FACT\",\"confidence\":0.9,\"rationale\":\"Direct email\"}",
  "weights": "{\"semantic\":0,\"rerank\":0,\"recency\":0.78,\"importance\":0.7,\"trust\":0.95,\"final\":0}",
  "entities": "[{\"type\":\"person\",\"value\":\"John\",\"confidence\":0.95}]",
  "claims": "[]",
  "metadata": "{\"from\":\"boss@company.com\",\"subject\":\"Coffee meeting\"}",
  "embeddingStatus": "done",
  "createdAt": "2026-01-16T02:00:00Z"
}
```

## list_memories

List memories with pagination and optional filters. Results are ordered by event time (newest first).

### Input Schema

```typescript
{
  limit: z.number().optional().default(50).describe("Page size"),
  offset: z.number().optional().default(0).describe("Offset for pagination"),
  connectorType: z.string().optional().describe("Filter by connector type"),
  sourceType: z.string().optional().describe("Filter by source type")
}
```

### Example

**Request:**
```json
{
  "limit": 10,
  "offset": 0,
  "connectorType": "slack"
}
```

**Response:**
```json
{
  "items": [
    {
      "id": "...",
      "text": "Hey, the deploy is done!",
      "sourceType": "message",
      "connectorType": "slack",
      "eventTime": "2026-02-01T14:30:00Z",
      "accountIdentifier": "workspace-name",
      "embeddingStatus": "done"
    }
  ],
  "total": 1542
}
```

## store_memory

Create a new manual memory. Useful for agents to store facts, notes, or corrections.

### Input Schema

```typescript
{
  text: z.string().describe("The memory text content"),
  sourceType: z.string().optional().default("manual").describe("Source type label"),
  connectorType: z.string().optional().default("manual").describe("Connector type label")
}
```

### Example

**Request:**
```json
{
  "text": "The project deadline was moved from March 1st to March 15th per John's email."
}
```

**Response:**
```json
{
  "id": "new-memory-uuid",
  "text": "The project deadline was moved from March 1st to March 15th per John's email.",
  "sourceType": "manual",
  "connectorType": "manual",
  "eventTime": "2026-02-20T10:00:00Z",
  "createdAt": "2026-02-20T10:00:00Z"
}
```

The memory is automatically embedded and enqueued for enrichment.

## delete_memory

Remove a memory from both SQLite and Qdrant.

### Input Schema

```typescript
{
  id: z.string().uuid().describe("Memory UUID to delete")
}
```

### Example

**Request:**
```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

**Response:**
```json
{
  "ok": true
}
```

## search_contacts

Search contacts by name, email, phone, or any identifier.

### Input Schema

```typescript
{
  query: z.string().describe("Search query (name, email, phone, etc.)")
}
```

### Example

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
    "metadata": "{\"organizations\":[{\"name\":\"Acme Corp\",\"title\":\"VP Engineering\"}]}",
    "identifiers": [
      { "type": "email", "value": "john@acme.com", "connectorType": "gmail" },
      { "type": "slack_id", "value": "U0123ABCD", "connectorType": "slack" },
      { "type": "phone", "value": "+14155551234", "connectorType": "whatsapp" }
    ]
  }
]
```

## get_contact

Get full details for a contact including all identifiers and metadata.

### Input Schema

```typescript
{
  id: z.string().uuid().describe("Contact UUID")
}
```

### Example

**Request:**
```json
{
  "id": "contact-uuid-1"
}
```

**Response:**
```json
{
  "id": "contact-uuid-1",
  "displayName": "John Smith",
  "avatars": "[{\"url\":\"data:image/jpeg;base64,...\",\"source\":\"google\"}]",
  "metadata": "{\"organizations\":[{\"name\":\"Acme Corp\"}],\"birthday\":\"1985-03-15\"}",
  "createdAt": "2026-01-10T00:00:00Z",
  "updatedAt": "2026-02-15T00:00:00Z"
}
```

## get_contact_memories

List all memories associated with a specific contact.

### Input Schema

```typescript
{
  contactId: z.string().uuid().describe("Contact UUID")
}
```

### Example

**Request:**
```json
{
  "contactId": "contact-uuid-1"
}
```

**Response:**
```json
[
  {
    "id": "memory-uuid-1",
    "text": "Email from John about the budget review...",
    "sourceType": "email",
    "connectorType": "gmail",
    "eventTime": "2026-01-15T10:30:00Z",
    "role": "sender"
  },
  {
    "id": "memory-uuid-2",
    "text": "John: the numbers look good, let's proceed",
    "sourceType": "message",
    "connectorType": "slack",
    "eventTime": "2026-01-16T09:00:00Z",
    "role": "sender"
  }
]
```

## get_memory_stats

Get aggregate statistics about the memory store.

### Input Schema

No input required.

### Example

**Response:**
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

## get_memory_graph

Get the memory relationship graph (nodes and edges) for visualization or analysis. Returns up to 500 recent memories with their links and associated contacts.

### Input Schema

No input required.

### Example

**Response:**
```json
{
  "nodes": [
    {
      "id": "memory-uuid",
      "label": "Email about Q3 budget review...",
      "type": "email",
      "connectorType": "gmail",
      "factuality": "FACT",
      "importance": 0.8,
      "cluster": 0,
      "nodeType": "memory",
      "entities": ["John", "Q3 budget"]
    },
    {
      "id": "contact-uuid",
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
      "source": "contact-uuid",
      "target": "memory-uuid-1",
      "type": "involves",
      "strength": 0.7
    }
  ]
}
```

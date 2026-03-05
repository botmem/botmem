# Memory Graph

Botmem builds a relationship graph connecting memories and contacts. This graph enables exploration of how information is connected across sources and over time.

## Graph Structure

The graph consists of two types of nodes and three types of edges:

### Nodes

**Memory nodes** -- each memory is a node in the graph:
```json
{
  "id": "memory-uuid",
  "label": "Email about Q3 budget review...",
  "type": "email",
  "connectorType": "gmail",
  "factuality": "FACT",
  "importance": 0.8,
  "cluster": 0,
  "nodeType": "memory",
  "entities": ["John Smith", "Q3 budget"]
}
```

**Contact nodes** -- contacts appear as nodes connected to their associated memories:
```json
{
  "id": "contact-uuid",
  "label": "John Smith",
  "type": "contact",
  "connectorType": "gmail",
  "factuality": "FACT",
  "importance": 0.8,
  "cluster": 0,
  "nodeType": "contact",
  "connectors": ["gmail", "slack", "whatsapp"]
}
```

### Edge Types

| Type | Description | Created By |
|---|---|---|
| `related` | Two memories are semantically similar | EnrichProcessor (Qdrant similarity >= 0.8) |
| `supports` | One memory corroborates another | Future: conflict resolution |
| `contradicts` | Memories contain conflicting information | Future: conflict resolution |
| `involves` | A contact is associated with a memory | Contact resolution (all connectors) |

### Edge Properties

```json
{
  "source": "memory-uuid-1",
  "target": "memory-uuid-2",
  "type": "related",
  "strength": 0.85
}
```

The `strength` field (0.0 - 1.0) indicates how strong the relationship is. For `related` links, it is the Qdrant cosine similarity score. For `involves` links, it is fixed at 0.7.

## How Links Are Created

### Automatic Similarity Links

During enrichment, the `EnrichProcessor` queries Qdrant for the top 5 most similar memories to the current one. Any result with a cosine similarity >= 0.8 gets a `related` link:

```typescript
const SIMILARITY_THRESHOLD = 0.8;
const SIMILAR_MEMORY_LIMIT = 5;

const results = await this.qdrant.recommend(memoryId, SIMILAR_MEMORY_LIMIT);

for (const result of results) {
  if (result.score >= SIMILARITY_THRESHOLD && result.id !== memoryId) {
    // Create a 'related' link with the similarity score as strength
    await db.insert(memoryLinks).values({
      srcMemoryId: memoryId,
      dstMemoryId: result.id,
      linkType: 'related',
      strength: result.score,
    });
  }
}
```

### Contact-Memory Links

When the embed processor resolves participants, it creates entries in the `memory_contacts` table with a role:

| Role | Meaning | Created By |
|---|---|---|
| `sender` | The person who sent the message/email | Gmail (From), WhatsApp, iMessage, Slack |
| `recipient` | The person who received the message | Gmail (To/CC), WhatsApp (DM recipient) |
| `mentioned` | The person is mentioned in the content | Future: entity-based linking |
| `participant` | General participation (Google Contacts, photo tags) | Gmail Contacts, Immich |

## Entity-Based Clustering

The graph API groups memories into clusters based on shared entities. Memories that mention the same person or organization are assigned the same cluster number:

```typescript
const entityClusters = new Map<string, number>();

// If a memory mentions "John Smith" and another does too,
// they share the same cluster
const dominantEntity = entities.find(
  (e) => e.type === 'person' || e.type === 'organization'
);
if (dominantEntity) {
  const key = dominantEntity.value.toLowerCase();
  if (!entityClusters.has(key)) {
    entityClusters.set(key, nextCluster++);
  }
  cluster = entityClusters.get(key);
}
```

Contact nodes are also assigned to clusters when their display name matches an entity key.

## Querying the Graph

### REST API

```bash
# Get the full graph (up to 500 recent memories)
curl http://localhost:3001/api/memories/graph
```

Returns:
```json
{
  "nodes": [...],  // Memory nodes + Contact nodes
  "edges": [...]   // Related links + Contact-memory links
}
```

### Graph Visualization

The web UI renders the graph using `react-force-graph-2d` with:
- Node size based on importance score
- Node color based on connector type
- Edge width based on strength
- Cluster-based force grouping
- Click-to-expand for viewing memory details

## Use Cases

### Tracing Information Flow

Follow how a piece of information moved through your communication channels:
1. An email from John about the budget (Gmail)
2. A Slack message discussing the same numbers (#finance)
3. A WhatsApp message to your manager about the decision

The `related` links connect these memories, and the `involves` links show the people at each step.

### Finding Contradictions

When two memories have conflicting information (e.g., different budget numbers), they can be linked with type `contradicts`. The factuality system labels the less reliable version as `UNVERIFIED`.

### Contact Network

The graph reveals your communication network: who you talk to, across which channels, and about what topics. Contact nodes act as hubs connecting clusters of memories.

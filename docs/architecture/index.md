# System Design

Botmem is built as a modular, event-driven system where data flows through a series of processing stages from ingestion to queryable memory.

## Design Principles

### 1. Store Everything, Label Confidence

Botmem never deletes memories. Every piece of data is stored with a factuality label and confidence score. When sources contradict each other, both versions are kept and the conflict is recorded as a graph link with type `contradicts`.

### 2. Eventual Consistency

The system is designed around asynchronous processing. When a connector syncs data, events flow through BullMQ queues at their own pace. The web UI and API can query memories as soon as they are created, even before enrichment is complete.

### 3. Connector Isolation

Each connector is an independent package with its own authentication and sync logic. Connectors communicate with the core system only through the `ConnectorDataEvent` interface. This isolation means a bug in one connector cannot affect others.

### 4. Idempotent Processing

Each stage of the pipeline is idempotent. If an embed or enrich job fails, it can be safely retried without creating duplicates. Raw events are stored with a `sourceId` that prevents duplicate ingestion.

## High-Level Architecture

```
                     +-----------+
                     |  Web UI   |
                     |  :5173    |
                     +-----+-----+
                           |
                      HTTP / WS
                           |
+-----------+        +-----+-----+        +------------+
| Connectors|------->|  NestJS   |<------>|   SQLite   |
| (plugins) |  emit  |  API :3001|  ORM   |   (WAL)    |
+-----------+        +-----+-----+        +------------+
                           |
              +------------+------------+
              |            |            |
        +-----+----+ +----+-----+ +----+-----+
        |  Redis   | |  Qdrant  | |  Ollama  |
        |  BullMQ  | |  Vectors | |  LLM/VL  |
        |  :6379   | |  :6333   | |  :11434  |
        +----------+ +----------+ +----------+
```

## Module Dependency Graph

```
ConfigModule ──────────────────────────────────────┐
                                                   |
DbModule ─────────────────────────────────────┐    |
                                              |    |
SettingsModule ──────── (depends on Db) ──────┤    |
                                              |    |
LogsModule ──────────── (depends on Db) ──────┤    |
                                              |    |
EventsModule ─────────────────────────────────┤    |
                                              |    |
ContactsModule ──────── (depends on Db) ──────┤    |
                                              |    |
ConnectorsModule ────── (standalone) ─────────┤    |
                                              |    |
AccountsModule ──────── (depends on Db) ──────┤    |
                                              |    |
AuthModule ──────────── (depends on          |    |
                         Accounts,           |    |
                         Connectors) ─────────┤    |
                                              |    |
JobsModule ──────────── (depends on          |    |
                         Accounts,           |    |
                         BullMQ) ─────────────┤    |
                                              |    |
MemoryModule ────────── (depends on          |    |
                         Db, Contacts,       |    |
                         Ollama, Qdrant,     |    |
                         BullMQ, Logs,       |    |
                         Events, Settings) ───┘    |
                                                   |
AppModule ────────────── (root, imports all) ──────┘
```

## Data Model

The system operates on three core data entities:

### Memories

The central entity. Each memory represents a normalized event from any source -- an email, a chat message, a photo, a location point. Memories carry:

- **Text content** -- the searchable body
- **Vector embedding** -- 768-dimensional vector in Qdrant
- **Weights** -- semantic, recency, importance, trust scores
- **Factuality** -- label (FACT/UNVERIFIED/FICTION), confidence, rationale
- **Entities** -- extracted people, organizations, topics, dates
- **Claims** -- factual assertions extracted from the text

### Contacts

Deduplicated people resolved from memory participants. A single contact can have multiple identifiers (email, phone, Slack ID) across multiple connectors. Contacts store:

- **Display name** -- primary name
- **Avatars** -- photos from Google, Immich, or other sources
- **Metadata** -- organizations, birthday, addresses, etc.
- **Identifiers** -- typed key-value pairs linking to external accounts

### Memory Links

Graph edges connecting related memories. Created automatically during enrichment when Qdrant finds semantically similar memories:

- **related** -- the default type for similar memories (strength >= 0.8)
- **supports** -- one memory corroborates another
- **contradicts** -- memories contain conflicting information

## Processing Queues

| Queue | Concurrency | Purpose |
|---|---|---|
| `sync` | 2 | Orchestrates connector sync, writes raw events |
| `embed` | 4 (configurable) | Creates memories, generates embeddings, resolves contacts |
| `file` | default | Downloads files, extracts content, re-embeds |
| `enrich` | 2 (configurable) | Entity extraction, factuality, graph links |
| `backfill` | default | Retroactive processing of older memories |

All queues use exponential backoff for retries.

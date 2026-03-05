# Architecture Overview

Botmem is a monorepo built with pnpm workspaces and Turborepo. The system is designed around an event-driven pipeline that transforms raw data from external services into searchable, enriched memories.

## Monorepo Structure

```
botmem/
  apps/
    api/            NestJS 11 backend (REST + WebSocket)
    web/            React 19 + React Router 7 + Zustand 5 + Tailwind 4
  packages/
    connector-sdk/  BaseConnector abstract class + ConnectorRegistry
    connectors/
      gmail/        OAuth2, imports emails + contacts
      slack/        OAuth2 / user token, workspace messages
      whatsapp/     QR-code auth, message history via Baileys
      imessage/     Local tool, reads macOS iMessage database
      photos-immich/ API key, Immich photo library + facial recognition
    shared/         Cross-layer types (Memory, Job, ConnectorManifest, etc.)
  docs/             This documentation site (VitePress)
```

## Data Flow

The entire system is a four-stage pipeline driven by BullMQ queues:

```
+------------------+     +------------------+     +------------------+
|   Connector      |     |   Sync Queue     |     |   Embed Queue    |
|   .sync()        +---->+   SyncProcessor  +---->+   EmbedProcessor |
|                  |     |   concurrency: 2 |     |   concurrency: 4 |
+------------------+     +------------------+     +--------+---------+
                                                           |
                                              +------------+------------+
                                              |                         |
                                    +---------v--------+     +----------v--------+
                                    |   File Queue     |     |   Enrich Queue    |
                                    |   FileProcessor  |     |   EnrichProcessor |
                                    |   (photos, docs) |     |   concurrency: 2  |
                                    +------------------+     +-------------------+
```

### Stage 1: Sync

The connector pulls data from the external service and emits `ConnectorDataEvent` objects. The `SyncProcessor` writes each event to the `rawEvents` table (immutable payload store) and enqueues an embed job.

### Stage 2: Embed

The `EmbedProcessor` reads the raw event, creates a Memory record in SQLite, generates a vector embedding via Ollama (`nomic-embed-text`), stores the vector in Qdrant, and resolves participants into contacts. For file-type events (photos, documents), it routes to the File queue instead.

### Stage 3: File (optional)

The `FileProcessor` downloads the file, extracts text content (using Ollama VL for images, `pdf-parse` for PDFs, `mammoth` for DOCX, `xlsx` for spreadsheets), updates the memory text, re-embeds, and then enqueues an enrich job.

### Stage 4: Enrich

The `EnrichProcessor` extracts entities and claims via Ollama, classifies factuality (`FACT` / `UNVERIFIED` / `FICTION`), computes importance weights, and creates relationship graph links by finding similar memories in Qdrant.

## Storage Architecture

```
+-------------------+     +-------------------+     +-------------------+
|     SQLite        |     |     Qdrant        |     |     Redis         |
|  (WAL mode)       |     |  (Vector DB)      |     |  (BullMQ)         |
|                   |     |                   |     |                   |
|  - accounts       |     |  Collection:      |     |  Queues:          |
|  - jobs           |     |    memories       |     |    sync           |
|  - logs           |     |                   |     |    embed          |
|  - rawEvents      |     |  Payload:         |     |    file           |
|  - memories       |     |    memory_id      |     |    enrich         |
|  - memoryLinks    |     |    source_type    |     |    backfill       |
|  - contacts       |     |    connector_type |     |                   |
|  - contactIds     |     |    event_time     |     |                   |
|  - memoryContacts |     |    account_id     |     |                   |
|  - settings       |     |                   |     |                   |
+-------------------+     +-------------------+     +-------------------+
```

### SQLite

All structured data lives in a single SQLite database running in WAL (Write-Ahead Logging) mode for concurrent read performance. The schema is defined with Drizzle ORM. All IDs are UUIDs, all timestamps are ISO 8601 strings, and JSON columns are stored as text.

### Qdrant

Vector embeddings are stored in a Qdrant collection named `memories` using cosine similarity. Each point carries a payload with `memory_id`, `source_type`, `connector_type`, `event_time`, and `account_id` for filtered search.

### Redis

BullMQ uses Redis as its backing store. Five queues process work asynchronously: `sync`, `embed`, `file`, `enrich`, and `backfill`.

## API Architecture

The NestJS API is organized into modules:

| Module | Responsibility |
|---|---|
| `config/` | Environment variables and ConfigService |
| `db/` | SQLite initialization, Drizzle schema, DbService |
| `connectors/` | Connector registry and factory |
| `accounts/` | Account CRUD and credential management |
| `auth/` | OAuth flow orchestration and callback handling |
| `jobs/` | Job CRUD, sync triggering, queue statistics |
| `logs/` | Log persistence and retrieval |
| `events/` | WebSocket gateway (`/events`) for real-time updates |
| `memory/` | Search, ranking, embedding, BullMQ processors |
| `contacts/` | Contact dedup, identifier merging, suggestions |
| `settings/` | Runtime settings (concurrency, etc.) |

## Frontend Architecture

The React app uses:

- **React Router 7** for file-based routing
- **Zustand 5** for state management (stores for auth, connectors, jobs, memory)
- **Tailwind 4** for styling
- **react-force-graph-2d** for the memory relationship graph visualization
- **WebSocket** connection to `/events` for real-time job progress updates

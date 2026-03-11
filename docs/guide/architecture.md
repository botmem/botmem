# Architecture Overview

Botmem is a monorepo built with pnpm workspaces and Turborepo. The system is designed around an event-driven pipeline that transforms raw data from external services into searchable, enriched memories.

## Monorepo Structure

```
botmem/
  apps/
    api/            NestJS 11 backend (REST + WebSocket)
    web/            React 19 + React Router 7 + Zustand 5 + Tailwind 4
  packages/
    cli/            botmem CLI (human + JSON output)
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

The entire system is a multi-stage pipeline driven by BullMQ queues:

```
+------------------+     +------------------+     +------------------+
|   Connector      |     |   Sync Queue     |     |   Clean Queue    |
|   .sync()        +---->+   SyncProcessor  +---->+   CleanProcessor |
|                  |     |   concurrency: 2 |     |                  |
+------------------+     +------------------+     +--------+---------+
                                                           |
                                                  +--------v---------+
                                                  |   Embed Queue    |
                                                  |   EmbedProcessor |
                                                  |   concurrency: 4 |
                                                  +--------+---------+
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

The connector pulls data from the external service and emits `ConnectorDataEvent` objects. The `SyncProcessor` writes each event to the `rawEvents` table (immutable payload store) and enqueues a clean job.

### Stage 2: Clean

The `CleanProcessor` normalizes raw event text — stripping HTML, collapsing whitespace, and validating payload structure before enqueuing the embed job.

### Stage 3: Embed

The `EmbedProcessor` reads the raw event, creates a Memory record in PostgreSQL, generates a vector embedding via the AI backend (`mxbai-embed-large` 1024d or Gemini 3072d), stores the vector in Qdrant, and resolves participants into contacts. For file-type events (photos, documents), it routes to the File queue instead.

### Stage 4: File (optional)

The `FileProcessor` downloads the file, extracts text content (using the VL model for images, `pdf-parse` for PDFs, `mammoth` for DOCX, `xlsx` for spreadsheets), updates the memory text, re-embeds, and then enqueues an enrich job.

### Stage 5: Enrich

The `EnrichProcessor` extracts entities and claims via the text model, classifies factuality (`FACT` / `UNVERIFIED` / `FICTION`), computes importance weights, and creates relationship graph links by finding similar memories in Qdrant.

## Storage Architecture

```
+-------------------+     +-------------------+     +-------------------+
|   PostgreSQL      |     |     Qdrant        |     |     Redis         |
|   (Drizzle ORM)   |     |  (Vector DB)      |     |  (BullMQ + Cache) |
|                   |     |                   |     |                   |
|  - users          |     |  Collection:      |     |  Queues:          |
|  - accounts       |     |    memories       |     |    sync           |
|  - jobs           |     |                   |     |    clean          |
|  - logs           |     |  Payload:         |     |    embed          |
|  - rawEvents      |     |    memory_id      |     |    file           |
|  - memories       |     |    source_type    |     |    enrich         |
|  - memoryLinks    |     |    connector_type |     |    backfill       |
|  - contacts       |     |    event_time     |     |                   |
|  - contactIds     |     |    account_id     |     |  Recovery key     |
|  - memoryContacts |     |    user_id        |     |    cache (AES)    |
|  - apiKeys        |     |                   |     |                   |
|  - memoryBanks    |     |                   |     |                   |
+-------------------+     +-------------------+     +-------------------+
```

### PostgreSQL

All structured data lives in PostgreSQL 17. The schema is defined with Drizzle ORM. All IDs are UUIDs, all timestamps are ISO 8601 strings, and JSON columns are stored as text. Multi-user with `userId` foreign keys on all user-owned tables.

### Qdrant

Vector embeddings are stored in a Qdrant collection named `memories` using cosine similarity. Each point carries a payload with `memory_id`, `source_type`, `connector_type`, `event_time`, `account_id`, and `user_id` for filtered search.

### Redis

BullMQ uses Redis as its backing store. Six queues process work asynchronously: `sync`, `clean`, `embed`, `file`, `enrich`, and `backfill`. Redis also caches recovery keys (encrypted with APP_SECRET) for credential decryption.

## API Architecture

The NestJS API is organized into modules:

| Module          | Responsibility                                       |
| --------------- | ---------------------------------------------------- |
| `config/`       | Environment variables and ConfigService              |
| `db/`           | PostgreSQL initialization, Drizzle schema, DbService |
| `user-auth/`    | User registration, login, JWT tokens, recovery keys  |
| `crypto/`       | AES-256-GCM encryption/decryption of credentials     |
| `connectors/`   | Connector registry and factory                       |
| `accounts/`     | Account CRUD and credential management               |
| `auth/`         | OAuth flow orchestration and callback handling       |
| `jobs/`         | Job CRUD, sync triggering, queue statistics          |
| `logs/`         | Log persistence and retrieval                        |
| `events/`       | WebSocket gateway (`/events`) for real-time updates  |
| `memory/`       | Search, ranking, embedding, BullMQ processors        |
| `contacts/`     | Contact dedup, identifier merging, suggestions       |
| `agent/`        | AI-powered Q&A, timeline, context endpoints          |
| `api-keys/`     | API key management (`bm_sk_...`)                     |
| `memory-banks/` | Named memory collections                             |
| `billing/`      | Stripe subscription management (managed tier)        |
| `analytics/`    | PostHog event tracking                               |
| `settings/`     | Runtime settings (concurrency, etc.)                 |

## Frontend Architecture

The React app uses:

- **React Router 7** for file-based routing
- **Zustand 5** for state management (stores for auth, connectors, jobs, memory)
- **Tailwind 4** for styling
- **react-force-graph-2d** for the memory relationship graph visualization
- **WebSocket** connection to `/events` for real-time job progress updates

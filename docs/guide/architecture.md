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

The system uses a 2-stage pipeline driven by BullMQ queues:

```
+------------------+     +------------------+     +--------------------+
|   Connector      |     |   Sync Queue     |     |   Memory Queue     |
|   .sync()        +---->+   SyncProcessor  +---->+   MemoryProcessor  |
|                  |     |   concurrency: 2 |     |   concurrency: 4   |
+------------------+     +------------------+     +--------------------+
```

### Stage 1: Sync

The connector pulls data from the external service and emits `ConnectorDataEvent` objects. The `SyncProcessor` writes each event to the `rawEvents` table (immutable payload store) and enqueues a memory job.

### Stage 2: Memory Processing

The `MemoryProcessor` handles the entire lifecycle in a single pass: parses the raw event, cleans content (email signature/reply stripping via `email-reply-parser`, Slack/WA formatting cleanup, file parsing via `liteparse`), resolves contacts, creates a Memory record, generates a vector embedding, runs inline enrichment (entity extraction, factuality classification, weight computation), encrypts sensitive fields in a single pass, upserts to Typesense, and creates relationship graph links with factuality corroboration.

See [Pipeline Architecture](/architecture/pipeline) for the full 13-step breakdown.

## Storage Architecture

```
+-------------------+     +-------------------+     +-------------------+
|   PostgreSQL      |     |    Typesense      |     |     Redis         |
|   (Drizzle ORM)   |     |  (Search Engine)  |     |  (BullMQ + Cache) |
|                   |     |                   |     |                   |
|  - users          |     |  Collection:      |     |  Queues:          |
|  - accounts       |     |    memories       |     |    sync           |
|  - jobs           |     |                   |     |    memory         |
|  - logs           |     |  Fields:          |     |    backfill       |
|  - rawEvents      |     |    text           |     |                   |
|  - memories       |     |    source_type    |     |                   |
|  - memoryLinks    |     |    connector_type |     |                   |
|  - contacts       |     |    event_time     |     |                   |
|  - contactIds     |     |    account_id     |     |  Recovery key     |
|  - memoryContacts |     |    user_id        |     |    cache (AES)    |
|  - apiKeys        |     |    embedding      |     |                   |
|  - memoryBanks    |     |                   |     |                   |
+-------------------+     +-------------------+     +-------------------+
```

### PostgreSQL

All structured data lives in PostgreSQL 17. The schema is defined with Drizzle ORM. All IDs are UUIDs, all timestamps are ISO 8601 strings, and JSON columns are stored as text. Multi-user with `userId` foreign keys on all user-owned tables.

### Typesense

Typesense hosts a `memories` collection with hybrid BM25 + vector search (cosine similarity). Each document carries fields including `text`, `source_type`, `connector_type`, `event_time`, `account_id`, `user_id`, `people`, `entities_text`, and `embedding` (float[]) for filtered search.

### Redis

BullMQ uses Redis as its backing store. Two primary queues process work asynchronously: `sync` and `memory`, plus a `backfill` queue for maintenance tasks. Redis also caches recovery keys (encrypted with APP_SECRET) for credential decryption.

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

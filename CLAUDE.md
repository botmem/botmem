# Botmem — Personal Memory RAG System

Local-first platform that ingests events from multiple data sources (emails, messages, photos, locations), normalizes them into a unified memory schema, and provides cross-modal retrieval with weighted ranking.

## Quick Start

```bash
docker compose up -d          # PostgreSQL, Redis + Qdrant
pnpm install                  # Install all workspace deps
cp .env.example .env          # Configure environment (edit as needed)
pnpm dev                      # Builds deps, then API + web on :12412
```

## Monorepo Structure

```
apps/
  api/          NestJS 11 backend (REST + WebSocket)
  web/          React 19 + React Router 7 + Zustand 5 + Tailwind 4
packages/
  cli/             CLI tool (`botmem`) — human + JSON output for querying memories
  connector-sdk/   BaseConnector abstract class + ConnectorRegistry
  connectors/
    gmail/         OAuth2, imports emails + contacts
    slack/         OAuth2 / user token, workspace messages
    whatsapp/      QR-code auth, message history
    imessage/      Local tool, reads iMessage DB
    photos-immich/ Local tool, Immich photo library
  shared/          Cross-layer types (Memory, Job, ConnectorManifest, etc.)
```

## Stack

- **Runtime**: Node, TypeScript (ES2022, strict, ESNext modules)
- **Backend**: NestJS 11, Drizzle ORM + PostgreSQL
- **Queue**: BullMQ on Redis
- **Vector DB**: Qdrant (cosine similarity, auto-created collection)
- **AI**: Ollama (remote, default) or OpenRouter — swappable via `AI_BACKEND` env var
- **Frontend**: React 19, Vite 6, Zustand 5, Tailwind 4, react-force-graph-2d
- **Tooling**: pnpm 9.15 workspaces, Turbo 2.4, Vitest 3

## Environment Variables

| Variable                  | Default                               | Purpose                                             |
| ------------------------- | ------------------------------------- | --------------------------------------------------- |
| `PORT`                    | `12412`                               | API server port                                     |
| `DATABASE_URL`            | _(required)_                          | PostgreSQL connection string                        |
| `REDIS_URL`               | `redis://localhost:6379`              | BullMQ queue backend                                |
| `QDRANT_URL`              | `http://localhost:6333`               | Vector DB                                           |
| `OLLAMA_BASE_URL`         | `http://localhost:11434`              | Ollama inference endpoint                           |
| `OLLAMA_USERNAME`         | _(empty)_                             | Basic auth username (optional)                      |
| `OLLAMA_PASSWORD`         | _(empty)_                             | Basic auth password (optional)                      |
| `OLLAMA_EMBED_MODEL`      | `mxbai-embed-large`                   | Embedding model (1024d)                             |
| `OLLAMA_TEXT_MODEL`       | `qwen3:8b`                            | Text enrichment model (uses /no_think)              |
| `OLLAMA_VL_MODEL`         | `qwen3-vl:4b`                         | Vision-language model (photo enrichment)            |
| `AI_BACKEND`              | `ollama`                              | AI backend: `ollama` or `openrouter`                |
| `OPENROUTER_API_KEY`      | _(empty)_                             | OpenRouter API key (required if backend=openrouter) |
| `OPENROUTER_EMBED_MODEL`  | `google/gemini-embedding-001`         | OpenRouter embedding model (3072d)                  |
| `OPENROUTER_TEXT_MODEL`   | `mistralai/mistral-nemo`              | OpenRouter text enrichment model                    |
| `OPENROUTER_VL_MODEL`     | `google/gemma-3-4b-it`                | OpenRouter vision-language model                    |
| `EMBED_DIMENSION`         | _(auto-detected from model)_          | Override if model is not in known list              |
| `EMBED_BACKEND`           | _(follows AI_BACKEND)_                | Embedding backend: `ollama`, `openrouter`, `gemini` |
| `GEMINI_API_KEY`          | _(empty)_                             | Google API key (required if EMBED_BACKEND=gemini)   |
| `GEMINI_EMBED_MODEL`      | `gemini-embedding-2-preview`          | Gemini embedding model (multimodal)                 |
| `GEMINI_EMBED_DIMENSIONS` | `3072`                                | Gemini output vector dimensions                     |
| `FRONTEND_URL`            | `http://localhost:12412`              | CORS / OAuth redirect origin                        |
| `APP_SECRET`              | `dev-app-secret-change-in-production` | AES-256-GCM key for encrypting credentials at rest  |
| `PLUGINS_DIR`             | `./plugins`                           | External plugin directory                           |

Config lives in `apps/api/src/config/config.service.ts`.

## Connectors

A connector is a pluggable data source adapter extending `BaseConnector` from `@botmem/connector-sdk`.

### Connector interface

Every connector must implement:

- `manifest` — metadata (id, name, authType: `oauth2 | qr-code | api-key | local-tool`, configSchema)
- `initiateAuth(config)` — start auth flow (returns redirect URL or QR data)
- `completeAuth(params)` — finalize auth (returns tokens/credentials)
- `validateAuth(auth)` — check credentials still valid
- `revokeAuth(auth)` — revoke access
- `sync(ctx: SyncContext)` — pull data, emit `ConnectorDataEvent` objects via `this.emitData()`

Connectors are EventEmitters. During sync they emit `data`, `progress`, and `log` events.

### Adding a new connector

1. Create `packages/connectors/<name>/` with its own `package.json` (name: `@botmem/connector-<name>`)
2. Extend `BaseConnector`, implement all abstract methods
3. Export the connector class as default
4. Register in `ConnectorRegistry` (see `apps/api/src/connectors/connectors.service.ts`)

## Jobs & Queue System

BullMQ queues process work asynchronously through Redis:

| Queue      | Worker            | Purpose                                                                                 |
| ---------- | ----------------- | --------------------------------------------------------------------------------------- |
| `sync`     | `SyncProcessor`   | Orchestrates `connector.sync()`, writes to `rawEvents`                                  |
| `embed`    | `EmbedProcessor`  | Parses raw event, creates Memory, generates embedding, resolves contacts                |
| `enrich`   | `EnrichProcessor` | Extracts entities/claims, classifies factuality, computes importance, upserts to Qdrant |
| `backfill` | —                 | Retroactive enrichment of older memories                                                |

Job statuses: `queued → running → done | failed | cancelled`

Jobs table tracks progress (`progress`/`total` fields) and errors. The `EventsGateway` (WebSocket at `/events`) broadcasts real-time job progress to the frontend.

## Pipeline: Raw Event → Queryable Memory

```
Connector.sync()
  → rawEvents table (immutable payload store)
  → [sync queue] SyncProcessor
  → [embed queue] EmbedProcessor
      ├ Parse raw event payload
      ├ Create Memory record in SQLite
      ├ Generate embedding via Ollama
      ├ Resolve participants → Contacts (dedup by email/phone/handle)
      └ Enqueue enrich job
  → [enrich queue] EnrichProcessor
      ├ Extract entities (via Ollama VL + prompts)
      ├ Extract claims
      ├ Classify factuality (FACT / UNVERIFIED / FICTION)
      ├ Compute importance baseline
      ├ Update Memory with metadata
      └ Upsert vector → Qdrant collection
```

## Memory Model

Core design: **store everything, label confidence** — never delete memories, classify them instead.

### Scoring formula

```
final = 0.40×semantic + 0.30×rerank + 0.15×recency + 0.10×importance + 0.05×trust
recency = exp(-0.015 × age_days)
```

- `semantic` — Qdrant cosine similarity score
- `rerank` — optional second-pass reranker score
- `recency` — exponential decay from event time
- `importance` — boosted by repeated recall, direct mention, user pinning
- `trust` — connector base trust + factuality confidence

### Factuality labels

Every memory carries `{label, confidence, rationale}`:

- `FACT` — corroborated by multiple sources or high-trust connectors
- `UNVERIFIED` — default; single-source, no contradiction
- `FICTION` — contradicted by evidence or flagged by model

## Database Schema

PostgreSQL tables defined in `apps/api/src/db/schema.ts` (Drizzle ORM):

- `accounts` — connector accounts + encrypted auth context + sync cursor
- `jobs` — sync job tracking (status, progress, errors)
- `logs` — per-job log entries (info/warn/error/debug)
- `connectorCredentials` — OAuth credentials cache per connector type
- `rawEvents` — immutable ingested payloads (before normalization)
- `memories` — normalized events with text, weights, entities, claims, factuality
- `memoryLinks` — relationship graph (related / supports / contradicts)
- `contacts` — deduplicated people
- `contactIdentifiers` — email/phone/name/slack_id mappings to contact
- `memoryContacts` — memory ↔ contact associations with role (sender/recipient/mentioned)

Qdrant collection `memories`: dense vectors (cosine), payload includes `memory_id`, `source_type`, `connector_type`, `event_time`.

## API Modules

All under `apps/api/src/`:

| Module        | Purpose                                                                      |
| ------------- | ---------------------------------------------------------------------------- |
| `config/`     | Environment + ConfigService                                                  |
| `db/`         | PostgreSQL init, Drizzle schema, DbService                                   |
| `connectors/` | Connector registry + factory                                                 |
| `accounts/`   | Account CRUD, credential management                                          |
| `auth/`       | OAuth flow orchestration, callback handling                                  |
| `jobs/`       | Job CRUD, sync triggering, status tracking                                   |
| `logs/`       | Log persistence + retrieval                                                  |
| `events/`     | WebSocket gateway (`/events`) for real-time updates                          |
| `memory/`     | Search, ranking, embedding (OllamaService, QdrantService), BullMQ processors |
| `contacts/`   | Contact dedup, identifier merging                                            |
| `plugins/`    | Plugin/extension system (stub)                                               |

## Frontend

React app at `apps/web/src/`:

- `pages/` — Dashboard, ConnectorsPage, MemoryExplorerPage, Login, Onboarding
- `components/connectors/` — Setup modals, OAuth redirect, QR auth, sync progress
- `components/memory/` — Search input, results list, force-directed graph visualization
- `store/` — Zustand stores: authStore, connectorStore, jobStore, memoryStore

## Commands

```bash
pnpm dev          # Start all dev servers (Turbo)
pnpm build        # Build all packages
pnpm lint         # Lint everything
pnpm test         # Run Vitest across all workspaces
```

## Conventions

- All IDs are UUIDs (text primary keys in SQLite)
- All timestamps are ISO 8601 strings
- JSON columns stored as text, parsed at application layer
- Auth context is encrypted at rest in the `accounts` and `connectorCredentials` tables
- Connector packages are named `@botmem/connector-<name>`
- Shared types live in `@botmem/shared` — import from there, not from api internals
- Tests go in `__tests__/` directories adjacent to source, using Vitest
- SQLite runs in WAL mode for concurrent read performance

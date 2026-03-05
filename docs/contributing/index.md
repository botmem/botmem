# Contributing

This guide covers the development setup, monorepo structure, and conventions for contributing to Botmem.

## Development Setup

### Prerequisites

- **Node.js** 20+
- **pnpm** 9.15+ (`corepack enable && corepack prepare pnpm@9.15.0 --activate`)
- **Docker** and Docker Compose
- **Ollama** running somewhere on your network

### Clone and Install

```bash
git clone https://github.com/botmem/botmem.git
cd botmem
pnpm install
```

### Start Infrastructure

```bash
docker compose up -d   # Redis + Qdrant
```

### Start Development Servers

```bash
pnpm dev   # Starts API (:3001) + Web UI (:5173) via Turbo
```

### Verify

```bash
curl http://localhost:3001/api/version
```

## Available Commands

| Command | Description |
|---|---|
| `pnpm dev` | Start all dev servers (Turbo, concurrency 20) |
| `pnpm build` | Build all packages |
| `pnpm lint` | Lint everything |
| `pnpm test` | Run Vitest across all workspaces |

## Monorepo Structure

```
botmem/
  apps/
    api/                NestJS backend
      src/
        config/         Environment + ConfigService
        db/             SQLite, Drizzle schema, DbService
        connectors/     Connector registry + factory
        accounts/       Account CRUD
        auth/           OAuth flow orchestration
        jobs/           Job management + sync triggering
        logs/           Log persistence
        events/         WebSocket gateway
        memory/         Search, ranking, processors
        contacts/       Contact dedup + merging
        settings/       Runtime settings
      data/             SQLite DB + session files
    web/                React frontend
      src/
        pages/          Route pages
        components/     UI components
        store/          Zustand stores
  packages/
    connector-sdk/      BaseConnector + types
    connectors/
      gmail/            Google connector
      slack/            Slack connector
      whatsapp/         WhatsApp connector
      imessage/         iMessage connector
      photos-immich/    Immich connector
    shared/             Shared types
  docs/                 This documentation (VitePress)
```

## Conventions

### Code

- **TypeScript** -- strict mode, ES2022 target, ESNext modules
- **IDs** -- all UUIDs, stored as text primary keys in SQLite
- **Timestamps** -- ISO 8601 strings everywhere
- **JSON columns** -- stored as text, parsed at the application layer
- **Auth context** -- encrypted at rest in the `accounts` and `connectorCredentials` tables
- **Connector packages** -- named `@botmem/connector-<name>`
- **Shared types** -- import from `@botmem/shared`, not from API internals

### File Organization

Tests go in `__tests__/` directories adjacent to source files:

```
src/
  contacts/
    contacts.service.ts
    contacts.controller.ts
    __tests__/
      contacts.service.test.ts
```

### Testing

- **Framework:** Vitest 3
- **Run tests:** `pnpm test`
- **Run specific tests:** `cd apps/api && pnpm vitest run src/contacts`
- **Watch mode:** `cd apps/api && pnpm vitest src/contacts`

### Database

- SQLite with WAL mode
- Schema defined in `apps/api/src/db/schema.ts` using Drizzle ORM
- No migrations -- schema is sync'd on startup (suitable for local-first development)

### API Conventions

- Controllers handle HTTP routing
- Services contain business logic
- BullMQ processors handle async work
- WebSocket events for real-time updates

## Adding a New Feature

### New API Endpoint

1. Add the route to the appropriate controller (or create a new module)
2. Implement business logic in the service
3. Add types to `@botmem/shared` if needed
4. Add tests in `__tests__/`
5. Update the API documentation in `docs/api/`

### New Connector

See [Building a Connector](/connectors/building-a-connector) for a complete walkthrough.

1. Create `packages/connectors/<name>/`
2. Implement `BaseConnector`
3. Register in `ConnectorsService`
4. Add documentation in `docs/connectors/<name>.md`
5. Add to the sidebar in `docs/.vitepress/config.ts`

### New Queue/Processor

1. Register the queue in the NestJS module (BullMQ `registerQueue`)
2. Create a processor class with `@Processor('queue-name')`
3. Inject the queue where needed with `@InjectQueue('queue-name')`
4. Add to the queue stats endpoint in `JobsController`

## Debugging

### View Logs

```bash
# All logs
curl http://localhost:3001/api/logs

# Logs for a specific account
curl http://localhost:3001/api/logs?accountId=<uuid>

# Error logs only
curl http://localhost:3001/api/logs?level=error
```

### Queue Health

```bash
curl http://localhost:3001/api/jobs/queues
```

### Retry Failed Jobs

```bash
curl -X POST http://localhost:3001/api/memories/retry-failed
```

### Check a Specific Memory

```bash
curl http://localhost:3001/api/memories/<uuid>
```

## Architecture Decisions

- **SQLite over Postgres** -- single-file database, no server process, WAL mode for concurrent reads, suitable for single-user local deployment
- **BullMQ over direct processing** -- decouples ingestion from processing, provides retries with backoff, enables concurrency control
- **Qdrant over pgvector** -- dedicated vector DB with built-in similarity search, filtering, and recommendation APIs
- **Ollama over OpenAI** -- runs locally, no API keys, no data leaving the network
- **Cursor-based sync** -- enables incremental sync without re-fetching all data

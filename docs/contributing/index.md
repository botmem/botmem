# Contributing

This guide covers the development setup, monorepo structure, and conventions for contributing to Botmem.

## Development Setup

### Prerequisites

- **Node.js** 20+
- **pnpm** 9.15+ (`corepack enable && corepack prepare pnpm@9.15.0 --activate`)
- **Docker** and Docker Compose
- **Ollama** running somewhere on your network (or use OpenRouter)

### Clone and Install

```bash
git clone https://github.com/botmem/botmem.git
cd botmem
pnpm install
```

### Start Infrastructure

```bash
docker compose up -d   # PostgreSQL + Redis + Qdrant
```

### Configure Environment

```bash
echo "DATABASE_URL=postgresql://botmem:botmem@localhost:5432/botmem" > .env
```

### Start Development Servers

```bash
pnpm dev   # Starts API (:12412) + Web UI (:12412) via Turbo
```

### Verify

```bash
curl http://localhost:12412/api/version
```

## Available Commands

| Command      | Description                                   |
| ------------ | --------------------------------------------- |
| `pnpm dev`   | Start all dev servers (Turbo, concurrency 20) |
| `pnpm build` | Build all packages                            |
| `pnpm lint`  | Lint everything                               |
| `pnpm test`  | Run Vitest across all workspaces              |

## Monorepo Structure

```
botmem/
  apps/
    api/                NestJS backend
      src/
        config/         Environment + ConfigService
        db/             PostgreSQL, Drizzle schema, DbService
        user-auth/      User registration, login, JWT
        crypto/         AES-256-GCM encryption, recovery keys
        connectors/     Connector registry + factory
        accounts/       Account CRUD + credential management
        auth/           OAuth flow orchestration (connectors)
        jobs/           Job management + sync triggering
        logs/           Log persistence
        events/         WebSocket gateway
        memory/         Search, ranking, processors (embed, enrich, file, clean)
        contacts/       Contact dedup + merging
        agent/          AI-powered Q&A, timeline, context endpoints
        api-keys/       API key management (bm_sk_...)
        memory-banks/   Named memory collections
        billing/        Stripe subscription management
        analytics/      PostHog event tracking
        settings/       Runtime settings
        plugins/        Plugin/extension system
      data/             Session files
    web/                React frontend
      src/
        pages/          Route pages
        components/     UI components
        store/          Zustand stores
  packages/
    cli/                botmem CLI (human + JSON output)
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

- **TypeScript** — strict mode, ES2022 target, ESNext modules
- **IDs** — all UUIDs, stored as text primary keys
- **Timestamps** — ISO 8601 strings everywhere
- **JSON columns** — stored as text in PostgreSQL, parsed at the application layer
- **Auth context** — encrypted at rest in the `accounts` and `connectorCredentials` tables
- **Connector packages** — named `@botmem/connector-<name>`
- **Shared types** — import from `@botmem/shared`, not from API internals

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

- PostgreSQL 17 with Drizzle ORM
- Schema defined in `apps/api/src/db/schema.ts`
- Migrations in `apps/api/src/db/migrations/`
- Multi-user with `userId` foreign keys on all user-owned tables

### API Conventions

- Controllers handle HTTP routing
- Services contain business logic
- BullMQ processors handle async work
- WebSocket events for real-time updates
- All endpoints require JWT or API key authentication

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
# All logs (requires auth)
curl -H "Authorization: Bearer $TOKEN" http://localhost:12412/api/logs

# Logs for a specific account
curl -H "Authorization: Bearer $TOKEN" "http://localhost:12412/api/logs?accountId=<uuid>"

# Error logs only
curl -H "Authorization: Bearer $TOKEN" "http://localhost:12412/api/logs?level=error"
```

### Queue Health

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:12412/api/jobs/queues
```

### Retry Failed Jobs

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" http://localhost:12412/api/memories/retry-failed
```

## Architecture Decisions

- **PostgreSQL over SQLite** — multi-user support, proper concurrent writes, production-grade reliability
- **BullMQ over direct processing** — decouples ingestion from processing, provides retries with backoff, enables concurrency control
- **Qdrant over pgvector** — dedicated vector DB with built-in similarity search, filtering, and recommendation APIs
- **Ollama + OpenRouter** — local-first with cloud fallback, swappable via single env var
- **Recovery key over password-derived encryption** — password changes don't invalidate encrypted data
- **Cursor-based sync** — enables incremental sync without re-fetching all data

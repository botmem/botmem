# Botmem — Personal Memory RAG System

Local-first platform that ingests events from multiple data sources (emails, messages, photos, locations), normalizes them into a unified memory schema, and provides cross-modal retrieval with weighted ranking.

## Quick Start

```bash
docker compose up -d          # PostgreSQL, Redis + Typesense
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
- **Search**: Typesense (hybrid BM25 + vector search, conversational RAG)
- **AI**: Ollama (remote, default) or OpenRouter — swappable via `AI_BACKEND` env var
- **Frontend**: React 19, Vite 6, Zustand 5, Tailwind 4, react-force-graph-2d
- **Tooling**: pnpm 9.15 workspaces, Turbo 2.4, Vitest 3

## Environment Variables

| Variable                  | Default                               | Purpose                                             |
| ------------------------- | ------------------------------------- | --------------------------------------------------- |
| `PORT`                    | `12412`                               | API server port                                     |
| `DATABASE_URL`            | _(required)_                          | PostgreSQL connection string                        |
| `REDIS_URL`               | `redis://localhost:6379`              | BullMQ queue backend                                |
| `TYPESENSE_URL`           | `http://localhost:8108`               | Typesense search engine                             |
| `TYPESENSE_API_KEY`       | `botmem-ts-key`                       | Typesense API key                                   |
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

| Queue    | Worker            | Purpose                                                                                    |
| -------- | ----------------- | ------------------------------------------------------------------------------------------ |
| `sync`   | `SyncProcessor`   | Orchestrates `connector.sync()`, writes to `rawEvents`                                     |
| `embed`  | `EmbedProcessor`  | Parses raw event, creates Memory, generates embedding, resolves contacts                   |
| `enrich` | `EnrichProcessor` | Extracts entities/claims, classifies factuality, computes importance, upserts to Typesense |

Job statuses: `queued → running → done | failed | cancelled`

Jobs table tracks progress (`progress`/`total` fields) and errors. The `EventsGateway` (WebSocket at `/events`) broadcasts real-time job progress to the frontend.

## Pipeline: Raw Event → Queryable Memory

```
Connector.sync()
  → rawEvents table (immutable payload store)
  → [sync queue] SyncProcessor
  → [embed queue] EmbedProcessor
      ├ Parse raw event payload
      ├ Create Memory record in PostgreSQL
      ├ Generate embedding via Ollama
      ├ Resolve participants → Contacts (dedup by email/phone/handle)
      └ Enqueue enrich job
  → [enrich queue] EnrichProcessor
      ├ Extract entities (via Ollama VL + prompts)
      ├ Extract claims
      ├ Classify factuality (FACT / UNVERIFIED / FICTION)
      ├ Compute importance baseline
      ├ Update Memory with metadata
      └ Upsert document → Typesense collection
```

## Memory Model

Core design: **store everything, label confidence** — never delete memories, classify them instead.

### Scoring formula

```
# With reranker (recall intent):
final = 0.40×semantic + 0.30×rerank + 0.15×recency + 0.10×importance + 0.05×trust

# Without reranker:
final = 0.40×semantic + 0.25×recency + 0.20×importance + 0.15×trust

# Search recency:    exp(-0.005 × age_days)  — gentle, ~139-day half-life
# Decay processor:   exp(-0.015 × age_days)  — steeper, ~46-day half-life
```

Weights are intent-dependent (`recall` vs `browse`) with per-connector scaling adjustments.

- `semantic` — Typesense vector similarity score (or `rank_fusion_score` from hybrid BM25+vector search)
- `rerank` — optional second-pass reranker score (TEI, Ollama, or Jina backends)
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

Typesense collection `memories`: hybrid BM25 + vector search (cosine), fields include `text`, `connector_type`, `source_type`, `event_time`, `people`, `entities_text`, `embedding` (float[], cosine).

## API Modules

All under `apps/api/src/`:

| Module          | Purpose                                                                         |
| --------------- | ------------------------------------------------------------------------------- |
| `accounts/`     | Account CRUD, credential management                                             |
| `agent/`        | Agent API endpoints (search, ask, tools for AI agents)                          |
| `analytics/`    | PostHog analytics integration + event tracking                                  |
| `api-keys/`     | API key generation, validation, management (`bm_sk_...` tokens)                 |
| `auth/`         | OAuth flow orchestration, callback handling                                     |
| `billing/`      | Usage tracking + billing (stub)                                                 |
| `config/`       | Environment + ConfigService                                                     |
| `connectors/`   | Connector registry + factory                                                    |
| `crypto/`       | AES-256-GCM encryption/decryption, recovery key handling                        |
| `db/`           | PostgreSQL init, Drizzle schema, DbService, migrations                          |
| `demo/`         | Demo mode with sample data                                                      |
| `events/`       | WebSocket gateway (`/events`) for real-time updates                             |
| `geo/`          | Geodecoding (offline GeoNames) for location memories                            |
| `jobs/`         | Job CRUD, sync triggering, status tracking                                      |
| `logs/`         | Log persistence + retrieval                                                     |
| `mail/`         | Transactional email sending                                                     |
| `mcp/`          | MCP (Model Context Protocol) server integration                                 |
| `me/`           | Current user profile endpoint                                                   |
| `memory-banks/` | Memory bank grouping + organization                                             |
| `memory/`       | Search, ranking, embedding (OllamaService, TypesenseService), BullMQ processors |
| `oauth/`        | OAuth client credentials + token management                                     |
| `people/`       | Contact dedup, identifier merging (domain concept: "contacts")                  |
| `plugins/`      | Plugin/extension system                                                         |
| `settings/`     | User + system settings API                                                      |
| `tracing/`      | OpenTelemetry tracing integration                                               |
| `user-auth/`    | User authentication (Firebase + local), JWT, refresh tokens, recovery key flow  |

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

- All IDs are UUIDs (text primary keys in PostgreSQL)
- All timestamps are ISO 8601 strings
- JSON columns stored as text, parsed at application layer
- Auth context is encrypted at rest in the `accounts` and `connectorCredentials` tables
- Connector packages are named `@botmem/connector-<name>`
- Shared types live in `@botmem/shared` — import from there, not from api internals
- Tests go in `__tests__/` directories adjacent to source, using Vitest

## Design Context

### Users

Power users who want full ownership of their personal data — engineers, privacy-conscious professionals, AI-agent builders. They use Botmem to unify fragmented digital history (emails, messages, photos, locations) into a single queryable memory layer. Context: focused, task-driven sessions where speed and clarity matter.

### Brand Personality

**Bold, Personal, Punk.** Unapologetic, tech-forward, your-data-your-rules energy. The interface should feel like a tool that respects the user — no hand-holding, no corporate polish, no fluff.

### Emotional Goals

- **Empowering & confident** — user feels in control, like having a superpower over their own data
- **Calm & trustworthy** — quiet confidence that data is safe, organized, and private
- **Futuristic & edgy** — cutting-edge hacker aesthetic, raw and real

### Aesthetic Direction

- **Neobrutalist** — hard borders (zero border-radius), offset box shadows, bold geometry
- **Monospace everything** — Space Mono (display), IBM Plex Mono (body/UI)
- **Dark-first** with full light mode support (warm off-white, not clinical white)
- **High contrast** — bright lime (#C4F53A) primary accent against dark (#0D0D0D) backgrounds
- **Functional color coding** — each connector, status, and data type gets a dedicated color
- **References**: Terminal/CLI aesthetic, Linear, Raycast — minimal, fast, keyboard-first
- **Anti-references**: Rounded, bubbly SaaS dashboards; corporate enterprise UI; Material Design defaults

### Design Principles

1. **Clarity over decoration** — every pixel serves a purpose. No ornamental elements, no gratuitous animation. Information density is a feature.
2. **Raw honesty** — show real data, real states, real numbers. No skeleton loaders that lie about content. Errors are stated plainly, not hidden behind friendly illustrations.
3. **Respect the user** — assume competence. Keyboard-first interactions, no confirmation dialogs for reversible actions, no tooltips explaining obvious things.
4. **Consistent visual language** — borders, shadows, typography, and color follow the neobrutalist system uniformly. No mixing rounded and sharp corners. No one-off styling.
5. **Accessible by default** — WCAG AAA compliance. Enhanced contrast ratios, reduced motion support, full keyboard navigation, meaningful alt text, no color-only indicators.

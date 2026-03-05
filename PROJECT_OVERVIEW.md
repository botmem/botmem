# Botmem v1 — Project Overview & Architecture

**Date**: 2026-03-06
**Status**: Working prototype with 6 connectors, full embedding pipeline, and web UI

---

## 1. What Botmem Is

Botmem is a **self-hosted personal memory platform** that:
- Ingests data from multiple personal data sources (email, messaging, photos, location)
- Normalizes everything into a unified **Memory** schema
- Generates vector embeddings and stores them in Qdrant
- Extracts entities, classifies factuality, and builds a relationship graph
- Provides semantic search with weighted multi-signal ranking
- Visualizes the memory graph in a force-directed graph UI

The goal: a single queryable memory layer for personal AI agents.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    React 19 Frontend                     │
│  Dashboard │ Connectors │ Memory Explorer │ Contacts     │
│  Settings  │ Graph Viz  │ Search          │              │
└────────────────────────┬────────────────────────────────┘
                         │ REST + WebSocket
┌────────────────────────▼────────────────────────────────┐
│                    NestJS 11 API                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐             │
│  │ Accounts │  │ Auth     │  │ Jobs     │             │
│  │ Module   │  │ Module   │  │ Module   │             │
│  └──────────┘  └──────────┘  └──────────┘             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐             │
│  │ Memory   │  │ Contacts │  │ Settings │             │
│  │ Module   │  │ Module   │  │ Module   │             │
│  └──────────┘  └──────────┘  └──────────┘             │
│  ┌──────────┐  ┌──────────┐                            │
│  │ Plugins  │  │ Events   │ (WebSocket gateway)        │
│  │ Module   │  │ Gateway  │                            │
│  └──────────┘  └──────────┘                            │
└───────┬─────────────┬────────────────┬─────────────────┘
        │             │                │
   ┌────▼────┐  ┌─────▼─────┐  ┌──────▼──────┐
   │ SQLite  │  │   Redis   │  │   Qdrant    │
   │ (WAL)   │  │  (BullMQ) │  │ (Vectors)   │
   └─────────┘  └───────────┘  └─────────────┘
                      │
              ┌───────▼────────┐
              │  BullMQ Queues │
              │  sync → embed  │
              │  → file → enrich│
              │  → backfill    │
              └────────────────┘
                      │
              ┌───────▼────────┐
              │    Ollama      │
              │  (Remote GPU)  │
              │  embed + LLM   │
              └────────────────┘
```

### Data Flow: Raw Event to Queryable Memory

```
Connector.sync()
  → rawEvents table (immutable JSON payload)
  → [sync queue] SyncProcessor
      ├ Manages auth, pagination, cursor tracking
      ├ Persists each event to rawEvents
      └ Enqueues each to embed queue
  → [embed queue] EmbedProcessor
      ├ Parse raw event → extract text
      ├ Strip HTML if present
      ├ Create Memory record in SQLite
      ├ Resolve participants → Contacts (dedup by email/phone/handle)
      ├ Route files to file queue (for content extraction)
      ├ Generate embedding via Ollama (nomic-embed-text, 768d)
      ├ Store vector in Qdrant
      └ Enqueue to enrich queue
  → [file queue] FileProcessor
      ├ Download file (image/pdf/docx/xlsx/text)
      ├ Extract content (VL model for images, parsers for docs)
      ├ Update memory text with extracted content
      ├ Re-embed with enriched text
      └ Enqueue to enrich queue
  → [enrich queue] EnrichProcessor
      ├ Entity extraction via Ollama LLM
      ├ Factuality classification (FACT/UNVERIFIED/FICTION)
      ├ Find similar memories in Qdrant → create graph links
      └ Compute base weights (recency, importance, trust)
```

---

## 3. Database Schema (SQLite via Drizzle ORM)

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `accounts` | Connector accounts + encrypted auth | connectorType, identifier, status, schedule, authContext, lastCursor |
| `jobs` | Sync job tracking | accountId, status, progress, total, error |
| `logs` | Per-job log entries | jobId, stage, level, message |
| `connector_credentials` | OAuth credentials cache | connectorType, credentials (encrypted) |
| `raw_events` | Immutable ingested payloads | accountId, sourceId, sourceType, payload (JSON) |
| `memories` | Normalized events with AI enrichment | text, eventTime, factuality, weights, entities, claims, embeddingStatus |
| `memory_links` | Relationship graph | srcMemoryId, dstMemoryId, linkType (related/supports/contradicts), strength |
| `contacts` | Deduplicated people | displayName, avatars (JSON array), metadata (JSON) |
| `contact_identifiers` | Multi-identifier mapping | contactId, identifierType (email/phone/slack_id/...), identifierValue |
| `memory_contacts` | Memory-Contact associations | memoryId, contactId, role (sender/recipient/mentioned/participant) |
| `merge_dismissals` | Dismissed merge suggestions | contactId1, contactId2 |
| `settings` | Key-value config | key, value |

---

## 4. Connectors (6 Built-in)

### Gmail (`@botmem/connector-gmail`)
- **Auth**: OAuth2 (Google API)
- **Syncs**: Emails (full history with cursor pagination) + Google Contacts
- **Contact extraction**: From/To/CC headers parsed, Google Contact fields (phones, emails, orgs, birthday, URLs, etc.)
- **Status**: Fully operational

### Slack (`@botmem/connector-slack`)
- **Auth**: OAuth2 or direct user token (xoxp-...)
- **Syncs**: Workspace messages across all channels
- **Contact extraction**: Slack user profiles (name, email, phone)
- **Status**: Fully operational

### WhatsApp (`@botmem/connector-whatsapp`)
- **Auth**: QR code (Baileys v7, warm session pre-generation)
- **Syncs**: Chat history (captured from initial QR auth socket)
- **Contact extraction**: Phone numbers, push names, LID-to-phone resolution
- **Status**: Functional but fragile (history only on first link, LID resolution partial)

### iMessage (`@botmem/connector-imessage`)
- **Auth**: Local tool (connects to `imsg` RPC bridge via socat)
- **Syncs**: All chat messages across conversations
- **Contact extraction**: Phone numbers and email handles
- **Status**: Functional (requires macOS with imsg bridge running)

### Photos/Immich (`@botmem/connector-photos-immich`)
- **Auth**: API key
- **Syncs**: Photo metadata (EXIF, people/face tags, location, camera info)
- **Content**: File processor downloads images → Ollama VL model generates descriptions
- **Contact extraction**: Immich facial recognition people tags → avatars downloaded
- **Status**: Fully operational

### Locations/OwnTracks (`@botmem/connector-locations`)
- **Auth**: API key (HTTP basic auth)
- **Syncs**: Location history from OwnTracks Recorder
- **Status**: Functional

### Connector SDK (`@botmem/connector-sdk`)
- `BaseConnector` abstract class (EventEmitter-based)
- `ConnectorRegistry` with `loadFromDirectory()` for external plugins
- `ConnectorTestHarness` for testing
- `DEBUG_SYNC_LIMIT` for development capping
- **External plugin support**: Drop a package in `./plugins/` directory

---

## 5. Search & Ranking

### Scoring Formula
```
final = 0.40 × semantic + 0.25 × recency + 0.20 × importance + 0.15 × trust
recency = exp(-0.015 × age_days)
importance = 0.5 + min(entity_count × 0.1, 0.4)
```

### Trust Scores by Connector
| Connector | Trust |
|-----------|-------|
| Gmail | 0.95 |
| Slack | 0.90 |
| Photos | 0.85 |
| Locations | 0.85 |
| WhatsApp | 0.80 |
| iMessage | 0.80 |
| Manual | 0.70 |

### Search Flow
1. User query → Ollama embedding
2. Qdrant vector search (cosine similarity, optional filters by source_type/connector_type)
3. Fetch full memory records from SQLite
4. Compute multi-signal weighted score
5. Optional contact filtering
6. Return sorted results

---

## 6. Frontend (React 19 + Vite 6)

### Pages
| Route | Page | Status |
|-------|------|--------|
| `/login` | Login | Implemented (mock auth) |
| `/signup` | Signup | Implemented (mock auth) |
| `/onboarding` | Onboarding wizard | Implemented |
| `/dashboard` | Job monitoring + log feeds | Implemented |
| `/connectors` | Connector setup + sync management | Implemented |
| `/memories` | Search + results + graph visualization | Implemented |
| `/contacts` | Contact list + merge suggestions + detail panel | Implemented |
| `/settings` | Pipeline concurrency settings | Implemented |

### State Management (Zustand 5)
- `authStore` — mock auth state (login/signup/onboarding)
- `connectorStore` — connector manifests, accounts, setup flow
- `jobStore` — job list, progress tracking
- `memoryStore` — search, results, graph data, memory list
- `contactStore` — contact list, search, merge actions

### Key Components
- `MemoryGraph` — force-directed graph (react-force-graph-2d) showing memories + contacts + links
- `MemorySearchBar` — semantic search with connector/source filters
- `MemoryCard` / `MemoryDetailPanel` — result display with factuality badges
- `ConnectorSetupModal` — config schema-driven form, OAuth/QR flows
- `ContactDetailPanel` — identifiers, avatars, linked memories
- `MergeSuggestionRow` — cross-connector contact dedup suggestions

---

## 7. Infrastructure

### Services (docker-compose.yml)
- **Redis 7** — BullMQ queue backend
- **Qdrant** — Vector database (cosine similarity)
- **SQLite** — Primary data store (WAL mode, Drizzle ORM)
- **Ollama** — Remote GPU server (embedding + LLM + VL models)

### Build System
- **pnpm 9.15** workspaces
- **Turbo 2.4** for parallel builds
- **Vitest 3** for testing
- **SWC** for fast TypeScript compilation

### BullMQ Queues
| Queue | Concurrency | Purpose |
|-------|-------------|---------|
| `sync` | 2 (configurable) | Connector sync orchestration |
| `embed` | 4 (configurable) | Embedding + contact resolution |
| `file` | default | File content extraction |
| `enrich` | 2 (configurable) | Entity extraction + factuality + graph links |
| `backfill` | default | Retroactive contact resolution |

### Scheduled Syncs
- Accounts can be set to `manual`, `15min`, `hourly`, or `daily`
- `SchedulerService` creates BullMQ repeatable jobs

---

## 8. Test Coverage

~40 test files covering:
- All API services (accounts, auth, jobs, logs, events, contacts, memory, config, plugins)
- All processors (embed, enrich, file)
- Connector SDK (base, registry, testing harness)
- Individual connectors (gmail, slack, whatsapp, imessage, immich)
- Frontend (stores, hooks, API client, components)
- Shared utilities

---

## 9. Current Limitations & Known Issues

### Critical Gaps
1. **No real authentication** — Auth is mocked on frontend, no JWT/session system on backend
2. **Single-user only** — No multi-tenancy, all data is co-mingled
3. **No API for agents** — No MCP server, no tool-use API, no agent-friendly query interface
4. **Claims extraction not implemented** — The `claims` field exists in schema but is never populated
5. **Rerank score always 0** — No reranker model integrated despite being in the scoring formula
6. **No data retention/deletion policies** — "Store everything" with no way to purge old data
7. **No encryption at rest** — Auth context marked "encrypted" in comments but stored as plain JSON

### Functional Gaps
8. **WhatsApp fragility** — History only on first QR link; subsequent syncs get nothing; LID resolution partial
9. **No incremental enrichment** — Enrichment runs once; no re-enrichment when contradicting info arrives
10. **Graph links are unidirectional** — Only `related` type links created; `supports`/`contradicts` logic not implemented
11. **No memory deduplication** — Same content from different connectors creates separate memories
12. **No conversation threading** — Email threads and message conversations stored as flat individual memories
13. **Contact merge suggestions O(n²)** — `getSuggestions()` loads all contacts into memory and does pairwise comparison
14. **No file type support for audio/video** — FileProcessor handles images/PDF/DOCX/XLSX/text but not audio transcription

### Scalability Concerns
15. **SQLite single-writer** — WAL helps reads but writes are serialized; will bottleneck at scale
16. **Qdrant in-memory** — No persistence config shown; data could be lost on restart (but volume is mounted)
17. **N+1 queries in search** — Each Qdrant result triggers individual SQLite lookups
18. **Graph data loads all memories** — `getGraphData()` limited to 500 but still fetches all contacts/links for those

### Developer Experience
19. **No API documentation** — No OpenAPI/Swagger
20. **No migration system** — Schema changes require manual DB recreation
21. **Plugin loading is basic** — Only `loadFromDirectory()`, no versioning, no dependency resolution
22. **No health check endpoint** — Only `/api/version`

---

## 10. File Count Summary

| Area | Files | Status |
|------|-------|--------|
| API modules | 47 source files | Complete |
| Frontend | 75+ source files | Complete |
| Connector SDK | 5 files | Complete |
| Connectors | 18 files (6 connectors) | All functional |
| Shared types | 4 files | Complete |
| Tests | ~40 test files | Good coverage |

---

## 11. V2 Upgrade Plan

### Phase 1: Agent API & MCP Server (Priority: Critical)
*Make Botmem usable as a memory backend for AI agents*
- [ ] Build MCP (Model Context Protocol) server exposing memory search, insert, and graph query
- [ ] Add structured tool-use API (search with filters, get-by-contact, timeline queries)
- [ ] Add conversation context retrieval (group related memories into conversations)
- [ ] Support natural language memory queries with LLM-powered query expansion

### Phase 2: Authentication & Multi-User (Priority: Critical)
- [ ] Implement JWT-based auth with refresh tokens
- [ ] Add user accounts table, scoped data isolation
- [ ] Encrypt auth contexts at rest (AES-256-GCM)
- [ ] RBAC for shared instances

### Phase 3: Memory Intelligence (Priority: High)
*Make the memory system actually smart*
- [ ] Implement claims extraction pipeline (who said what, when)
- [ ] Add `supports`/`contradicts` link types with LLM-powered consistency checking
- [ ] Memory deduplication (cross-connector same-content detection)
- [ ] Conversation threading (group emails/messages by thread)
- [ ] Temporal reasoning (understand sequences of events)
- [ ] Importance decay/boost based on recall frequency
- [ ] Add reranker model (cross-encoder) for search quality

### Phase 4: Data Quality & Resilience (Priority: High)
- [ ] Database migrations (Drizzle Kit)
- [ ] Incremental re-enrichment (re-process when new contradicting info arrives)
- [ ] Audio/video transcription support (Whisper model)
- [ ] Memory deduplication with fuzzy matching
- [ ] Data export/backup system
- [ ] Health check endpoints with dependency status

### Phase 5: Connector Ecosystem (Priority: Medium)
*Make it easy for anyone to add connectors*
- [ ] Connector SDK v2: typed events, schema validation, test harness improvements
- [ ] Connector marketplace/registry (npm-based)
- [ ] Priority connectors to add: Google Calendar, Notion, Obsidian, Telegram, Discord, Twitter/X, LinkedIn, Spotify, browser history
- [ ] Webhook-based real-time connectors (not just polling)

### Phase 6: Frontend & UX (Priority: Medium)
- [ ] Real authentication flow (replace mock auth)
- [ ] Timeline view (chronological memory display)
- [ ] Conversation view (threaded message display)
- [ ] Contact merge improvements (fuzzy matching, auto-merge confidence)
- [ ] Memory editing (correct factuality, add notes)
- [ ] Dashboard with real analytics (memory growth, connector health, query usage)
- [ ] Mobile-responsive design
- [ ] Dark/light theme

### Phase 7: Scalability (Priority: Low for self-hosted)
- [ ] PostgreSQL option for multi-user deployments
- [ ] Batch embedding (multiple texts per Ollama call)
- [ ] Search result caching
- [ ] Horizontal scaling (multiple API instances)
- [ ] Qdrant sharding configuration

---

*This document represents the state of Botmem as of commit `df6f123` (2026-03-06).*

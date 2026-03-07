# Botmem — Personal Memory RAG System

## What This Is

A local-first personal memory platform that ingests events from multiple data sources (emails, messages, photos, locations), normalizes them into a unified memory schema, and provides cross-modal retrieval with weighted ranking. Built as a pnpm monorepo with NestJS API, React frontend, and pluggable connector architecture. Designed for a single person to query their entire digital life through semantic search and a force-directed graph visualization.

## Core Value

Every piece of personal communication and digital interaction is searchable, connected, and queryable — with factuality labeling so the user always knows what's verified vs. hearsay.

## Requirements

### Validated

<!-- Shipped and confirmed valuable. -->

- ✓ Ingest and normalize messages, emails, photos, and locations — existing
- ✓ Store searchable memory with vector + metadata + relationship links — existing
- ✓ Retrieve memory via semantic search with weighted scoring — existing
- ✓ Classify memory as FACT / UNVERIFIED / FICTION with confidence — existing
- ✓ Gmail connector (OAuth2, emails + contacts) — existing
- ✓ Slack connector (user token, workspace messages + contacts) — existing
- ✓ WhatsApp connector (QR auth, Baileys v6, message history) — existing
- ✓ iMessage connector (local tool, reads iMessage DB) — existing
- ✓ Photos-Immich connector (local tool, Immich photo library) — existing
- ✓ Locations connector (OwnTracks, HTTP auth, GPS history) — existing
- ✓ Contacts as first-class entities with dedup, avatars, identifiers, merge suggestions — existing
- ✓ Force-directed graph visualization for memory exploration — existing
- ✓ CLI tool (`botmem`) for humans and AI agents — existing
- ✓ BullMQ job pipeline: sync → embed → enrich — existing
- ✓ Real-time WebSocket updates for job progress — existing
- ✓ Docker Compose infrastructure (Redis + Qdrant) — existing

### Active

<!-- Current scope. Building toward these. -->

- [ ] PostHog product analytics integration (frontend SDK integrated, needs API key + running instance)
- [ ] Reranker integration for second-pass scoring
- [ ] Importance reinforcement (repeated recall boosts rank)
- [ ] Nightly decay job for recency/importance score refresh
- [ ] Memory pinning by user
- [ ] Plugin/extension system (stub exists)

### Out of Scope

<!-- Explicit boundaries. Includes reasoning to prevent re-adding. -->

- Native image embedding retrieval — deferred; image retrieval via OCR/caption/metadata for v1
- Multi-person identity graph — single target person only in v1
- Automatic deletion policy engine — manual/admin-driven in v1
- Mobile app — web-first
- Real-time chat ingestion — batch sync only in v1

## Context

- **Monorepo**: pnpm 9.15 workspaces + Turbo 2.4, TypeScript (ES2022, strict, ESNext modules)
- **Backend**: NestJS 11, Drizzle ORM + SQLite (better-sqlite3, WAL mode), BullMQ on Redis
- **Frontend**: React 19, Vite 6, React Router 7, Zustand 5, Tailwind 4, react-force-graph-2d
- **AI**: Ollama (remote at 192.168.10.250) — nomic-embed-text (768d embeddings), qwen3:0.6b (text), qwen3-vl:2b (vision)
- **Vector DB**: Qdrant (cosine similarity, auto-created collection)
- **Port**: API on 12412, web on 5173
- **WhatsApp limitation**: LID format only, no phone number resolution possible via Baileys v6
- **No git remote**: commits are local only
- 6 connectors implemented and working
- Contacts system fully operational with cross-connector dedup

## Constraints

- **AI Infrastructure**: Ollama runs externally on 192.168.10.250 (RTX 3070) — not containerized, configured by env var
- **Storage**: SQLite only (no PostgreSQL) — WAL mode for concurrent reads, simple deployment
- **Embedding**: nomic-embed-text produces 768d vectors — model change requires re-embedding all memories
- **WhatsApp**: Baileys v6 LID format means phone numbers are not resolvable; history only delivered to first QR-linked socket

## Key Decisions

<!-- Decisions that constrain future work. Add throughout project lifecycle. -->

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| SQLite over PostgreSQL | Simpler deployment, single-user system, WAL mode sufficient | ✓ Good |
| NestJS over FastAPI | TypeScript monorepo consistency, better ecosystem fit | ✓ Good |
| BullMQ over Celery | Native Node.js, no Python dependency, Redis-backed | ✓ Good |
| nomic-embed-text over Qwen embedding | Available on Ollama, 768d vectors, good quality | ✓ Good |
| Contacts as first-class entities | Rich cross-connector identity needed for meaningful search | ✓ Good |
| Store all memories, label factuality | Never lose data, let user filter by confidence | ✓ Good |
| PostHog for analytics | Self-hostable, privacy-respecting, generous free tier | — Pending |

---
*Last updated: 2026-03-07 after initialization*

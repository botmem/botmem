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
- ✓ Reranker integration for second-pass scoring (logprobs yes/no) — v1.0
- ✓ Importance reinforcement (repeated recall boosts rank, capped +0.2) — v1.0
- ✓ Nightly decay job for recency/importance score refresh — v1.0
- ✓ Memory pinning with score floor 0.75 — v1.0
- ✓ Plugin/extension system (3 types: connector, scorer, lifecycle) — v1.0
- ✓ PostHog SDK integration (frontend + backend, no-op when unconfigured) — v1.0
- ✓ PostHog cloud analytics activation and end-to-end event verification — v1.1
- ✓ Configurable PostHog host (EU/US) via POSTHOG_HOST env var — v1.1
- ✓ connector_setup, graph_view, graph_node_click tracking events — v1.1
- ✓ Entity type taxonomy with canonical types via Ollama structured output — v1.4
- ✓ Contact auto-merge with safety-tiered rules — v1.4
- ✓ Natural language query parsing (temporal + intent + entity extraction) — v1.4
- ✓ GitHub org with open-core/prod-core repo split — v2.0 (Phase 11)

### Active

<!-- Current scope. Building toward these. -->

- [ ] User authentication (email+password, JWT access+refresh tokens)
- [ ] API keys (named, read-only, bank-scoped)
- [ ] Memory banks (data isolation, sync-time selection)
- [ ] Encryption at rest (AES-256-GCM for credentials)
- [ ] E2EE for prod-core (Argon2id key derivation, client-side encryption)
- [ ] PostgreSQL dual-driver with RLS
- [ ] Firebase auth for prod-core

## Current Milestone: v2.0 Security, Auth & Encryption

**Goal:** Add user authentication, API keys, memory banks, encryption at rest, E2EE for prod-core, and PostgreSQL with RLS — transforming Botmem from a completely open system into a properly secured personal memory platform.

**Target features:**
- User auth: email+password (open-core), Firebase (prod-core) — always required, no bypass
- API keys: named, read-only, scoped to memory bank(s)
- Memory banks: data isolation units, selected at sync time
- Encryption at rest: AES-256-GCM for auth context + connector credentials
- E2EE (prod-core): Argon2id key derivation, client-side encryption of memory text+metadata
- PostgreSQL dual-driver with RLS for prod-core data isolation
- CORS locked to FRONTEND_URL, auth guard on all endpoints

## Queued Milestone: v3.0 Production Deployment & CI/CD

**Goal:** Deploy Botmem to production with Docker/Caddy/CI-CD, OpenRouter inference abstraction, and automated deployment pipelines. (Deferred from old v2.0.)

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
- **Git remote**: github.com/botmem org (open-core public, prod-core private)
- **Domain**: botmem.xyz (Spaceship, DNS not yet configured)
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
| PostHog for analytics | Self-hostable, privacy-respecting, generous free tier | ✓ Good |
| PostHog cloud over self-hosted | 16GB RAM requirement disproportionate for single-user | ✓ Good |

| SQLite → PostgreSQL for production | Production needs concurrent writes, RLS for data isolation | — Pending |
| Local auth (open-core) + Firebase (prod-core) | Open-core self-contained, prod-core gets social login | — Pending |
| Auth always on, no bypass | Security-first: every endpoint requires authentication | — Pending |
| E2EE with Argon2id key derivation | Zero-knowledge: server never sees plaintext, lost password = lost data | — Pending |
| Memory banks for data isolation | Logical partitioning for sync scoping and API key access | — Pending |
| AES-256-GCM encryption at rest | Protect auth context and credentials in SQLite/Postgres | — Pending |

---
*Last updated: 2026-03-08 after v1.4 milestone start*

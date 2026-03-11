# What is Botmem?

Botmem is a **personal memory platform** that ingests data from your digital life — emails, messages, photos, locations — normalizes it into a unified memory schema, and provides semantic search with weighted ranking.

The goal: give you (and your AI agents) a single place to recall anything you have ever said, received, or experienced across all your online services.

## Why Botmem?

Your personal data is scattered across dozens of services. Gmail holds your email history. Slack has your work conversations. WhatsApp has your personal chats. Your photo library captures where you were and who you were with. None of these services talk to each other, and none of them let your AI agents access the data.

Botmem solves this by:

1. **Ingesting** data from multiple sources via pluggable connectors
2. **Normalizing** everything into a common Memory schema with text, timestamps, participants, entities, and factuality labels
3. **Embedding** each memory as a vector for semantic search via Qdrant
4. **Enriching** memories with entity extraction, factuality classification, and relationship graph links
5. **Exposing** the entire memory store via REST API, WebSocket, and CLI for AI agents

## Deployment Options

- **Self-hosted** (free) — run on your own hardware with full control
- **Managed Pro** ($14.99/mo) — same code, managed infrastructure at [botmem.xyz](https://botmem.xyz)

Both modes use the same encryption model — your recovery key ensures only you can decrypt your data.

## Core Principles

### Store everything, label confidence

Botmem never deletes memories. Instead, every memory carries a factuality label (`FACT`, `UNVERIFIED`, or `FICTION`) with a confidence score and rationale. When sources contradict each other, both versions are kept and the conflict is recorded as a graph link.

### Encrypted by default

All connector credentials are encrypted at rest using AES-256-GCM with your personal recovery key. Even on the managed tier, the server cannot read your credentials.

### Agent-ready from day one

The REST API and CLI expose tools that let AI agents search your memory, recall specific events, find contacts, and build timelines. Your agents inherit your memory.

## System Overview

```
                        +------------------+
                        |    Web UI        |
                        |  React 19 + Vite |
                        +--------+---------+
                                 |
                            REST / WS
                                 |
                        +--------+---------+
                        |    NestJS API    |
                        |   port 12412     |
                        +--------+---------+
                          /      |       \
               +---------+  +---+---+  +--+--------+
               |PostgreSQL|  | Redis |  |  Qdrant   |
               | Drizzle  |  | BullMQ|  |  Vectors  |
               +---------+  +-------+  +-----------+
                                 |
                        +--------+---------+
                        |  AI Backend      |
                        | Ollama/OpenRouter|
                        +------------------+
```

## Tech Stack

| Layer     | Technology                                                            |
| --------- | --------------------------------------------------------------------- |
| Runtime   | Node.js, TypeScript (ES2022, strict)                                  |
| Backend   | NestJS 11, Drizzle ORM + PostgreSQL 17                                |
| Queue     | BullMQ on Redis                                                       |
| Vector DB | Qdrant (cosine similarity)                                            |
| AI        | Ollama (`mxbai-embed-large`, `qwen3:8b`, `qwen3-vl:4b`) or OpenRouter |
| Auth      | JWT + optional Firebase, AES-256-GCM encryption                       |
| Frontend  | React 19, Vite 6, Zustand 5, Tailwind 4                               |
| Tooling   | pnpm 9.15, Turbo 2.4, Vitest 3                                        |

## Next Steps

- [Quick Start](/guide/quickstart) — install and run Botmem
- [Authentication](/guide/authentication) — understand signup, tokens, and recovery keys
- [Architecture](/architecture/) — understand the system design
- [Agent API](/agent-api/) — connect your AI agents
- [Connectors](/connectors/) — set up data sources
- [Self-Hosted vs Managed](/guide/managed) — compare deployment options

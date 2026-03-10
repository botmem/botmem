---
name: botmem-cli
description: Query and manage Botmem personal memory system via CLI. Use for searching memories, checking contacts, monitoring pipeline status.
triggers:
  - botmem
  - memory search
  - search memories
  - personal memory
  - check contacts
  - sync status
---

# Botmem CLI

The `botmem` CLI provides access to the Botmem personal memory system. It lives in `packages/cli/`.

**IMPORTANT: Always use `--toon` (not `--json`) for machine-readable output.** The `--toon` flag outputs flattened JSON optimized for LLM reasoning — nested objects become dot-notation keys (e.g. `factuality.label`, `metadata.chatId`) and JSON-encoded strings are parsed inline.

## Setup

```bash
# Install to a directory + set up skill
/path/to/botmem/install-cli.sh /usr/local/bin

# Configure host (default: api.botmem.xyz)
botmem config set-host localhost:12412     # local dev
botmem config set-host api.botmem.xyz      # production

# Authenticate with API key (preferred for agents)
botmem config set-key bm_sk_abc123...

# Store recovery key for E2EE decryption (required to read encrypted memories)
botmem config set-recovery-key <base64-key>

# Or login with email/password (stores JWT)
botmem login

# Verify
botmem version
botmem config show
```

Config stored in `~/.botmem/config.json`. Override per-call with `--api-key`, `--api-url`, or env vars `BOTMEM_API_KEY`, `BOTMEM_API_URL`.

## Common Commands

```bash
# Search memories (semantic + FTS + entity resolution)
botmem search "coffee with Ahmed" --toon
botmem search "meeting" --connector gmail --limit 5 --toon
botmem search "photos" --memory-bank <bankId> --toon

# Agent: natural language query
botmem ask "what did Ahmed say about the project?" --toon
botmem ask "summarize my week" --summarize --toon
botmem ask "photos from dubai" --source photo --toon

# Agent: full contact context
botmem context <contactId> --toon

# Check status
botmem status --toon

# List/search contacts
botmem contacts --toon
botmem contacts search "Amr" --toon

# Get contact details + their memories
botmem contact <id> --toon
botmem contact <id> memories --toon

# Timeline — date-range queries
botmem timeline --from 2026-01-01 --to 2026-02-01 --toon

# Related memories — graph links + vector similarity
botmem related <memoryId> --toon

# Entity search and graph
botmem entities search "AWS" --toon
botmem entities graph "Bahrain" --toon

# Memory banks: list, create, rename, delete
botmem memory-banks --toon
botmem memory-banks create "Work"
botmem memory-banks rename <id> "Personal"
botmem memory-banks delete <id>

# Version / build info
botmem version --toon

# Pipeline jobs
botmem jobs --toon
botmem sync <accountId>
botmem retry --toon

# Memory stats
botmem stats --toon
botmem accounts --toon
```

## Critical: Contact Attribution

**When analyzing conversations with a specific person, ALWAYS use `--contact <id>` to filter results.** Without this filter, search results include `fromMe: true` messages from ALL chats, not just the conversation with that person. This leads to misattribution — messages sent to other people get incorrectly treated as messages to the target contact.

Correct workflow for person-specific queries:
1. `botmem contacts search "Name" --toon` — get the contact UUID
2. `botmem search "topic" --contact <uuid> --toon` — filtered to that conversation only

**Never** rely on `--connector whatsapp` or semantic search alone to isolate a single conversation. The `--connector` flag filters by platform, not by chat. Only `--contact` guarantees results are scoped to a specific person's conversation.

## API Notes

- Search uses POST `/api/memories/search` with `{ query, filters?, limit?, rerank? }`
- Default API host is api.botmem.xyz (port 12412 for local dev)
- Search returns `{ items, fallback, resolvedEntities? }`
- **All timestamps are UTC** — temporal queries ("last week", "yesterday") are parsed and converted to UTC ranges
- Recovery key is auto-submitted on every CLI invocation if stored in config

## Typical Workflow

1. `botmem version --toon` - verify API is running
2. `botmem status --toon` - check system health
3. `botmem ask "topic" --toon` - natural language query (agent-powered)
4. `botmem search "topic" --toon` - raw semantic search
5. `botmem memory <id> --toon` - drill into a result
6. `botmem related <id> --toon` - find connected memories
7. `botmem context <contactId> --toon` - full person context
8. `botmem contact <id> memories --toon` - see all their interactions
9. `botmem timeline --from <date> --toon` - browse by date range
10. `botmem memory-banks --toon` - manage memory organization

## Error Handling

- API unreachable: shows connection error with hint to run `pnpm dev`
- No results: shows "No results found" message
- Bad arguments: shows command-specific help

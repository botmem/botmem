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

The `botmem` CLI provides access to the Botmem personal memory system.

**IMPORTANT: Always use `--toon` (not `--json`) for machine-readable output.** The `--toon` flag outputs compact TOON optimized for LLM reasoning and parses JSON-encoded strings inline.

Use `--toon-fields <paths>` to select only specific dot-paths before TOON encoding. This implies `--toon`.

```bash
botmem search "project update" --contact <id> --toon-fields items.id,items.text,items.eventTime,items.connectorType
botmem search "project update" --debug --toon-fields items.id,items.score,diagnostics,resolvedEntities.contacts.displayName
botmem status --toon-fields memory.total,connectors,queues
```

Array paths can be written with or without `[]`: `items.id` and `items[].id` are equivalent.

## Agent Tool Selection

CLI help and MCP tool descriptions are generated from the same shared registry. The MCP connector exposes `status`, `sources`, `list`, `timeline`, `search`, `ask`, and `get_memory`.

- Start with `botmem status --toon-fields memory.total,accounts,connectors,queues,lastUpdate` or MCP `status` when source coverage or pipeline health matters.
- Use MCP `sources` or `botmem stats --toon` before guessing `source_type` / `connector_type` filters.
- Use `botmem memories --source location --limit 1 --toon` or MCP `list` with `source_type: "location"`, `sort_by: "eventTime"`, `limit: 1` for "latest/current location" style questions.
- Use `timeline` for explicit date ranges, `search` for semantic lookup, `ask` only after retrieval when synthesis is needed.
- For person-specific queries, always resolve the person with `botmem contacts search "<name>" --toon` or a previous result, then pass the durable contact id with `--contact <id>` / MCP `contact_id`. A name inside the query is only a hint and must not be treated as proof that returned topical results came from that person.
- MCP is read-only; use REST/CLI commands for write operations.

## Setup

When this skill is invoked and the `botmem` command is unavailable, install it automatically before using Botmem:

```bash
command -v botmem >/dev/null 2>&1 || npm install -g @botmem/cli
```

After install, help the user onboard instead of assuming configuration exists:

1. Run `botmem config show` and `botmem version --toon-fields buildTime,gitHash,uptime` to check local config and API reachability.
2. If no API host is configured, ask whether they use Botmem Cloud (`api.botmem.xyz`) or a self-hosted URL, then run `botmem config set-host <host>`.
3. If `botmem status --toon-fields memory.total,connectors,queues` fails with auth errors, have the user run `botmem login` or ask for an API key and run `botmem config set-key bm_sk_...`.
4. If memory data is locked, ask the user for their recovery key and run `botmem config set-recovery-key <base64-key>`. Botmem must return decrypted memory data or a locked response; never use ciphertext as evidence.
5. Verify with `botmem status --toon-fields memory.total,connectors,queues` before answering memory questions.

Do not invent credentials, recovery keys, hosts, contacts, or memory contents. Ask for missing secrets directly, and avoid printing them back after configuration.

```bash
# Install globally
npm install -g @botmem/cli

# Configure host (default: api.botmem.xyz)
botmem config set-host localhost:12412     # local dev
botmem config set-host api.botmem.xyz      # production

# Configure an API key
botmem config set-key bm_sk_abc123...

# Remove a stale stored API key
botmem config clear-key

# Store recovery key for E2EE unlock
botmem config set-recovery-key <base64-key>

# Or login with browser auth (stores a CLI login JWT)
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

For any person-specific or conversation-specific question, first resolve the person, then search with the contact UUID. If multiple contacts match, disambiguate using identifiers, platform, or recent memories. Do not silently choose. Never invent contacts for test queries; if a person does not appear in `contacts search`, mark that query as synthetic or unverified.

Treat `fromMe: true` carefully. A message sent by the user is only attributable to the target conversation when the memory is linked to that contact/chat. Without `--contact`, `fromMe: true` messages from unrelated chats can contaminate results.

## Response Types

<!-- BEGIN GENERATED RESPONSE TYPES -->
Generated from `packages/cli/src/client.ts`. Run `pnpm --filter @botmem/cli update-skill-types` after changing CLI response types.

```ts
export interface Memory {
  id: string;
  text: string;
  sourceType: string;
  connectorType: string;
  sourceId: string;
  eventTime: string;
  ingestTime: string;
  importance: number | null;
  factuality: string | null;
  entities: string | null;
  claims: string | null;
  weights: string | null;
  metadata: Record<string, unknown> | string | null;
  embeddingStatus: string;
  createdAt: string;
  accountIdentifier?: string | null;
  [key: string]: unknown;
}

export interface SearchResult {
  id: string;
  text: string;
  sourceType: string;
  connectorType: string;
  eventTime: string;
  factuality: string;
  entities: string;
  metadata: Record<string, unknown> | string | null;
  accountIdentifier: string | null;
  score: number;
  weights: {
    semantic: number;
    recency: number;
    importance: number;
    trust: number;
    final: number;
  };
}

export interface Contact {
  id: string;
  displayName: string;
  avatars: string;
  metadata: string;
  createdAt: string;
  updatedAt: string;
  identifiers: Array<{
    id: string;
    identifierType: string;
    identifierValue: string;
    connectorType: string | null;
    confidence: number;
  }>;
  [key: string]: unknown;
}

export interface ConnectorAccount {
  id: string;
  type: string;
  identifier: string;
  status: string;
  schedule: string | null;
  lastSync: string | null;
  memoriesIngested: number | null;
  lastError: string | null;
}

export interface Job {
  id: string;
  connector: string;
  accountId: string;
  accountIdentifier: string | null;
  status: string;
  priority: number;
  progress: number | null;
  total: number | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export interface QueueStats {
  [queueName: string]: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    contradictions?: Array<{ jobId: string; dbStatus?: string; bullState: string; action: string }>;
  };
}
```

### Command Response Map

- `botmem search <query> --toon`: `{ items: SearchResult[]; fallback: boolean; resolvedEntities?: { contacts: { id: string; displayName: string }[]; topicWords: string[] }; diagnostics?: unknown }`
- `botmem memories --toon`: `{ items: Memory[]; total: number }`
- `botmem memory <id> --toon`: `Memory`
- `botmem contacts --toon`: `{ items: Contact[]; total: number }`
- `botmem contacts search <name> --toon`: `Contact[]`
- `botmem contact <id> --toon`: `Contact`
- `botmem contact <id> memories --toon`: `Memory[]`
- `botmem accounts --toon`: `{ accounts: ConnectorAccount[] }`
- `botmem jobs --toon`: `{ jobs: Job[] }`
- `botmem status --toon`: dashboard summary object with memory, connector, queue, and health fields
- `botmem ask <query> --toon`: agent answer object, usually containing `answer`, optional `conversationId`, and source memory fields

### Useful Selectors

```bash
botmem search "topic" --toon-fields items.id,items.text,items.eventTime,items.connectorType,items.sourceType
botmem search "topic" --debug --toon-fields items.id,items.score,items.weights.final,diagnostics
botmem contacts search "Name" --toon-fields id,displayName,identifiers.identifierType,identifiers.identifierValue
botmem accounts --toon-fields accounts.id,accounts.type,accounts.status,accounts.lastSync,accounts.memoriesIngested
botmem jobs --toon-fields jobs.id,jobs.connector,jobs.status,jobs.progress,jobs.total,jobs.error
```

Use `ask` for synthesis, not primary verification. Prefer `search --debug` first when evidence quality matters.
<!-- END GENERATED RESPONSE TYPES -->
## API Notes

- Search uses POST `/api/memories/search` with `{ query, filters?, limit? }`
- Default API host is api.botmem.xyz (port 12412 for local dev)
- Search returns `{ items, fallback, resolvedEntities? }`
- **All timestamps are UTC** — temporal queries ("last week", "yesterday") are parsed and converted to UTC ranges
- Recovery key is auto-submitted on every CLI invocation if stored in config

## Typical Workflow

1. `botmem version --toon` - verify API is running
2. `botmem status --toon` - check system health
3. `botmem accounts --toon` - check connector auth/sync coverage when source coverage matters
4. `botmem contacts search "Name" --toon` - resolve people before person-specific queries
5. `botmem search "topic" --contact <id> --debug --toon` - raw evidence search with scoped attribution
6. `botmem memory <id> --toon` - drill into a result
7. `botmem related <id> --toon` - find connected memories
8. `botmem ask "topic" --toon` - synthesize only after retrieval looks sane
9. `botmem context <contactId> --toon` - full person context
10. `botmem contact <id> memories --toon` - see all their interactions
11. `botmem timeline --from <date> --toon` - browse by date range

## Error Handling

- API unreachable: shows connection error with hint to run `pnpm dev`
- No results: shows "No results found" message
- Bad arguments: shows command-specific help

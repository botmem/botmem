# OpenClaw Plugin

The `@botmem/openclaw-plugin` lets any [OpenClaw](https://openclaw.dev) agent use Botmem as its memory layer — searching, recalling, and storing memories across all your connected data sources.

## Install

Install via the OpenClaw CLI (inside the gateway container if running Docker):

```bash
openclaw plugins install @botmem/openclaw-plugin
```

Then restart the gateway to load the plugin.

> **Note:** The npm package requires `"openclaw": { "extensions": ["./dist/index.js"] }` in `package.json` and uses ESM (`"type": "module"`). If installing from a local tarball (`npm pack`), ensure `devDependencies` don't use pnpm-only protocols like `catalog:` — npm inside the container can't resolve them.

### Botmem CLI Skill (optional)

Also install the Botmem CLI and its OpenClaw skill so your agent can use `botmem` commands directly from the terminal:

```bash
# 1. Install the CLI
npm install -g @botmem/cli

# 2. Install the skill into OpenClaw's skill directory
mkdir -p ~/.openclaw/workspace/skills/botmem-cli
```

Create `~/.openclaw/workspace/skills/botmem-cli/SKILL.md`:

````markdown
---
name: botmem_cli
description: Query and manage Botmem personal memory via CLI. Search memories, check contacts, monitor sync status.
---

# Botmem CLI

Use `botmem` commands for direct terminal access to the memory system.
Always use `--toon` for machine-readable output (optimized for LLMs).

## Quick Reference

```bash
botmem search "dinner with sarah" --toon      # Semantic search
botmem ask "What did John say about deadline?" # AI-powered Q&A
botmem timeline --days 7 --toon               # Recent memories
botmem contacts search "Alice" --toon         # Find people
botmem remember "Meeting moved to 3pm Friday" # Store new memory
botmem status --toon                          # Pipeline health
```

## Setup

```bash
botmem config set-host botmem.xyz    # or localhost:12412
botmem config set-key bm_sk_...      # API key
```
````

Then ask your agent to "refresh skills" or restart the OpenClaw gateway. This gives your agent both the plugin tools (programmatic) and the CLI skill (terminal).

## Configure

Enable the plugin in `~/.openclaw/openclaw.json` under `plugins.entries`:

```json
{
  "plugins": {
    "allow": ["botmem"],
    "entries": {
      "botmem": {
        "enabled": true,
        "config": {
          "apiUrl": "https://botmem.xyz/api",
          "apiKey": "bm_sk_...",
          "defaultLimit": 10,
          "autoContext": true
        }
      }
    }
  }
}
```

### Config Options

| Option         | Type      | Default                  | Description                                 |
| -------------- | --------- | ------------------------ | ------------------------------------------- |
| `apiUrl`       | `string`  | `http://localhost:12412` | Botmem API URL (include `/api` suffix)      |
| `apiKey`       | `string`  | _(required)_             | API key (`bm_sk_...`) or Firebase JWT token |
| `defaultLimit` | `number`  | `10`                     | Default max results per tool call           |
| `memoryBankId` | `string`  | —                        | Scope all queries to a specific memory bank |
| `autoContext`  | `boolean` | `true`                   | Inject memory stats into the system prompt  |

### Getting an API Key

Create a long-lived API key via the botmem API:

```bash
# 1. Get a Firebase token
TOKEN=$(curl -s -X POST "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=YOUR_FIREBASE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"...","returnSecureToken":true}' | jq -r '.idToken')

# 2. Create an API key
curl -s -X POST https://botmem.xyz/api/api-keys \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"openclaw"}' | jq '.key'
# Returns: "bm_sk_..."
```

Or use the CLI: `botmem login` then `botmem api-key create openclaw`.

## What Your Agent Gets

### 7 Agent Tools

The plugin registers these tools automatically — your agent can call them like any other tool:

| Tool              | Description                                           | Required Params |
| ----------------- | ----------------------------------------------------- | --------------- |
| `memory_search`   | Semantic search across all memories                   | `query`         |
| `memory_ask`      | Natural language question with LLM-synthesized answer | `query`         |
| `memory_remember` | Store a new memory                                    | `text`          |
| `memory_forget`   | Delete a memory by ID                                 | `memoryId`      |
| `memory_timeline` | Chronological view of recent memories                 | _(none)_        |
| `person_context`  | Full details about a contact                          | `contactId`     |
| `people_search`   | Find contacts by name, email, or phone                | `query`         |

### System Prompt Hook

The plugin registers a `before_prompt_build` hook that:

1. **Always** prepends Botmem usage instructions to the agent's system prompt (teaches the agent when/how to use each tool)
2. If `autoContext` is enabled, appends a one-line summary of memory stats (e.g. "Botmem: 12,847 memories (gmail: 8,201, slack: 3,102), 248 contacts")

If the API is unreachable, the stats line is silently skipped.

### Toon-Encoded Responses

All tool responses use [toon format](https://github.com/toon-format/toon) — a compact structured encoding that saves 40-60% of tokens compared to JSON. Your agent reads it natively; no extra parsing needed.

## Tool Details

### memory_search

Semantic search across emails, messages, photos, and locations. Results are ranked using Botmem's scoring formula:

```
final = 0.40×semantic + 0.30×rerank + 0.15×recency + 0.10×importance + 0.05×trust
```

**Parameters:**

| Param           | Type     | Description                                                       |
| --------------- | -------- | ----------------------------------------------------------------- |
| `query`         | `string` | Natural language search query                                     |
| `sourceType`    | `string` | Filter: `email`, `message`, `photo`, `location`                   |
| `connectorType` | `string` | Filter: `gmail`, `slack`, `whatsapp`, `imessage`, `photos-immich` |
| `contactId`     | `string` | Filter by contact UUID                                            |
| `from`          | `string` | Start date (ISO 8601)                                             |
| `to`            | `string` | End date (ISO 8601)                                               |
| `limit`         | `number` | Max results                                                       |

### memory_ask

Like `memory_search`, but the server synthesizes a natural language answer from matching memories. Best for questions like _"What did John say about the project deadline?"_

**Parameters:** `query` (required), `limit` (optional)

### memory_remember

Store a new memory. The text will be embedded and enriched through the standard pipeline (entity extraction, factuality classification, etc.).

**Parameters:** `text` (required), `metadata` (optional object)

### memory_forget

Delete a specific memory by ID. Removes from both the database and vector store.

**Parameters:** `memoryId` (required)

### memory_timeline

Chronological view of memories, optionally filtered. Useful for "what happened last week" or "show me recent emails from X".

**Parameters:** `contactId`, `connectorType`, `sourceType`, `days`, `limit` — all optional

### person_context

Full context about a person: contact details, all known identifiers (email, phone, Slack ID, etc.), recent memories, and interaction stats.

**Parameters:** `contactId` (required) — use `people_search` first to find the ID

### people_search

Find contacts by name, email, or phone number. Returns matching contacts with their identifiers.

**Parameters:** `query` (required), `limit` (optional)

## Primary vs Secondary Memory

The plugin does **not** force a `kind: "memory"` declaration — you decide in your OpenClaw config whether Botmem is primary or secondary memory. The plugin simply registers agent tools that the agent can call as needed.

## Example: Full OpenClaw Config

In `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["botmem"],
    "entries": {
      "botmem": {
        "enabled": true,
        "config": {
          "apiUrl": "https://botmem.xyz/api",
          "apiKey": "bm_sk_...",
          "defaultLimit": 10,
          "autoContext": true
        }
      }
    }
  }
}
```

With this config, your agent can:

```
User: "What did Sarah email me about last week?"
Agent: [calls memory_search with query="Sarah email", from="2026-03-06"]
→ Returns ranked results from Gmail with relevance scores

User: "Remember that the team dinner is at 7pm on Friday"
Agent: [calls memory_remember with text="Team dinner at 7pm on Friday"]
→ Stored, embedded, and enrichable

User: "Who is John Smith?"
Agent: [calls people_search with query="John Smith"]
Agent: [calls person_context with the returned contactId]
→ Full contact profile with all identifiers and recent interactions
```

## Source Code

The plugin source is at [`packages/openclaw-plugin/`](https://github.com/botmem/botmem/tree/main/packages/openclaw-plugin) in the monorepo.

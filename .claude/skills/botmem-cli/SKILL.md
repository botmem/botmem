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

## Setup

```bash
# Ensure built
pnpm build
# Or use directly
npx botmem --help
```

Set `BOTMEM_API_URL` env var or pass `--api-url` to point to a non-default API.

## Common Commands

```bash
# Search memories
npx botmem search "coffee with Ahmed"
npx botmem search "meeting" --connector gmail --limit 5

# Check status
npx botmem status

# List/search contacts
npx botmem contacts
npx botmem contacts search "Amr"

# Get contact details + their memories
npx botmem contact <id>
npx botmem contact <id> memories

# View pipeline jobs
npx botmem jobs

# Trigger sync
npx botmem sync <accountId>

# Retry all failed
npx botmem retry

# Memory stats
npx botmem stats
```

## JSON Mode (for agents/scripts)

Add `--json` to any command:

```bash
npx botmem search "project update" --json | jq '.[].text'
npx botmem status --json | jq '.stats.total'
npx botmem accounts --json | jq '.accounts[].id'
```

## Typical Workflow

1. `botmem status` - check system health
2. `botmem search "topic"` - find relevant memories
3. `botmem memory <id>` - drill into a result
4. `botmem contact <id>` - check who was involved
5. `botmem contact <id> memories` - see all their interactions

## Error Handling

- API unreachable: shows connection error with hint to run `pnpm dev`
- No results: shows "No results found" message
- Bad arguments: shows command-specific help

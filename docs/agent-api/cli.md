# CLI Reference

The `botmem` CLI lets you query and manage your personal memory system from the terminal.

## Installation

The CLI is built as part of the monorepo:

```bash
pnpm build
npx botmem --help
```

## Global Options

| Flag | Description |
|---|---|
| `--api-url <url>` | API base URL (env: `BOTMEM_API_URL`, default: `http://localhost:3001/api`) |
| `--json` | Output raw JSON for piping to `jq` or scripts |
| `-h, --help` | Show help |

## Commands

### `search <query>`

Semantic search across all memories.

```bash
botmem search "coffee with Ahmed last week"
botmem search "meeting" --connector gmail --limit 5
botmem search "photos from dubai" --source photo --json
```

Options: `--source`, `--connector`, `--contact`, `--limit`

### `memories`

List recent memories with pagination.

```bash
botmem memories --limit 10
botmem memories --connector slack
```

### `memory <id>`

Get or delete a single memory.

```bash
botmem memory <id>
botmem memory <id> delete
```

### `stats`

Memory count breakdown by source, connector, and factuality.

### `contacts`

List contacts or search by name/email/phone.

```bash
botmem contacts
botmem contacts search "Amr"
```

### `contact <id>`

Get contact details or their memories.

```bash
botmem contact <id>
botmem contact <id> memories
```

### `status`

Dashboard overview showing memory counts, pipeline status, and connector health.

### `jobs`

List sync/pipeline jobs.

```bash
botmem jobs
botmem jobs --account <id>
```

### `sync <accountId>`

Trigger a connector sync.

### `retry`

Retry all failed sync jobs and re-enqueue failed memories.

### `accounts`

List connected accounts.

## JSON Mode

Add `--json` to any command for machine-readable output:

```bash
botmem search "project update" --json | jq '.[].text'
botmem status --json | jq '.stats.total'
```

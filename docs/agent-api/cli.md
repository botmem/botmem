# CLI Reference

The `botmem` CLI lets you query and manage your personal memory system from the terminal.

## Installation

The CLI is published to npm:

```bash
npx botmem --help
```

Or build from the monorepo:

```bash
pnpm build
npx botmem --help
```

## Global Options

| Flag              | Description                                                                 |
| ----------------- | --------------------------------------------------------------------------- |
| `--api-url <url>` | API base URL (env: `BOTMEM_API_URL`, default: `http://localhost:12412/api`) |
| `--api-key <key>` | API key for authentication (env: `BOTMEM_API_KEY`)                          |
| `--json`          | Output raw JSON for piping to `jq` or scripts                               |
| `-h, --help`      | Show help                                                                   |

## Authentication

```bash
# Interactive login (email/password)
botmem login

# Login with API key
botmem login --api-key bm_sk_abc123...

# Check auth status
botmem version
```

Credentials are stored locally after login. Alternatively, set `BOTMEM_API_KEY` environment variable.

## Commands

### `login`

Authenticate with the Botmem API.

```bash
botmem login
botmem login --api-key bm_sk_abc123...
```

### `search <query>`

Semantic search across all memories.

```bash
botmem search "coffee with Ahmed last week"
botmem search "meeting" --connector gmail --limit 5
botmem search "photos from dubai" --source photo --json
```

Options: `--source`, `--connector`, `--contact`, `--limit`

### `ask <question>`

Ask a question — AI synthesizes an answer from your memories.

```bash
botmem ask "What did John say about the project deadline?"
botmem ask "When is the next team meeting?" --json
```

### `timeline <topic>`

Build a chronological timeline for a topic.

```bash
botmem timeline "project launch"
botmem timeline "vacation planning" --limit 20
```

### `context <topic>`

Get relevant context for a conversation topic.

```bash
botmem context "Q3 budget review"
```

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

### `entities`

List extracted entities across all memories.

```bash
botmem entities
botmem entities --type person
```

### `memory-banks`

Manage memory banks (named collections of memories).

```bash
botmem memory-banks
botmem memory-banks create "Work Projects"
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

### `version`

Show CLI and API versions.

```bash
botmem version
```

## JSON Mode

Add `--json` to any command for machine-readable output:

```bash
botmem search "project update" --json | jq '.[].text'
botmem status --json | jq '.stats.total'
botmem ask "next meeting?" --json | jq '.answer'
```

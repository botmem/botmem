# CLI Reference

The `botmem` CLI lets you query and manage your personal memory system from the terminal.

## Installation

The CLI is published to npm as `@botmem/cli`:

```bash
# Run directly (no install needed)
npx @botmem/cli --help

# Or install globally
npm install -g @botmem/cli
botmem --help
```

Or build from the monorepo:

```bash
pnpm build
npx botmem --help
```

## Agent Skill Installation

The CLI package includes a `botmem-cli` skill for agents that read `SKILL.md` files. The skill teaches agents to use `--toon`, `--toon-fields`, contact-scoped searches, and connector verification before making claims from memory results.

### Claude Code / Codex-style agents

From the workspace where you want the skill installed:

```bash
npm install -g @botmem/cli
botmem install-skill
```

This writes `.agents/skills/botmem-cli/SKILL.md` and links `.claude/skills/botmem-cli/SKILL.md` to it.

### Hermes Agent

Hermes can install the Botmem skill through its own skills CLI. The canonical skill source is `.agents/skills/botmem-cli/SKILL.md` in this repository.

```bash
npm install -g @botmem/cli
hermes skills inspect skills-sh/botmem/botmem/botmem-cli
hermes skills install skills-sh/botmem/botmem/botmem-cli --yes --force
```

If the skills.sh index has not picked up the latest Botmem skill yet, install the canonical skill file directly:

```bash
hermes skills inspect https://raw.githubusercontent.com/botmem/botmem/main/.agents/skills/botmem-cli/SKILL.md
hermes skills install https://raw.githubusercontent.com/botmem/botmem/main/.agents/skills/botmem-cli/SKILL.md --yes --force
```

Hermes may flag the skill with a `CAUTION` supply-chain warning because the skill instructs agents to install `@botmem/cli` from npm. Review the inspect output first, then use `--force` if you trust the package.

Installed skills take effect in new Hermes sessions. Use `/reset` in the current chat or start a new session. To verify:

```bash
hermes skills list | grep botmem-cli
```

After the skill is active, Hermes should install `@botmem/cli` automatically when the `botmem` command is missing, then walk the user through host, login/API-key, and recovery-key configuration. You can also configure the CLI manually in Hermes' shell environment:

```bash
botmem config set-host api.botmem.xyz
botmem config set-key bm_sk_...
botmem login # stores a standard CLI login JWT accepted by Botmem data endpoints
botmem config set-recovery-key <base64-key> # unlocks memory data; encrypted fields are never returned
botmem version --toon-fields buildTime,gitHash,uptime
```

## Global Options

| Flag              | Description                                                             |
| ----------------- | ----------------------------------------------------------------------- |
| `--api-url <url>` | API base URL (env: `BOTMEM_API_URL`, default: `https://api.botmem.xyz`) |
| `--api-key <key>` | API key for authentication (env: `BOTMEM_API_KEY`)                      |
| `--json`          | Output raw JSON for piping to `jq` or scripts                           |
| `--toon`          | Output compact TOON for LLM agents                                      |
| `--toon-fields`   | Select comma-separated dot paths before TOON encoding                   |
| `-h, --help`      | Show help                                                               |

## Authentication

```bash
# Browser login
botmem login

# Configure an API key
botmem config set-key bm_sk_abc123...

# Clear a stale stored API key
botmem config clear-key

# Check auth status
botmem version
```

Credentials are stored locally in `~/.botmem/config.json` after login. Alternatively, set `BOTMEM_API_KEY` environment variable.

::: tip Self-hosted setup
On first run, the CLI prompts you to configure your API URL. You can also set it manually:

```bash
botmem config set-host localhost:12412    # Self-hosted (default)
botmem config set-host botmem.example.com # Custom domain
```

:::

## Commands

### `login`

Authenticate with the Botmem API.

```bash
botmem login
botmem config set-key bm_sk_abc123...
```

### `search <query>`

Semantic search across all memories.

```bash
botmem search "coffee with Ahmed last week"
botmem search "meeting" --connector gmail --limit 5
botmem contacts search "Ahmed" --toon
botmem search "coffee last week" --contact <contact-id>
botmem search "photos from dubai" --source photo --json
```

Options: `--source`, `--connector`, `--contact`, `--limit`

For person-specific searches, resolve the contact first and pass `--contact <id>`. A name inside the query is treated as an attribution hint, not a hard filter.

### `ask <question>`

Ask a question — AI synthesizes an answer from your memories.

```bash
botmem ask "What did John say about the project deadline?"
botmem ask "What did he say about the project deadline?" --contact <contact-id>
botmem ask "When is the next team meeting?" --json
```

### `timeline`

Browse memories by event-time range, optionally filtered by query/source/connector.

```bash
botmem timeline --from 2026-01-01 --to 2026-02-01
botmem timeline --from 2026-01-01 --query "project launch" --limit 20
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

For agents, `status` is the first discovery command: it shows memory counts, accounts, registered connectors, queue health, and last sync/update times.

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

## CLI/MCP Parity

CLI command help and MCP tool descriptions are generated from a shared registry in `packages/shared/src/agent-tools.ts`. The MCP surface currently exposes `status`, `sources`, `list`, `timeline`, `search`, `ask`, and `get_memory`.

Use `botmem memories --source location --limit 1` or the MCP `list` tool with `source_type: "location"` and `sort_by: "eventTime"` for latest/current-state questions. Use semantic `search` when relevance ranking matters more than exact timestamp order.

## JSON Mode

Add `--json` to any command for machine-readable output:

```bash
botmem search "project update" --json | jq '.[].text'
botmem status --json | jq '.stats.total'
botmem ask "next meeting?" --json | jq '.answer'
```

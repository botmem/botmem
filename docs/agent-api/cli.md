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

Hermes can install the published Botmem skill through its own skills CLI. The skill is published through skills.sh from this repository.

```bash
npm install -g @botmem/cli
hermes skills inspect skills-sh/botmem/botmem/.claude/skills/botmem-cli
hermes skills install skills-sh/botmem/botmem/.claude/skills/botmem-cli --yes --force
```

Hermes may flag the skill with a `CAUTION` supply-chain warning because the skill instructs agents to install `@botmem/cli` from npm. Review the inspect output first, then use `--force` if you trust the package.

Installed skills take effect in new Hermes sessions. Use `/reset` in the current chat or start a new session. To verify:

```bash
hermes skills list | grep botmem-cli
```

Configure the CLI for Hermes' shell environment:

```bash
botmem config set-host botmem.xyz
botmem config set-key bm_sk_...
botmem config set-recovery-key <base64-key> # required for encrypted memories
botmem version --toon-fields buildTime,gitHash,uptime
```

## Global Options

| Flag              | Description                                                                 |
| ----------------- | --------------------------------------------------------------------------- |
| `--api-url <url>` | API base URL (env: `BOTMEM_API_URL`, default: `http://localhost:12412/api`) |
| `--api-key <key>` | API key for authentication (env: `BOTMEM_API_KEY`)                          |
| `--json`          | Output raw JSON for piping to `jq` or scripts                               |
| `--toon`          | Output compact TOON for LLM agents                                          |
| `--toon-fields`   | Select comma-separated dot paths before TOON encoding                       |
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

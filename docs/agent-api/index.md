# Agent API & CLI

Botmem is designed to be the memory layer for your AI agents. The **`botmem` CLI** and **REST API** provide both human-readable and JSON output for querying and managing your memory system.

## How It Works

```
+------------------+     +------------------+
|   Human / Agent  |     |   Botmem API     |
|                  +---->+   port 12412      |
|   botmem search  |     |                  |
|   botmem ask     |     |   Semantic search|
|   botmem --json  |     |   AI-powered Q&A |
+------------------+     +------------------+
```

The `botmem` CLI talks directly to the Botmem REST API. Use `--json` for machine-readable output (pipe to `jq` or use from scripts/agents).

::: info Authentication required
All API endpoints require authentication. Use `botmem login` to authenticate the CLI, or pass an API key with `--api-key bm_sk_...`. See [Authentication](/guide/authentication) for details.
:::

## What You Can Do

With the `botmem` CLI, you can:

- **Search memories** — "Find emails about the Q3 budget" returns semantically ranked results with scores
- **Ask questions** — "What did John say about the project deadline?" uses AI to synthesize an answer from your memories
- **Build timelines** — "Show me everything related to the project launch" across email, Slack, and WhatsApp
- **Get context** — Retrieve relevant context for a conversation topic
- **Look up contacts** — "Who is Sarah Chen?" returns all known identifiers, metadata, and associated memories
- **Store new information** — "Remember that the deadline was moved to March 15th" creates a manual memory
- **Cross-reference sources** — "Did John's Slack message about the budget match what he said in the email?" leverages the factuality system

## Agent REST Endpoints

| Method | Path                  | Description                                          |
| ------ | --------------------- | ---------------------------------------------------- |
| `POST` | `/api/agent/ask`      | Ask a question — AI synthesizes answer from memories |
| `POST` | `/api/agent/timeline` | Build a timeline for a topic                         |
| `POST` | `/api/agent/context`  | Get relevant context for a conversation              |
| `POST` | `/api/agent/remember` | Store a new memory                                   |
| `GET`  | `/api/agent/entities` | List extracted entities                              |

## CLI Tools

| Command        | Description                                               |
| -------------- | --------------------------------------------------------- |
| `search`       | Semantic search across all memories with optional filters |
| `ask`          | Ask a question (AI-powered synthesis)                     |
| `timeline`     | Build a timeline for a topic                              |
| `context`      | Get context for a conversation                            |
| `memories`     | List memories with pagination                             |
| `memory`       | Get or delete a single memory                             |
| `contacts`     | List or search contacts                                   |
| `contact`      | Get contact details or memories                           |
| `stats`        | Memory count breakdown                                    |
| `status`       | Dashboard overview                                        |
| `entities`     | List extracted entities                                   |
| `memory-banks` | Manage memory banks                                       |

See the [CLI Reference](/agent-api/cli) for complete command documentation.

## MCP Server

Botmem also exposes an [MCP (Model Context Protocol)](https://modelcontextprotocol.io) endpoint at `POST /mcp` for compatible AI clients. The MCP endpoint uses OAuth Bearer tokens for authentication — API keys (`bm_sk_*`) are not supported on this endpoint.

For most agent integrations, we recommend using the **REST API with API keys** instead, which supports all the same operations and is simpler to set up.

## Next Steps

- [CLI Reference](/agent-api/cli) for all commands and options
- [Tools Reference](/agent-api/tools-reference) for REST API schemas
- [See example workflows](/agent-api/examples) for common use cases

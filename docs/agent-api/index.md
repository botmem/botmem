# Agent API & CLI

Botmem is designed to be the memory layer for your AI agents. The **`botmem` CLI**, **REST API**, and **MCP endpoint** expose the same core memory operations for querying and managing your memory system.

## How It Works

```
+------------------+     +------------------+
|   Human / Agent  |     |   Botmem API     |
|                  +---->+   port 12412      |
|   botmem search  |     |                  |
|   botmem ask     |     |   Semantic search|
|   botmem --toon  |     |   AI-powered Q&A |
+------------------+     +------------------+
```

The `botmem` CLI talks directly to the Botmem REST API. Use `--toon` or `--toon-fields` for compact machine-readable output in agent workflows; use `--json` when a script specifically needs raw JSON.

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

MCP tools are generated from the same shared registry used by the CLI help:

| Tool         | Use it for                                                                 |
| ------------ | -------------------------------------------------------------------------- |
| `status`     | Discover memory counts, accounts, connectors, queue health, and last syncs |
| `sources`    | Discover available `source_type` and `connector_type` filters              |
| `list`       | Browse latest memories sorted by `eventTime` or `ingestTime`               |
| `timeline`   | Browse memories inside an explicit event-time range                        |
| `search`     | Semantic lookup with optional source, connector, contact, and date filters |
| `ask`        | Question answering over retrieved memory context                           |
| `get_memory` | Fetch one full memory record by id                                         |

For latest/current-state questions, prefer `list` with `sort_by: "eventTime"` before using semantic `search`. For unknown source names, call `sources` before guessing filters.

For most agent integrations, we recommend using the **REST API with API keys** instead, which supports all the same operations and is simpler to set up.

## Next Steps

- [CLI Reference](/agent-api/cli) for all commands and options
- [Tools Reference](/agent-api/tools-reference) for REST API schemas
- [See example workflows](/agent-api/examples) for common use cases

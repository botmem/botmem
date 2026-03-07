# Agent API & CLI

Botmem is designed to be the memory layer for your AI agents. The **`botmem` CLI** provides both human-readable and JSON output for querying and managing your memory system.

## How It Works

```
+------------------+     +------------------+
|   Human / Agent  |     |   Botmem API     |
|                  +---->+   port 3001      |
|   botmem search  |     |                  |
|   botmem status  |     |   Semantic search|
|   botmem --json  |     |   Contact lookup |
+------------------+     +------------------+
```

The `botmem` CLI talks directly to the Botmem REST API. Use `--json` for machine-readable output (pipe to `jq` or use from scripts/agents).

## What You Can Do

With the `botmem` CLI, you can:

- **Search memories** -- "Find emails about the Q3 budget" returns semantically ranked results with scores
- **Recall specific events** -- "What happened at the coffee meeting on Tuesday?" pulls context from all connected sources
- **Look up contacts** -- "Who is Sarah Chen?" returns all known identifiers, metadata, and associated memories
- **Build timelines** -- "Show me everything related to the project launch" across email, Slack, and WhatsApp
- **Store new information** -- "Remember that the deadline was moved to March 15th" creates a manual memory
- **Cross-reference sources** -- "Did John's Slack message about the budget match what he said in the email?" leverages the factuality system

## Available Tools

| Tool | Description |
|---|---|
| `search_memories` | Semantic search across all memories with optional filters |
| `get_memory` | Retrieve a specific memory by ID |
| `list_memories` | List memories with pagination and filters |
| `store_memory` | Create a new manual memory |
| `delete_memory` | Remove a memory |
| `search_contacts` | Search contacts by name, email, or phone |
| `get_contact` | Get full contact details including identifiers |
| `get_contact_memories` | List all memories associated with a contact |
| `get_memory_stats` | Get statistics about the memory store |
| `get_memory_graph` | Get the memory relationship graph |

See the [Tools Reference](/agent-api/tools-reference) for complete schemas and examples.

## Next Steps

- [CLI Reference](/agent-api/cli) for all commands and options
- [Browse the tools reference](/agent-api/tools-reference) for REST API schemas
- [See example workflows](/agent-api/examples) for common use cases

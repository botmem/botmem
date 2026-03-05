# Agent API

Botmem is designed to be the memory layer for your AI agents. Through the **Model Context Protocol (MCP)**, any MCP-compatible agent -- Claude, GPT, or custom agents -- can query your personal memory, find contacts, build timelines, and store new information.

## How It Works

```
+------------------+     +------------------+     +------------------+
|   AI Agent       |     |   MCP Server     |     |   Botmem API     |
|   (Claude, etc.) +---->+   (stdio/SSE)    +---->+   port 3001      |
|                  |     |                  |     |                  |
|   "What did John |     |   Translates     |     |   Semantic search|
|    say about     |     |   tool calls     |     |   Contact lookup |
|    the budget?"  |     |   to REST calls  |     |   Memory insert  |
+------------------+     +------------------+     +------------------+
```

The MCP server acts as a bridge between your AI agent and the Botmem REST API. It exposes a set of tools that agents can call to interact with your memory store.

## What Agents Can Do

With Botmem's MCP tools, your agents can:

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

- [Set up the MCP server](/agent-api/mcp-server) for Claude Desktop or other agents
- [Browse the tools reference](/agent-api/tools-reference) for input/output schemas
- [See example workflows](/agent-api/examples) for common agent use cases

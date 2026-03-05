# MCP Server Setup

The Botmem MCP server exposes your personal memory to AI agents via the [Model Context Protocol](https://modelcontextprotocol.io/). It runs as a stdio transport process that translates MCP tool calls into Botmem REST API requests.

## Claude Desktop Configuration

Add Botmem to your Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "botmem": {
      "command": "npx",
      "args": ["-y", "@botmem/mcp-server"],
      "env": {
        "BOTMEM_API_URL": "http://localhost:3001/api"
      }
    }
  }
}
```

### Configuration File Locations

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

## Running from Source

If you are developing locally, you can run the MCP server directly from the monorepo:

```json
{
  "mcpServers": {
    "botmem": {
      "command": "node",
      "args": ["--loader", "ts-node/esm", "packages/mcp-server/src/index.ts"],
      "cwd": "/path/to/botmem",
      "env": {
        "BOTMEM_API_URL": "http://localhost:3001/api"
      }
    }
  }
}
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `BOTMEM_API_URL` | `http://localhost:3001/api` | The Botmem REST API base URL |

## Verifying the Connection

After configuring Claude Desktop, restart it. You should see Botmem's tools appear in the tool list. Try a simple query:

> "Search my memory for recent emails about project deadlines"

Claude will call the `search_memories` tool and return ranked results from your personal memory store.

## Using with Other Agents

Any MCP-compatible agent can connect to the Botmem MCP server. The server uses the standard MCP stdio transport, so it works with:

- **Claude Desktop** (native MCP support)
- **Claude Code** (via MCP configuration)
- **Custom agents** using the MCP SDK (`@modelcontextprotocol/sdk`)

### SSE Transport

For web-based agents or remote connections, you can also run the MCP server with SSE (Server-Sent Events) transport:

```bash
BOTMEM_API_URL=http://localhost:3001/api \
  npx @botmem/mcp-server --transport sse --port 3002
```

Then configure your agent to connect to `http://localhost:3002/sse`.

## Security Considerations

The MCP server has full read/write access to your Botmem memory store. Keep these points in mind:

- **Run locally** -- the MCP server should run on the same machine as your agent
- **Network access** -- the server needs HTTP access to the Botmem API
- **No authentication** -- the Botmem API does not currently require authentication (it is designed for single-user, local deployment)
- **Agent permissions** -- the MCP server exposes both read and write tools; agents can create and delete memories

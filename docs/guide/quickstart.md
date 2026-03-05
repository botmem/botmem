# Quick Start

Get Botmem running locally in under five minutes.

## Prerequisites

- **Node.js** 20+ and **pnpm** 9.15+
- **Docker** and Docker Compose (for Redis and Qdrant)
- **Ollama** running somewhere on your network (or locally)

## 1. Clone and Install

```bash
git clone https://github.com/botmem/botmem.git
cd botmem
pnpm install
```

## 2. Start Infrastructure

Botmem needs Redis (for BullMQ job queues) and Qdrant (for vector search):

```bash
docker compose up -d
```

This starts:
- **Redis 7** on port `6379`
- **Qdrant** on port `6333` (HTTP) and `6334` (gRPC)

## 3. Configure Ollama

Botmem uses Ollama for embeddings, text enrichment, and vision tasks. Make sure you have these models pulled:

```bash
# On your Ollama host
ollama pull nomic-embed-text    # 768-dim embeddings
ollama pull qwen3:4b            # Text enrichment + entity extraction
ollama pull qwen3-vl:4b         # Vision-language for photos
```

If Ollama runs on a different machine, set the `OLLAMA_BASE_URL` environment variable:

```bash
export OLLAMA_BASE_URL=http://192.168.1.100:11434
```

## 4. Start the Dev Servers

```bash
pnpm dev
```

This starts:
- **API** on `http://localhost:3001`
- **Web UI** on `http://localhost:5173`

## 5. Verify the Installation

Check that the API is running:

```bash
curl http://localhost:3001/api/version
```

You should see a JSON response with the version number.

## 6. Connect Your First Data Source

Open the web UI at `http://localhost:5173` and navigate to the Connectors page. Each connector has its own setup flow:

| Connector | Auth Type | What You Need |
|---|---|---|
| Gmail / Google | OAuth 2.0 | Google Cloud OAuth credentials |
| Slack | API Token | Slack user token (`xoxp-...`) |
| WhatsApp | QR Code | WhatsApp mobile app |
| iMessage | Local Tool | macOS with iMessage database |
| Photos / Immich | API Key | Immich server URL + API key |
| OwnTracks | API Key | OwnTracks recorder URL + HTTP auth |

See the [Connectors](/connectors/) section for detailed setup instructions for each source.

## 7. Trigger a Sync

Once a connector is authenticated, trigger a sync from the web UI or via the API:

```bash
# List accounts
curl http://localhost:3001/api/accounts

# Trigger sync for an account
curl -X POST http://localhost:3001/api/jobs/sync/<account-id>
```

The sync pipeline will:
1. Pull data from the source
2. Create raw events in the database
3. Generate embeddings via Ollama
4. Resolve participants into contacts
5. Enrich memories with entities and factuality labels
6. Index everything in Qdrant for semantic search

## 8. Search Your Memories

```bash
curl -X POST http://localhost:3001/api/memories/search \
  -H 'Content-Type: application/json' \
  -d '{"query": "coffee meeting last week", "limit": 5}'
```

## What Next?

- [Set up the MCP server](/agent-api/mcp-server) to let AI agents query your memory
- [Configure all environment variables](/guide/configuration) for production
- [Understand the pipeline](/architecture/pipeline) to know how data flows through the system

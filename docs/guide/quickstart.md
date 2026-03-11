# Quick Start

Get Botmem running locally in under five minutes.

## Prerequisites

- **Node.js** 20+ and **pnpm** 9.15+
- **Docker** and Docker Compose (for PostgreSQL, Redis, and Qdrant)
- **Ollama** running somewhere on your network (or use OpenRouter as a cloud alternative)

## 1. Clone and Install

```bash
git clone https://github.com/botmem/botmem.git
cd botmem
pnpm install
```

## 2. Start Infrastructure

Botmem needs PostgreSQL (structured data), Redis (BullMQ job queues), and Qdrant (vector search):

```bash
docker compose up -d
```

This starts:

- **PostgreSQL 17** on port `5432`
- **Redis 7** on port `6379`
- **Qdrant** on port `6333` (HTTP) and `6334` (gRPC)

## 3. Configure Environment

Create a `.env` file in the project root:

```bash
# Required
DATABASE_URL=postgresql://botmem:botmem@localhost:5432/botmem
```

The `docker-compose.yml` creates the `botmem` database automatically. All other environment variables have sensible defaults for local development. See [Configuration](/guide/configuration) for the full list.

## 4. Configure AI Backend

### Option A: Ollama (default, local)

Make sure you have these models pulled on your Ollama host:

```bash
ollama pull mxbai-embed-large    # 1024-dim embeddings
ollama pull qwen3:8b             # Text enrichment + entity extraction
ollama pull qwen3-vl:4b          # Vision-language for photos
```

If Ollama runs on a different machine, add to your `.env`:

```bash
OLLAMA_BASE_URL=http://192.168.1.100:11434
```

### Option B: OpenRouter (cloud, no GPU needed)

```bash
AI_BACKEND=openrouter
OPENROUTER_API_KEY=sk-or-your-key-here
EMBED_DIMENSION=3072
```

## 5. Start the Dev Servers

```bash
pnpm dev
```

This starts:

- **API** on `http://localhost:12412`
- **Web UI** on `http://localhost:12412`

## 6. Create an Account

Open the web UI at `http://localhost:12412` and **sign up** with an email and password.

After signup, you'll be shown a **recovery key** — save it somewhere safe. This key is used to decrypt your data if the server cache is cleared. It is shown only once.

## 7. Verify the Installation

Check that the API is running:

```bash
curl http://localhost:12412/api/version
```

You should see a JSON response with the version number.

## 8. Connect Your First Data Source

Navigate to the Connectors page in the web UI. Each connector has its own setup flow:

| Connector       | Auth Type  | What You Need                      |
| --------------- | ---------- | ---------------------------------- |
| Gmail / Google  | OAuth 2.0  | Google Cloud OAuth credentials     |
| Slack           | API Token  | Slack user token (`xoxp-...`)      |
| WhatsApp        | QR Code    | WhatsApp mobile app                |
| iMessage        | Local Tool | macOS with iMessage database       |
| Photos / Immich | API Key    | Immich server URL + API key        |
| OwnTracks       | API Key    | OwnTracks recorder URL + HTTP auth |

See the [Connectors](/connectors/) section for detailed setup instructions for each source.

## 9. Trigger a Sync

Once a connector is authenticated, trigger a sync from the web UI or via the API:

```bash
# Get your auth token (or use the web UI)
TOKEN=$(curl -s -X POST http://localhost:12412/api/user-auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"your-password"}' | jq -r '.accessToken')

# List accounts
curl -H "Authorization: Bearer $TOKEN" http://localhost:12412/api/accounts

# Trigger sync for an account
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:12412/api/jobs/sync/<account-id>
```

The sync pipeline will:

1. Pull data from the source
2. Create raw events in the database
3. Generate embeddings via your AI backend
4. Resolve participants into contacts
5. Enrich memories with entities and factuality labels
6. Index everything in Qdrant for semantic search

## 10. Search Your Memories

```bash
curl -X POST http://localhost:12412/api/memories/search \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"query": "coffee meeting last week", "limit": 5}'
```

## What Next?

- [Install the CLI](/agent-api/cli) to query your memory from the terminal
- [Set up authentication](/guide/authentication) to understand tokens, recovery keys, and API keys
- [Configure all environment variables](/guide/configuration) for production
- [Understand the pipeline](/architecture/pipeline) to know how data flows through the system
- [Deploy to production](/guide/deployment) for a self-hosted setup

# Quick Start

Get Botmem running locally in under five minutes.

## Prerequisites

- **Docker** and Docker Compose
- **Ollama** running somewhere on your network (or use OpenRouter as a cloud alternative)

## Option A: Docker (recommended for self-hosting)

```bash
git clone https://github.com/botmem/botmem.git
cd botmem
cp .env.example .env    # Edit as needed (see step 3 below)
docker compose up -d
```

This starts everything: Botmem, PostgreSQL, Redis, and Qdrant. The API and web UI are at `http://localhost:12412`.

Skip to [Step 3: Configure AI Backend](#_3-configure-ai-backend).

## Option B: Development mode (for contributors)

Requires **Node.js** 20+ and **pnpm** 9.15+ in addition to Docker.

### 1. Clone and Install

```bash
git clone https://github.com/botmem/botmem.git
cd botmem
pnpm install
```

### 2. Start Infrastructure

```bash
docker compose up -d postgres redis qdrant
```

This starts only the backing services:

- **PostgreSQL 17** on port `5432`
- **Redis 7** on port `6379`
- **Qdrant** on port `6333` (HTTP) and `6334` (gRPC)

### Configure Environment

```bash
cp .env.example .env
```

The defaults work out of the box for local development. See [Configuration](/guide/configuration) for the full list.

### Start the Dev Servers

```bash
pnpm dev
```

This builds all workspace packages automatically, then starts:

- **API** on `http://localhost:12412`
- **Web UI** on `http://localhost:12412`

## 3. Configure AI Backend

### Option A: Ollama (default, local)

Make sure you have these models pulled on your Ollama host:

```bash
ollama pull nomic-embed-text      # 768-dim embeddings (default in .env.example)
ollama pull qwen3:0.6b            # Text enrichment + entity extraction
ollama pull qwen3-vl:2b           # Vision-language for photos
```

If Ollama runs on a different machine, set `OLLAMA_BASE_URL` in your `.env`:

```bash
OLLAMA_BASE_URL=http://192.168.1.100:11434
```

The embedding dimension is auto-detected from the model name — no manual configuration needed.

::: tip Larger models for better quality
The `.env.example` defaults use small models for quick setup. For better results:

```bash
OLLAMA_EMBED_MODEL=mxbai-embed-large    # 1024-dim, higher quality
OLLAMA_TEXT_MODEL=qwen3:8b              # More capable text model
OLLAMA_VL_MODEL=qwen3-vl:4b            # Better vision model
```

:::

### Option B: OpenRouter (cloud, no GPU needed)

Add to your `.env`:

```bash
AI_BACKEND=openrouter
OPENROUTER_API_KEY=sk-or-your-key-here
```

## 4. Create an Account

Open the web UI at `http://localhost:12412` and **sign up** with an email and password.

After signup, you'll be shown a **recovery key** — save it somewhere safe. This key is used to decrypt your data if the server cache is cleared. It is shown only once.

## 5. Verify the Installation

Check that the API is running:

```bash
curl http://localhost:12412/api/version
```

You should see a JSON response with the version number.

## 6. Connect Your First Data Source

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

## 7. Trigger a Sync

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

## 8. Search Your Memories

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

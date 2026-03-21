# Quick Start

Get Botmem running locally in under five minutes.

## Prerequisites

- **Docker** and Docker Compose
- **Ollama** with models pulled — required for data processing. Without it, syncs will complete but memories won't be searchable. Alternatively, use [OpenRouter](#option-b-openrouter-cloud-no-gpu-needed) as a cloud backend (no local GPU needed).

::: details Minimum hardware

- **Without local Ollama**: 2 GB RAM, 1 CPU core, 10 GB disk (runs PostgreSQL, Redis, Typesense, and the API)
- **With local Ollama**: 8 GB RAM, 4 CPU cores recommended (embedding models need 2-4 GB)
- **Disk**: grows with data volume — roughly 1 GB per 100k memories
  :::

## Option A: Docker (recommended for self-hosting)

```bash
git clone https://github.com/botmem/botmem.git
cd botmem
cp .env.example .env    # Edit as needed (see step 3 below)
docker compose pull     # Ensure you have the latest image
docker compose up -d    # Starts all services
```

This pulls and starts everything: Botmem, PostgreSQL, Redis, and Typesense. The API and web UI are at `http://localhost:12412`.

::: warning Clean start
If you've previously built a local image (`docker compose build`), Docker may use the cached local image instead of the published one. Always run `docker compose pull` first to get the latest release.
:::

::: tip Ollama connectivity
The `.env.example` sets `OLLAMA_BASE_URL=http://localhost:11434` — this is the host-side value. Inside Docker, the compose file overrides this to `http://host.docker.internal:11434` so the container can reach Ollama on your host machine.

- **macOS / Windows**: Works out of the box.
- **Linux**: The compose file includes `extra_hosts: host.docker.internal:host-gateway` which handles this automatically. If you still have issues, set `OLLAMA_BASE_URL` to your machine's LAN IP in `.env`.
  :::

::: tip No Ollama installed?
Run `docker compose --profile ollama up -d` to include a bundled Ollama container. Then pull models inside it:

```bash
docker compose exec ollama ollama pull nomic-embed-text
docker compose exec ollama ollama pull qwen3:0.6b
docker compose exec ollama ollama pull qwen3-vl:2b
```

When using the bundled container, set `OLLAMA_BASE_URL=http://ollama:11434` in your `.env`.
:::

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
docker compose up -d postgres redis typesense
```

This starts only the backing services:

- **PostgreSQL 17** on port `5432`
- **Redis 7** on port `6379`
- **Typesense** on port `8108`

### Configure Environment

```bash
cp .env.example .env
```

The defaults work out of the box for local development. See [Configuration](/guide/configuration) for the full list.

### Start the Dev Servers

```bash
pnpm dev
```

This automatically builds shared packages first (`@botmem/shared`, `@botmem/connector-sdk`, etc.), then starts:

- **API** on `http://localhost:12412`
- **Web UI** on `http://localhost:12412`

## 3. Configure AI Backend

### Option A: Ollama (default, local)

Make sure you have these models pulled on your Ollama host:

```bash
ollama pull nomic-embed-text      # 768-dim embeddings (default in .env.example)
ollama pull qwen3:0.6b            # Text enrichment + entity extraction
ollama pull qwen3-vl:2b           # Vision-language for photos
# Optional: reranker for better search quality
ollama pull sam860/qwen3-reranker:0.6b-Q8_0
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

| Connector       | Auth Type  | What You Need                             |
| --------------- | ---------- | ----------------------------------------- |
| Gmail / Google  | OAuth 2.0  | Google Cloud OAuth credentials            |
| Slack           | API Token  | Slack user token (`xoxp-...`)             |
| WhatsApp        | QR Code    | WhatsApp mobile app                       |
| iMessage        | Local Tool | macOS with iMessage database              |
| Photos / Immich | API Key    | Immich server URL + API key               |
| Telegram        | Phone Code | Telegram phone number + verification code |
| OwnTracks       | API Key    | OwnTracks recorder URL + HTTP auth        |

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
6. Index everything in Typesense for semantic search

## 8. Search Your Memories

```bash
curl -X POST http://localhost:12412/api/memories/search \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"query": "coffee meeting last week", "limit": 5}'
```

## Troubleshooting

### "Email already registered" or stale data after upgrade

If you've run Botmem before, the PostgreSQL volume still has your old data. This can also cause issues when switching between image versions. For a truly clean start:

```bash
docker compose down -v   # Removes all volumes (PostgreSQL, Redis, Typesense data)
docker compose pull      # Ensure latest image
docker compose up -d     # Fresh start
```

::: tip Normal upgrade (preserves data)
For most upgrades: `docker compose pull && docker compose up -d`. Only use `down -v` if you encounter persistent issues after a major version change — it deletes all data.
:::

### API curl examples with special characters

When testing via `curl`, make sure to properly quote JSON values. Special characters like `!` in passwords can cause JSON parse errors if not properly escaped in your shell:

```bash
# Use single quotes around the -d argument to avoid shell interpretation
curl -X POST http://localhost:12412/api/user-auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"MyPassword123"}'
```

::: warning Bash/Zsh escaping
In bash and zsh, `!` inside double quotes triggers history expansion. Always use **single quotes** around your `-d` JSON body, or escape with `\!`.
:::

### "Failed to pre-warm embedding model" warning

On startup you may see this warning in the API logs. This is normal — it means the API started before Ollama finished loading the model. The model will be loaded automatically on first use (first search or sync). No action needed.

### "Using default dev secrets" log message

You'll see `Using default dev secrets (OK for local/self-hosted dev)` in the API logs when running with the default `.env.example` values. This is expected for local development. In production (`NODE_ENV=production`), you must set custom secrets — see [Configuration](/guide/configuration).

### Upgrading

Docker images are tagged with version numbers (e.g., `ghcr.io/botmem/botmem:v1.2.3`). To pin a version, change the `image:` line in `docker-compose.yml`.

For most upgrades, pull the latest image and restart:

```bash
docker compose pull
docker compose up -d
```

A full reset (wipes all data) is only needed if you encounter persistent issues after a major version change:

```bash
docker compose down -v   # WARNING: deletes all data
docker compose pull
docker compose up -d
```

## What Next?

- [Install the CLI](/agent-api/cli) to query your memory from the terminal
- [Set up authentication](/guide/authentication) to understand tokens, recovery keys, and API keys
- [Configure all environment variables](/guide/configuration) for production
- [Understand the pipeline](/architecture/pipeline) to know how data flows through the system
- [Deploy to production](/guide/deployment) for a self-hosted setup

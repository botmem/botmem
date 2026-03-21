# Configuration

Botmem is configured through environment variables. All variables have sensible defaults for local development, except `DATABASE_URL` which is required.

## Environment Variables

### Core Infrastructure

| Variable        | Default                  | Description                                                                            |
| --------------- | ------------------------ | -------------------------------------------------------------------------------------- |
| `PORT`          | `12412`                  | API server port                                                                        |
| `DATABASE_URL`  | _(required)_             | PostgreSQL connection string (e.g. `postgresql://botmem:botmem@localhost:5432/botmem`) |
| `REDIS_URL`     | `redis://localhost:6379` | Redis connection URL for BullMQ job queues                                             |
| `TYPESENSE_URL` | `http://localhost:8108`  | Typesense search engine URL                                                            |
| `FRONTEND_URL`  | `http://localhost:12412` | Frontend origin for CORS and OAuth redirects                                           |
| `BASE_URL`      | _(same as FRONTEND_URL)_ | Public base URL (used for OAuth callbacks)                                             |
| `PLUGINS_DIR`   | `./plugins`              | Directory for external connector plugins                                               |
| `LOGS_PATH`     | `./data/logs.ndjson`     | Path for NDJSON log file output                                                        |

### AI Backend

Botmem supports two AI backends — **Ollama** (local, default) and **OpenRouter** (cloud API). Set `AI_BACKEND` to switch between them.

| Variable          | Default  | Description                                                                                           |
| ----------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `AI_BACKEND`      | `ollama` | AI backend: `ollama` or `openrouter`                                                                  |
| `EMBED_DIMENSION` | _(auto)_ | Embedding vector dimension (auto-detected from model; 768 for nomic, 1024 for mxbai, 3072 for Gemini) |

#### Ollama (default)

| Variable             | Default                  | Description                                                 |
| -------------------- | ------------------------ | ----------------------------------------------------------- |
| `OLLAMA_BASE_URL`    | `http://localhost:11434` | Ollama API base URL                                         |
| `OLLAMA_EMBED_MODEL` | `mxbai-embed-large`      | Embedding model (1024 dimensions)                           |
| `OLLAMA_TEXT_MODEL`  | `qwen3:8b`               | Text enrichment + entity extraction (uses `/no_think` mode) |
| `OLLAMA_VL_MODEL`    | `qwen3-vl:4b`            | Vision-language model for photo/file analysis               |
| `OLLAMA_USERNAME`    | _(empty)_                | Basic auth username for Ollama (optional)                   |
| `OLLAMA_PASSWORD`    | _(empty)_                | Basic auth password for Ollama (optional)                   |

#### OpenRouter (cloud)

| Variable                 | Default                       | Description                                              |
| ------------------------ | ----------------------------- | -------------------------------------------------------- |
| `OPENROUTER_API_KEY`     | _(empty)_                     | OpenRouter API key (required if `AI_BACKEND=openrouter`) |
| `OPENROUTER_EMBED_MODEL` | `google/gemini-embedding-001` | Embedding model (3072 dimensions)                        |
| `OPENROUTER_TEXT_MODEL`  | `mistralai/mistral-nemo`      | Text enrichment model                                    |
| `OPENROUTER_VL_MODEL`    | `google/gemma-3-4b-it`        | Vision-language model                                    |

::: tip OpenRouter dimensions
When using OpenRouter with Gemini embeddings, set `EMBED_DIMENSION=3072` to match the model's output.
:::

### Reranker

Reranking improves search result quality by re-scoring initial vector matches. Optional — when disabled, rerank scores are 0.

| Variable                | Default                                    | Description                                        |
| ----------------------- | ------------------------------------------ | -------------------------------------------------- |
| `RERANKER_BACKEND`      | `ollama` (or `tei` if RERANKER_URL is set) | Backend: `tei`, `ollama`, `jina`, or `none`        |
| `RERANKER_URL`          | _(empty)_                                  | HuggingFace TEI `/rerank` endpoint URL             |
| `OLLAMA_RERANKER_MODEL` | `sam860/qwen3-reranker:0.6b-Q8_0`          | Ollama reranker model                              |
| `JINA_API_KEY`          | _(empty)_                                  | Jina API key (required if `RERANKER_BACKEND=jina`) |

### Authentication

| Variable                 | Default                                     | Description                                |
| ------------------------ | ------------------------------------------- | ------------------------------------------ |
| `AUTH_PROVIDER`          | `local`                                     | Auth provider: `local` (JWT) or `firebase` |
| `JWT_ACCESS_SECRET`      | `dev-access-secret-change-in-production`    | JWT access token signing secret            |
| `JWT_REFRESH_SECRET`     | `dev-refresh-secret-change-in-production`   | JWT refresh token signing secret           |
| `JWT_ACCESS_EXPIRES_IN`  | `15m`                                       | Access token expiry                        |
| `JWT_REFRESH_EXPIRES_IN` | `7d`                                        | Refresh token expiry                       |
| `OAUTH_JWT_SECRET`       | `dev-oauth-jwt-secret-change-in-production` | Secret for OAuth state tokens              |

#### Firebase (optional)

| Variable                   | Default      | Description                                               |
| -------------------------- | ------------ | --------------------------------------------------------- |
| `FIREBASE_PROJECT_ID`      | `botmem-app` | Firebase project ID                                       |
| `FIREBASE_SERVICE_ACCOUNT` | _(empty)_    | Service account JSON string (required on non-GCP servers) |
| `GMAIL_CLIENT_ID`          | _(empty)_    | Server-side Gmail OAuth client ID (Firebase mode)         |
| `GMAIL_CLIENT_SECRET`      | _(empty)_    | Server-side Gmail OAuth client secret (Firebase mode)     |

### Encryption

| Variable     | Default                               | Description                                        |
| ------------ | ------------------------------------- | -------------------------------------------------- |
| `APP_SECRET` | `dev-app-secret-change-in-production` | AES-256-GCM key for encrypting credentials at rest |

::: danger Production secrets
For public-facing deployments, you **must** change `APP_SECRET`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, and `OAUTH_JWT_SECRET` from their defaults. Generate secure secrets with: `openssl rand -base64 48`

The server logs `Using default dev secrets (OK for local/self-hosted)` when defaults are detected. For actual production deployments (Stripe configured or `PRODUCTION_DEPLOY=true`), the server will refuse to start with default secrets.
:::

### Billing (Managed tier only)

| Variable                | Default   | Description                                  |
| ----------------------- | --------- | -------------------------------------------- |
| `STRIPE_SECRET_KEY`     | _(empty)_ | Stripe secret key (empty = self-hosted mode) |
| `STRIPE_WEBHOOK_SECRET` | _(empty)_ | Stripe webhook signing secret                |
| `STRIPE_PRO_PRICE_ID`   | _(empty)_ | Stripe price ID for Pro plan                 |

When `STRIPE_SECRET_KEY` is empty, the app runs in self-hosted mode with no billing features.

### Email (optional)

| Variable    | Default                             | Description                               |
| ----------- | ----------------------------------- | ----------------------------------------- |
| `SMTP_HOST` | _(empty)_                           | SMTP server host (empty = email disabled) |
| `SMTP_PORT` | `587`                               | SMTP server port                          |
| `SMTP_USER` | _(empty)_                           | SMTP username                             |
| `SMTP_PASS` | _(empty)_                           | SMTP password                             |
| `SMTP_FROM` | _(SMTP_USER or noreply@botmem.xyz)_ | Sender email address                      |

### Analytics (optional)

| Variable          | Default                    | Description             |
| ----------------- | -------------------------- | ----------------------- |
| `POSTHOG_API_KEY` | _(empty)_                  | PostHog project API key |
| `POSTHOG_HOST`    | `https://us.i.posthog.com` | PostHog ingestion host  |

### Other

| Variable           | Default     | Description                                                                |
| ------------------ | ----------- | -------------------------------------------------------------------------- |
| `SYNC_DEBUG_LIMIT` | `0`         | Max events per sync (`0` = unlimited full sync; set to e.g. `500` for dev) |
| `DECAY_CRON`       | `0 3 * * *` | Cron schedule for recency weight decay (daily at 3am)                      |

## Docker Compose

The included `docker-compose.yml` starts all infrastructure services:

```yaml
services:
  postgres:
    image: postgres:17-alpine
    ports:
      - '5432:5432'
    environment:
      POSTGRES_USER: botmem
      POSTGRES_PASSWORD: botmem
      POSTGRES_DB: botmem
    volumes:
      - postgres-data:/var/lib/postgresql/data

  redis:
    image: redis:7.4-alpine
    ports:
      - '6379:6379'
    command: redis-server --appendonly yes --appendfsync everysec
    volumes:
      - redis-data:/data

  typesense:
    image: typesense/typesense:30.1
    ports:
      - '8108:8108'
    volumes:
      - typesense-data:/data
    command: '--data-dir /data --api-key=botmem-ts-key'

  # Optional: local Ollama instance
  ollama:
    image: ollama/ollama:0.6.2
    profiles: [ollama]
    ports:
      - '11434:11434'
    volumes:
      - ollama-data:/root/.ollama

  # Optional: HuggingFace TEI reranker
  reranker:
    image: ghcr.io/huggingface/text-embeddings-inference:cpu-1.6
    profiles: [reranker]
    ports:
      - '8080:80'
    command: --model-id BAAI/bge-reranker-v2-m3 --port 80
    volumes:
      - reranker-data:/data
```

To start optional services, use Docker Compose profiles:

```bash
# Core services only (PostgreSQL + Redis + Typesense)
docker compose up -d

# Include local Ollama
docker compose --profile ollama up -d

# Include TEI reranker
docker compose --profile reranker up -d
```

Ollama can also run separately — either locally or on a dedicated GPU machine. Set `OLLAMA_BASE_URL` to point to wherever your Ollama instance lives.

## Example .env File

```bash
# Infrastructure (DATABASE_URL is required)
DATABASE_URL=postgresql://botmem:botmem@localhost:5432/botmem
PORT=12412
REDIS_URL=redis://localhost:6379
TYPESENSE_URL=http://localhost:8108

# AI Backend (choose one)
AI_BACKEND=ollama
OLLAMA_BASE_URL=http://192.168.1.100:11434
OLLAMA_EMBED_MODEL=mxbai-embed-large
OLLAMA_TEXT_MODEL=qwen3:8b
OLLAMA_VL_MODEL=qwen3-vl:4b

# Or use OpenRouter instead:
# AI_BACKEND=openrouter
# OPENROUTER_API_KEY=sk-or-...
# EMBED_DIMENSION=3072

# Auth (defaults are fine for local dev — MUST change in production)
# JWT_ACCESS_SECRET=change-me-in-production
# JWT_REFRESH_SECRET=change-me-in-production
# OAUTH_JWT_SECRET=change-me-in-production

# Encryption
# APP_SECRET=change-me-in-production

# Frontend
FRONTEND_URL=http://localhost:12412
```

## Required AI Models

### Ollama (default backend)

Before starting Botmem, pull the required models on your Ollama host:

```bash
ollama pull mxbai-embed-large    # Embeddings (1024 dimensions, cosine similarity)
ollama pull qwen3:8b             # Text enrichment, entity extraction, factuality
ollama pull qwen3-vl:4b          # Vision-language for photo descriptions
```

The embed model produces 1024-dimensional vectors. Typesense auto-creates the collection on first use with the correct dimensionality.

### OpenRouter (cloud backend)

No model downloads needed. Set your API key and the default models will be used:

- `google/gemini-embedding-001` — embeddings (3072 dimensions)
- `mistralai/mistral-nemo` — text enrichment
- `google/gemma-3-4b-it` — vision-language

## Network Requirements

Botmem needs to reach:

- **PostgreSQL** on `DATABASE_URL` (default: `localhost:5432`)
- **Redis** on `REDIS_URL` (default: `localhost:6379`)
- **Typesense** on `TYPESENSE_URL` (default: `localhost:8108`)
- **Ollama** on `OLLAMA_BASE_URL` (or OpenRouter API if using cloud backend)
- External APIs for each connector (Gmail API, Slack API, etc.)

# Configuration

Botmem is configured through environment variables. All variables have sensible defaults for local development.

## Environment Variables

### Core

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | API server port |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL for BullMQ job queues |
| `DB_PATH` | `./data/botmem.db` | Path to the SQLite database file |
| `QDRANT_URL` | `http://localhost:6333` | Qdrant vector database URL |
| `FRONTEND_URL` | `http://localhost:5173` | Frontend origin for CORS and OAuth redirects |
| `PLUGINS_DIR` | `./plugins` | Directory for external connector plugins |

### Ollama (AI Inference)

| Variable | Default | Description |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://192.168.10.250:11434` | Ollama API base URL |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text` | Model for generating 768-dimensional embeddings |
| `OLLAMA_TEXT_MODEL` | `qwen3:4b` | Model for text enrichment and entity extraction (uses `/no_think` mode) |
| `OLLAMA_VL_MODEL` | `qwen3-vl:4b` | Vision-language model for photo description and file analysis |

### Runtime Settings

Some settings can be changed at runtime via the Settings API without restarting the server:

| Setting Key | Default | Description |
|---|---|---|
| `embed_concurrency` | `4` | Number of concurrent embed queue workers |
| `enrich_concurrency` | `2` | Number of concurrent enrich queue workers |

```bash
# Update runtime settings
curl -X PATCH http://localhost:3001/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"embed_concurrency": "8", "enrich_concurrency": "4"}'
```

## Docker Compose

The included `docker-compose.yml` starts the infrastructure services:

```yaml
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data

  qdrant:
    image: qdrant/qdrant:latest
    ports:
      - "6333:6333"
      - "6334:6334"
    volumes:
      - qdrant-data:/qdrant/storage

volumes:
  redis-data:
  qdrant-data:
```

Ollama is expected to run separately -- either locally or on a dedicated GPU machine. Set `OLLAMA_BASE_URL` to point to wherever your Ollama instance lives.

## Example .env File

```bash
# Infrastructure
PORT=3001
REDIS_URL=redis://localhost:6379
DB_PATH=./data/botmem.db
QDRANT_URL=http://localhost:6333

# AI Inference
OLLAMA_BASE_URL=http://192.168.1.100:11434
OLLAMA_EMBED_MODEL=nomic-embed-text
OLLAMA_TEXT_MODEL=qwen3:4b
OLLAMA_VL_MODEL=qwen3-vl:4b

# Frontend
FRONTEND_URL=http://localhost:5173
```

## Required Ollama Models

Before starting Botmem, pull the required models on your Ollama host:

```bash
ollama pull nomic-embed-text    # Embeddings (768 dimensions, cosine similarity)
ollama pull qwen3:4b            # Text enrichment, entity extraction, factuality
ollama pull qwen3-vl:4b         # Vision-language for photo descriptions
```

The embed model produces 768-dimensional vectors. Qdrant auto-creates the collection on first use with the correct dimensionality.

## SQLite WAL Mode

SQLite runs in WAL (Write-Ahead Logging) mode automatically. This enables concurrent readers without blocking writers. The database file at `DB_PATH` will be accompanied by `-shm` and `-wal` files -- these are normal and should not be deleted while the server is running.

## Network Requirements

Botmem needs to reach:

- **Redis** on `REDIS_URL` (default: `localhost:6379`)
- **Qdrant** on `QDRANT_URL` (default: `localhost:6333`)
- **Ollama** on `OLLAMA_BASE_URL`
- External APIs for each connector (Gmail API, Slack API, Immich, OwnTracks, etc.)

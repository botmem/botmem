# [Support] Botmem — Personal Memory RAG System

Botmem is a self-hosted personal memory/RAG system. It ingests events from multiple data sources, normalizes them into memories and people, and provides cross-modal search and retrieval over your own data.

- Project: https://github.com/botmem/botmem
- Container image: `ghcr.io/botmem/botmem:app-latest`
- Template: https://raw.githubusercontent.com/botmem/botmem/main/unraid/botmem.xml
- Icon: https://raw.githubusercontent.com/botmem/botmem/main/unraid/botmem-icon.png
- Unraid docs: https://github.com/botmem/botmem/tree/main/unraid
- License: AGPL-3.0

## What It Does

Botmem is built for people who want to own and search their personal data locally. It can ingest messages, email, photos, locations, and other connector data, then turn them into a unified memory graph with searchable text, people, entities, timestamps, and source links.

The app includes:

- A local-first web app on port `12412` backed by the companion API on port `12413`
- Connector sync workers for self-hosted installs
- Memory extraction, embedding, enrichment, and search
- Local auth for self-hosted users
- Optional plugin directory support
- Ollama by default, with optional Gemini or OpenRouter configuration

## Requirements

Botmem needs:

- PostgreSQL 16+ with pgvector
- Redis 7+
- One AI backend:
  - Ollama, recommended for fully local inference
  - Gemini, if you prefer Google-hosted models
  - OpenRouter, if you prefer OpenRouter-hosted models

The repo includes a companion compose file for the API and dependencies:

```bash
mkdir -p /mnt/user/appdata/botmem
cp docker-compose.unraid.yml /mnt/user/appdata/botmem/docker-compose.unraid.yml
cd /mnt/user/appdata/botmem
POSTGRES_PASSWORD="$(openssl rand -base64 36)" docker compose -f docker-compose.unraid.yml up -d
mkdir -p /mnt/user/appdata/botmem/data /mnt/user/appdata/botmem/plugins
chown -R 1000:1000 /mnt/user/appdata/botmem/data /mnt/user/appdata/botmem/plugins
```

The companion stack exposes:

- PostgreSQL: `host.docker.internal:15432`
- Redis: `host.docker.internal:16379`
- Botmem API: `host.docker.internal:12413`

The app template proxies to the Botmem API default.

## Required Template Values

Generate these secrets before first start:

```bash
openssl rand -base64 48
openssl rand -base64 32
```

Set:

- `APP_SECRET`
- `JWT_ACCESS_SECRET`
- `JWT_REFRESH_SECRET`
- `OAUTH_JWT_SECRET`
- `ENCRYPTION_SALT`

Keep `AUTH_PROVIDER=local` for self-hosted installs.

Keep `BOTMEM_ENABLE_API_WORKERS=true` for self-hosted installs. This runs the sync and memory workers inside the Botmem API container.

## Ollama Setup

If using Ollama, set:

```text
AI_BACKEND=ollama
OLLAMA_BASE_URL=http://host.docker.internal:11434
OLLAMA_EMBED_MODEL=mxbai-embed-large
OLLAMA_TEXT_MODEL=qwen3:8b
OLLAMA_VL_MODEL=qwen3-vl:4b
```

Pull the models in Ollama first:

```bash
ollama pull mxbai-embed-large
ollama pull qwen3:8b
ollama pull qwen3-vl:4b
```

You can use Gemini or OpenRouter instead by changing `AI_BACKEND` and providing the matching API key.

## First Run

After starting the container, open:

```text
http://<unraid-ip>:12412
```

You should land on the Botmem signup screen. Create a local user, save the recovery key, then connect a data source from the Connectors page.

## iMessage Sync

iMessage sync uses the Botmem CLI from a Mac that has access to the local Messages database:

```bash
botmem config set-host http://<unraid-ip>:12412
botmem login
botmem accounts --toon
botmem sync <imessage-account-id>
botmem search "imessage" --connector imessage --limit 5 --toon
```

The sync is working when the job finishes, iMessage memories appear in the dashboard, people are resolved, and search returns the ingested messages.

## Known Notes

- Botmem is currently beta.
- The data directory and plugin directory must be readable/writable by container uid `1000` where applicable.
- OAuth connectors may need their own provider credentials and redirect URL setup.
- Large first syncs can take time because memories are parsed, embedded, enriched, and indexed.

## Support

Post issues, setup questions, logs, and feature requests in this thread. GitHub issues are also available at:

https://github.com/botmem/botmem/issues

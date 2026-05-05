# Botmem Community Applications Submission

Use this as the working payload for the Unraid Community Applications submission form:

https://form.asana.com/?k=qtIUrf5ydiXvXzPI57BiJw&d=714739274360802

## Status

- Test install on `nasty`: completed
- Test install cleanup on `nasty`: completed
- Container image exists: `ghcr.io/botmem/botmem:latest`
- Supported image platforms: `linux/amd64`, `linux/arm64`
- License: `AGPL-3.0`
- Support thread: https://forums.unraid.net/topic/198623-support-botmem-personal-memory-rag-system/
- CA form submitted: pending

## Submission Fields

Application name:

```text
Botmem
```

Repository:

```text
ghcr.io/botmem/botmem:latest
```

Registry:

```text
https://github.com/botmem/botmem/pkgs/container/botmem
```

Project URL:

```text
https://github.com/botmem/botmem
```

Template URL:

```text
https://raw.githubusercontent.com/botmem/botmem/main/unraid/botmem.xml
```

Icon URL:

```text
https://raw.githubusercontent.com/botmem/botmem/main/unraid/botmem-icon.png
```

Support URL:

```text
https://forums.unraid.net/topic/198623-support-botmem-personal-memory-rag-system/
```

Categories:

```text
Productivity: Tools:Utilities
```

License:

```text
AGPL-3.0
```

Description:

```text
Botmem is a self-hosted personal memory/RAG system. It ingests events from email, messages, photos, locations, and other connectors, normalizes them into memories and people, and provides local-first search, recall, and agent access over your own data.
```

Overview:

```text
Personal memory system that ingests events from multiple data sources (emails, messages, photos, locations), normalizes them into a unified memory schema, and provides cross-modal retrieval with weighted ranking. Local-first, privacy-focused: your data stays on your server.

Requires PostgreSQL 16 with pgvector and Redis 7. The companion compose in the Botmem repo exposes PostgreSQL on host port 15432 and Redis on host port 16379, which match the template defaults.

AI processing can use local Ollama, Google Gemini, or OpenRouter. Ollama is optional if you configure a cloud backend instead.

Quick start: start the companion dependency stack or point DATABASE_URL and REDIS_URL at your existing services, choose an AI backend, generate the required secrets, then open the WebUI and create your first local user. Queue workers run inside the Botmem container for self-hosted installs.
```

Extra search terms:

```text
memory rag personal ai search email messages photos recall knowledge base vector
```

Requirements:

```text
PostgreSQL 16+ with pgvector, Redis 7+. Install these from Community Applications first, or use unraid/docker-compose.unraid.yml from the Botmem repo.
```

Beta:

```text
true
```

## Before Final Submission

1. Create the Unraid forum thread using `unraid/support-thread.md`.
2. Replace `<Support>` in `unraid/botmem.xml` with the forum thread URL.
3. Commit and push the support URL change.
4. Submit the CA form with the final raw template URL.

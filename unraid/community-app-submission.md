# Botmem Community Applications Submission

Use this as the working payload for the Unraid Community Applications repository addition form:

https://form.asana.com/?k=qtIUrf5ydiXvXzPI57BiJw&d=714739274360802

## Status

- Test install on `nasty`: completed
- Test install cleanup on `nasty`: completed
- Container image exists: `ghcr.io/botmem/botmem:app-latest`
- Supported image platforms: `linux/amd64`, `linux/arm64`
- License: `AGPL-3.0`
- Support thread: https://forums.unraid.net/topic/198623-support-botmem-personal-memory-rag-system/
- CA form submitted: pending

## Required Form Fields

Forum Nick Name:

```text
Amr Essam
```

Communication Preference:

```text
Forum PM
```

Real Name:

```text
Optional
```

About You:

```text
Optional
```

GitHub URL:

```text
https://github.com/botmem/botmem
```

Yes, I have GitHub 2FA Enabled:

```text
Confirmed
```

Preferred Repository Name:

```text
Botmem
```

I have viewed and agree to the policies for Community Applications:

```text
I agree
```

Support or Project XML entries added:

```text
Confirmed
```

Any further comments:

```text
Botmem's Docker template is available at:
https://raw.githubusercontent.com/botmem/botmem/main/unraid/botmem.xml

The template includes both:
- <Support>https://forums.unraid.net/topic/198623-support-botmem-personal-memory-rag-system/</Support>
- <Project>https://github.com/botmem/botmem</Project>

Botmem is a beta self-hosted personal memory/RAG system. It requires the companion stack in unraid/docker-compose.unraid.yml, which runs PostgreSQL, Redis, and the Botmem API. The Community Applications template runs the Botmem app frontend.

The container image is:
ghcr.io/botmem/botmem:app-latest

The app icon is:
https://raw.githubusercontent.com/botmem/botmem/main/unraid/botmem-icon.png
```

## App Listing Reference

The form does not currently ask for these app-level fields directly, but they are useful if the moderation team asks for details.

Application name:

```text
Botmem
```

Repository:

```text
ghcr.io/botmem/botmem:app-latest
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

Requires the Botmem companion stack. The companion compose exposes PostgreSQL on host port 15432, Redis on 16379, and the Botmem API on 12413. The template proxies WebUI API traffic to that API upstream.

AI processing can use local Ollama, Google Gemini, or OpenRouter. Ollama is optional if you configure a cloud backend instead.

Quick start: start the companion stack, choose an AI backend in its .env file, generate the required secrets, install the frontend template, then open the WebUI and create your first local user. Queue workers run inside the companion API container for self-hosted installs.
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

1. Confirm the Unraid forum nickname and communication preference.
2. Confirm GitHub 2FA is enabled for the account/org that owns `botmem/botmem`.
3. Submit the CA form with the repository URL and comments above.
4. Update `CA form submitted` status after submission.

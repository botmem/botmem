# Botmem — Unraid Community Applications

Template and supporting files for publishing Botmem to [Unraid Community Applications](https://docs.unraid.net/unraid-os/using-unraid-to/run-docker-containers/community-applications/).

## Files

| File                          | Purpose                                      |
| ----------------------------- | -------------------------------------------- |
| `botmem.xml`                  | Unraid CA Docker template (the main listing) |
| `docker-compose.unraid.yml`   | Companion stack for PostgreSQL and Redis     |
| `botmem-icon.png`             | App icon used by the template                |
| `support-thread.md`           | Draft body for the required forum thread     |
| `community-app-submission.md` | Draft payload for the CA submission form     |

## Publishing Checklist

### Prerequisites

- [x] **Icon**: Commit a PNG icon and host it at `https://raw.githubusercontent.com/botmem/botmem/main/unraid/botmem-icon.png`
- [x] **TemplateURL** points to `https://raw.githubusercontent.com/botmem/botmem/main/unraid/botmem.xml`

### Submission Steps

1. [x] **Create Unraid forum support thread** at [forums.unraid.net](https://forums.unraid.net/) — category: Docker Containers
   - Title: `[Support] Botmem — Personal Memory RAG System`
   - Include: description, install instructions, known issues, screenshots
   - Draft: `unraid/support-thread.md`
   - Posted URL: https://forums.unraid.net/topic/198623-support-botmem-personal-memory-rag-system/
   - Note: posted under Docker Engine because Docker Containers only allows Community Developers to create new topics; the thread is pending moderator approval and can be moved by a moderator.
2. [x] **Update `<Support>` URL** in `botmem.xml` with the forum thread URL
3. [ ] **Submit via [CA submission form](https://form.asana.com/?k=qtIUrf5ydiXvXzPI57BiJw&d=714739274360802)**
   - Provide: Unraid forum nickname, contact preference, Botmem repo URL, and confirmations
   - Use `unraid/community-app-submission.md` for the exact form payload
4. [ ] **Wait for moderation review** (~48 hours)

### Template Location

The template is kept in the main Botmem repo:

```
unraid/
  botmem.xml
  botmem-icon.png
  docker-compose.unraid.yml
  README.md
```

### Dependency Stack

If the user does not already have PostgreSQL 16 with pgvector and Redis 7, run the companion stack. For self-hosted installs, the Botmem API container runs sync and memory queue workers itself with `BOTMEM_ENABLE_API_WORKERS=true`.

```bash
mkdir -p /mnt/user/appdata/botmem
cp docker-compose.unraid.yml /mnt/user/appdata/botmem/docker-compose.unraid.yml
cd /mnt/user/appdata/botmem
POSTGRES_PASSWORD="$(openssl rand -base64 36)" docker compose -f docker-compose.unraid.yml up -d
mkdir -p /mnt/user/appdata/botmem/data /mnt/user/appdata/botmem/plugins
chown -R 1000:1000 /mnt/user/appdata/botmem/data /mnt/user/appdata/botmem/plugins
```

The compose file exposes dependencies on non-conflicting host ports:

- PostgreSQL: `host.docker.internal:15432`
- Redis: `host.docker.internal:16379`

Those ports match the defaults in `botmem.xml`.

### Testing on Unraid

Before submitting, test the template on your own Unraid server:

1. Copy or publish `botmem.xml` so Unraid can read it.
   - Local test path: `/boot/config/plugins/dockerMan/templates-user/my-botmem.xml`
   - Repository test path: Settings > Docker > Template Repositories
2. Install from Apps/Docker tab and verify all config fields render correctly.
3. Generate required secrets with `openssl rand -base64 48` and set:
   - `APP_SECRET`
   - `JWT_ACCESS_SECRET`
   - `JWT_REFRESH_SECRET`
   - `OAUTH_JWT_SECRET`
   - `ENCRYPTION_SALT`
4. Confirm the container starts and the WebUI is accessible at `http://<unraid-ip>:12412`.
5. Confirm `BOTMEM_ENABLE_API_WORKERS=true` is set in the Botmem container.
6. Create a local test user in the WebUI.
7. Connect an iMessage account with the bridge setup flow, then sync with:

```bash
botmem config set-host http://<unraid-ip>:12412
botmem login
botmem accounts --toon
botmem sync <imessage-account-id>
botmem search "imessage" --connector imessage --limit 5 --toon
```

The validation is only complete when the sync job finishes, iMessage memories are visible in the dashboard, contacts are resolved, and `botmem search` returns the ingested messages.

### Env Vars for Unraid Users

Users need to configure at minimum:

- `DATABASE_URL` — PostgreSQL connection string
- `REDIS_URL` — Redis connection string
- `APP_SECRET` — encryption key (generate with `openssl rand -base64 48`)
- `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` — JWT signing keys
- `OAUTH_JWT_SECRET` — connector OAuth state signing key
- `ENCRYPTION_SALT` — deployment-specific encryption salt
- `BOTMEM_ENABLE_API_WORKERS=true` — runs queue workers inside the app container for self-hosted installs
- One AI backend:
  - Ollama: set `AI_BACKEND=ollama` and `OLLAMA_BASE_URL`
  - Gemini: set `AI_BACKEND=gemini` and `GEMINI_API_KEY`
  - OpenRouter: set `AI_BACKEND=openrouter` and `OPENROUTER_API_KEY`

The template adds `--add-host=host.docker.internal:host-gateway`, so `host.docker.internal` resolves to the Unraid host from the Botmem container. This makes it easy to point Botmem at dependency containers exposed on host ports.

### Sensible Defaults

- Data persists under `/mnt/user/appdata/botmem/data` and is mounted to `/app/data`, matching the Docker image runtime.
- The Botmem image runs as user `node` (`uid 1000`), so `/mnt/user/appdata/botmem/data` and `/mnt/user/appdata/botmem/plugins` must be writable/readable by uid `1000`.
- Plugins mount read-only from `/mnt/user/appdata/botmem/plugins` to `/plugins`, with `PLUGINS_DIR=/plugins`.
- `AUTH_PROVIDER=local` for self-hosted installs.
- `BOTMEM_ENABLE_API_WORKERS=true` so connector sync and memory processing run in the same Botmem app container.
- `AI_BACKEND=ollama` by default, matching a common Unraid local-AI setup, but Ollama is optional. Set `AI_BACKEND=gemini` or `AI_BACKEND=openrouter` and provide the matching API key if you do not run Ollama.
- Gemini and OpenRouter fields are present as advanced alternatives.

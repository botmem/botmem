# Botmem — Unraid Community Applications

Template and supporting files for publishing Botmem to [Unraid Community Applications](https://docs.unraid.net/unraid-os/using-unraid-to/run-docker-containers/community-applications/).

## Files

| File                        | Purpose                                                         |
| --------------------------- | --------------------------------------------------------------- |
| `botmem.xml`                | Unraid CA Docker template (the main listing)                    |
| `docker-compose.unraid.yml` | Companion stack for dependencies (PostgreSQL, Redis, Typesense) |
| `botmem-icon.png`           | App icon (TODO: create 512x512 PNG)                             |

## Publishing Checklist

### Prerequisites

- [ ] **Icon**: Create a 512x512 PNG icon, host at `https://raw.githubusercontent.com/botmem/unraid-templates/main/botmem/botmem-icon.png`
- [ ] **Template repo**: Create `botmem/unraid-templates` GitHub repo with `botmem/botmem.xml` and the icon
- [ ] **Update TemplateURL** in `botmem.xml` to point to the raw GitHub URL

### Submission Steps

1. [ ] **Create Unraid forum support thread** at [forums.unraid.net](https://forums.unraid.net/) — category: Docker Containers
   - Title: `[Support] Botmem — Personal Memory RAG System`
   - Include: description, install instructions, known issues, screenshots
2. [ ] **Update `<Support>` URL** in `botmem.xml` with the forum thread URL
3. [ ] **Submit via [CA submission form](https://form.asana.com/?k=qtIUrf5ydiXvXzPI57BiJw&d=714739274360802)**
   - Provide: template repo URL, forum thread URL, Docker image URL
4. [ ] **Wait for moderation review** (~48 hours)

### Template Repo Structure

The `botmem/unraid-templates` repo should look like:

```
botmem/
  botmem.xml          # Docker template
  botmem-icon.png     # 512x512 app icon
README.md
```

### Testing on Unraid

Before submitting, test the template on your own Unraid server:

1. Add the template repo URL in Unraid: Settings > Docker > Template Repositories
2. Install from Apps tab — search for "botmem"
3. Verify all config fields render correctly
4. Confirm the container starts and the WebUI is accessible

### Env Vars for Unraid Users

Users need to configure at minimum:

- `DATABASE_URL` — PostgreSQL connection string
- `REDIS_URL` — Redis connection string
- `TYPESENSE_URL` + `TYPESENSE_API_KEY` — Typesense search
- `APP_SECRET` — encryption key (generate with `openssl rand -base64 48`)
- `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` — JWT signing keys
- `OLLAMA_BASE_URL` — Ollama endpoint (if using local AI)

The template defaults use `host.docker.internal` which resolves to the Unraid host, making it easy to point to other containers running on the same server.

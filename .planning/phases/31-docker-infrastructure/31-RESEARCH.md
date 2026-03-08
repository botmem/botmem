# Phase 31: Docker & Infrastructure - Research

**Researched:** 2026-03-08
**Domain:** Docker Compose, Makefile, infrastructure orchestration
**Confidence:** HIGH

## Summary

Phase 31 replaces the existing bare-bones `docker-compose.yml` (which has no health checks, uses `latest` tags, includes an unbuildable `api` service, and lacks Ollama) with a proper dev-infrastructure Compose file and a Makefile providing single-command DX. The scope is narrow and well-defined: two files to create/replace (`docker-compose.yml`, `Makefile`), no application code changes.

The existing `docker-compose.yml` at the repo root contains an `api` service that references a non-existent `Dockerfile` and uses `qdrant/qdrant:latest`. It must be replaced entirely. The health endpoint at `GET /api/health` (built in Phase 30) provides the application-level readiness signal, while Docker-level health checks on Redis and Qdrant containers ensure infrastructure is ready before the app starts.

**Primary recommendation:** Replace `docker-compose.yml` with infrastructure-only services (Redis + Qdrant + Ollama profile), pinned versions, health checks on all services. Add a `Makefile` with `make dev` that runs `docker compose up -d` then `pnpm dev`.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| DOCK-01 | Running `docker compose up` starts Redis + Qdrant with health checks; `--profile ollama` adds Ollama | Docker Compose profiles, health check patterns for all three services documented below |
| DOCK-02 | Developer can run `make dev` to start infrastructure + app with a single command | Makefile pattern with `docker compose up -d --wait` then `pnpm dev` |
</phase_requirements>

## Standard Stack

### Core
| Tool | Version | Purpose | Why Standard |
|------|---------|---------|--------------|
| Docker Compose | v2 (bundled with Docker Desktop) | Infrastructure orchestration | Already in use, Compose v2 is the current standard |
| Redis | 7.4-alpine | BullMQ queue backend | Pinned minor version of current stable; alpine for small image |
| Qdrant | v1.13.2 | Vector database | Pinned to known-working version; v1.17 is latest but conservative pin is safer |
| Ollama | 0.6.2 | AI inference (opt-in) | Pinned; fast-moving project, exact version matters for model compat |
| GNU Make | system | Command layer | Universal, zero-dependency, every dev machine has it |

### Why These Versions

- **Redis 7.4-alpine**: The existing compose uses `redis:7-alpine`. Pin to `7.4-alpine` for reproducibility while staying on the 7.x line that BullMQ targets. Redis 8.x exists but changes the licensing model.
- **Qdrant v1.13.2**: The project's production deployment uses Qdrant and this version is well-tested. v1.17.0 is latest but unnecessary for dev infrastructure.
- **Ollama 0.6.2**: Pin a recent stable version. Ollama moves fast (0.17.x exists) but the project uses specific model names that should work across versions. Use a version known to support the project's models.

**NOTE on version pinning:** The exact minor versions should be verified against what the developer currently runs in their local Docker. The key requirement is "not latest" -- any specific tag satisfies DOCK-01 success criteria item 3.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Makefile | Just scripts in package.json | Makefile is more flexible for infra commands, doesn't pollute node scripts |
| Docker Compose profiles | Separate compose files | Profiles are simpler, single file, `--profile` flag is idiomatic |

## Architecture Patterns

### Recommended File Structure
```
(repo root)
├── docker-compose.yml     # Infrastructure services (Redis, Qdrant, Ollama profile)
├── Makefile               # Developer command layer
├── .env.example           # Already exists (Phase 29)
└── apps/api/              # Application (not in compose -- runs via pnpm dev)
```

### Pattern 1: Infrastructure-Only Compose (No App Service)
**What:** Docker Compose defines only infrastructure dependencies (Redis, Qdrant), not the application itself. The app runs natively via `pnpm dev`.
**When to use:** Development environments where the app needs hot-reload and debugger access.
**Why:** The existing compose has an `api` service with `build: .` but no Dockerfile exists. Production Docker is Phase 33. For dev, running the app natively is correct.

### Pattern 2: Docker Compose Profiles for Optional Services
**What:** Ollama is defined with `profiles: ["ollama"]` so it only starts when explicitly requested via `--profile ollama`.
**When to use:** Services that not every developer needs (e.g., remote Ollama users don't need local Ollama).
**Example:**
```yaml
services:
  ollama:
    image: ollama/ollama:0.6.2
    profiles: ["ollama"]
    ports:
      - "11434:11434"
    volumes:
      - ollama-data:/root/.ollama
```

### Pattern 3: Health Checks with `depends_on` Conditions
**What:** Use `depends_on.service.condition: service_healthy` so dependent services wait for health.
**When to use:** When startup order matters (app needs Redis/Qdrant ready).
**Note:** For `make dev`, the `docker compose up -d --wait` flag blocks until all health checks pass, then Makefile proceeds to `pnpm dev`.

### Anti-Patterns to Avoid
- **App in dev compose:** Don't put the NestJS app in docker-compose.yml for dev -- it breaks hot reload and debugging
- **Using `latest` tags:** Breaks reproducibility, DOCK-01 explicitly forbids this
- **Health checks without start_period:** Qdrant takes a few seconds to initialize; without start_period the health check may fail before the service has had time to start
- **Hardcoded ports only in compose:** Keep ports configurable or at least matching .env.example defaults

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Service readiness | Custom polling scripts | `docker compose up --wait` | Built-in, respects health checks |
| Ollama opt-in | Separate compose files | Compose profiles | Single file, standard feature |
| Command aliases | Shell scripts | Makefile | Universal, self-documenting, tab-completable |

## Common Pitfalls

### Pitfall 1: Qdrant Has No curl/wget in Docker Image
**What goes wrong:** `["CMD", "curl", "-f", "http://localhost:6333/healthz"]` fails because curl is not installed in the Qdrant image (deliberately removed for security).
**Why it happens:** Many Docker Compose examples show curl-based health checks but Qdrant's image is minimal.
**How to avoid:** Use bash TCP probe: `["CMD-SHELL", "bash -c 'echo > /dev/tcp/localhost/6333'"]` or use `wget` if available, or simply use the `/readyz` endpoint with a shell redirect. The simplest reliable approach is the `/dev/tcp` bash builtin.
**Alternative:** Use `timeout 1 bash -c 'cat < /dev/null > /dev/tcp/127.0.0.1/6333'` -- this just checks TCP connectivity to port 6333 without needing curl.

### Pitfall 2: Ollama Needs Model Pull After First Start
**What goes wrong:** Ollama container starts but has no models. The app fails embedding/enrichment.
**Why it happens:** Ollama images don't bundle models; they must be pulled after startup.
**How to avoid:** Document this in the Makefile (e.g., `make ollama-pull` target). Or note in comments that models must be pulled. This is expected behavior -- the project uses a remote Ollama by default (`OLLAMA_BASE_URL=http://192.168.10.250:11434`), local Ollama is opt-in.

### Pitfall 3: Port Conflicts with Existing Local Services
**What goes wrong:** Developer already runs Redis/Qdrant locally, ports 6379/6333 conflict.
**Why it happens:** Common in dev environments.
**How to avoid:** Docker Compose port mapping is already in place. Developer can stop local services or change ports in `.env`. Not a compose issue to solve -- just document.

### Pitfall 4: Volume Data Persistence Between Compose Restarts
**What goes wrong:** `docker compose down -v` destroys data volumes, losing Qdrant vectors and Redis state.
**Why it happens:** `-v` flag removes volumes.
**How to avoid:** Use `docker compose down` (without `-v`) by default. The `make clean` target should warn or require confirmation.

## Code Examples

### docker-compose.yml (Complete)
```yaml
services:
  redis:
    image: redis:7.4-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  qdrant:
    image: qdrant/qdrant:v1.13.2
    ports:
      - "6333:6333"
      - "6334:6334"
    volumes:
      - qdrant-data:/qdrant/storage
    healthcheck:
      test: ["CMD-SHELL", "bash -c 'echo > /dev/tcp/localhost/6333'"]
      interval: 5s
      timeout: 3s
      retries: 5
      start_period: 5s

  ollama:
    image: ollama/ollama:0.6.2
    profiles: ["ollama"]
    ports:
      - "11434:11434"
    volumes:
      - ollama-data:/root/.ollama
    healthcheck:
      test: ["CMD-SHELL", "bash -c 'echo > /dev/tcp/localhost/11434'"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 10s

volumes:
  redis-data:
  qdrant-data:
  ollama-data:
```

### Makefile (Complete)
```makefile
.PHONY: dev up down status clean ollama-up

# Start infrastructure + app dev servers
dev: up
	pnpm dev

# Start infrastructure services (Redis + Qdrant)
up:
	docker compose up -d --wait

# Start with Ollama
ollama-up:
	docker compose --profile ollama up -d --wait

# Stop infrastructure
down:
	docker compose down

# Show service status
status:
	docker compose ps

# Remove infrastructure and volumes (destructive)
clean:
	docker compose down -v
```

### Verification Commands
```bash
# Verify health checks pass within 30 seconds
docker compose up -d
# Wait and check
docker compose ps  # All should show "healthy"

# Verify Ollama profile
docker compose --profile ollama up -d
docker compose ps  # Should show redis, qdrant, AND ollama

# Verify make dev
make dev  # Should start infra, wait for healthy, then pnpm dev
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `docker-compose.yml` with version key | Compose v2: no `version` key needed | Docker Compose v2 (2022+) | Remove `version: '3.x'` -- it's ignored/deprecated |
| `depends_on` (order only) | `depends_on.condition: service_healthy` | Compose v2.1+ | Services wait for actual readiness |
| `docker-compose up` | `docker compose up` (no hyphen) | Docker Compose v2 | Plugin syntax, not standalone binary |
| Separate override files | `profiles` for optional services | Compose 1.28+ | Single file, cleaner |

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Manual verification + shell commands |
| Config file | N/A (infrastructure, not application code) |
| Quick run command | `docker compose up -d --wait && docker compose ps` |
| Full suite command | `make dev` (verify infra + app starts) |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DOCK-01a | Redis + Qdrant start with health checks | smoke | `docker compose up -d --wait && docker compose ps \| grep healthy` | N/A |
| DOCK-01b | `--profile ollama` adds Ollama | smoke | `docker compose --profile ollama up -d --wait && docker compose ps \| grep ollama` | N/A |
| DOCK-01c | Pinned versions, not latest | manual-only | Inspect docker-compose.yml for `:latest` absence | N/A |
| DOCK-02 | `make dev` starts infra + app | smoke | `make dev` (manual: verify app responds on :12412) | N/A |

### Sampling Rate
- **Per task commit:** `docker compose config --quiet` (validates compose syntax)
- **Per wave merge:** Full `docker compose up -d --wait && docker compose ps`
- **Phase gate:** `make dev` successfully starts everything

### Wave 0 Gaps
None -- this phase creates infrastructure files, not application code. No test files needed.

## Open Questions

1. **Exact Qdrant version to pin**
   - What we know: v1.17.0 is latest, project works with current Qdrant
   - What's unclear: Which version the developer currently runs locally
   - Recommendation: Use v1.13.2 (conservative) or check `docker inspect` on current running container. Any pinned version satisfies the requirement.

2. **Exact Ollama version to pin**
   - What we know: 0.17.7 is latest, project uses specific models (nomic-embed-text, qwen3:0.6b, qwen3-vl:2b)
   - What's unclear: Model compatibility across Ollama versions
   - Recommendation: Pin to 0.6.2 or whatever version is on the remote Ollama server. Since Ollama is opt-in via profile, the exact version is less critical.

3. **Qdrant health check reliability**
   - What we know: Qdrant image has no curl; bash `/dev/tcp` works but depends on bash being the shell
   - What's unclear: Whether future Qdrant images might remove bash
   - Recommendation: `/dev/tcp` approach is the community standard workaround. If it breaks, Qdrant will likely have added a built-in healthcheck by then (tracked in qdrant/qdrant#4250).

## Sources

### Primary (HIGH confidence)
- Existing `docker-compose.yml` in repo root -- current state of infrastructure config
- Existing `health.controller.ts` -- Phase 30 health endpoint implementation
- `.env.example` -- all environment variable defaults
- `config.service.ts` -- default URLs for Redis (localhost:6379), Qdrant (localhost:6333)

### Secondary (MEDIUM confidence)
- [Docker Hub redis](https://hub.docker.com/_/redis) -- Redis 7.4-alpine/8.x availability
- [Docker Hub qdrant/qdrant](https://hub.docker.com/r/qdrant/qdrant) -- Qdrant image tags
- [Docker Hub ollama/ollama](https://hub.docker.com/r/ollama/ollama) -- Ollama image tags
- [Qdrant GitHub issue #4250](https://github.com/qdrant/qdrant/issues/4250) -- No built-in healthcheck, /dev/tcp workaround
- [Qdrant monitoring docs](https://qdrant.tech/documentation/guides/monitoring/) -- /healthz, /livez, /readyz endpoints

### Tertiary (LOW confidence)
- Ollama version 0.6.2 pin -- based on web search, should be verified against actual Docker Hub tags
- Redis 8.x licensing change -- mentioned in search results, not verified

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Docker Compose, Redis, Qdrant are well-known; version pinning is straightforward
- Architecture: HIGH - infrastructure-only compose is the established pattern for this project
- Pitfalls: HIGH - Qdrant no-curl issue is well-documented; other pitfalls are standard Docker knowledge

**Research date:** 2026-03-08
**Valid until:** 2026-04-08 (stable domain, versions may need refresh)

# Immich Monorepo Reference Analysis

Reference: https://github.com/immich-app/immich (v2.5.6)

## Key Patterns to Adopt

### 1. Package Management (pnpm 10)

Immich uses pnpm 10 with modern workspace features:

```yaml
# pnpm-workspace.yaml
packages:
  - cli
  - docs
  - e2e
  - server
  - web
  - plugins
  - open-api/typescript-sdk

# Key pnpm 10 features used:
ignoredBuiltDependencies: [...]  # Skip unnecessary native builds
onlyBuiltDependencies: [sharp, bcrypt, '@tailwindcss/oxide']  # Whitelist native deps
overrides: { sharp: ^0.34.5 }  # Force versions
packageExtensions: { ... }  # Fix broken peer deps
preferWorkspacePackages: true
injectWorkspacePackages: true
shamefullyHoist: false  # Strict isolation
verifyDepsBeforeRun: install  # Auto-install if lockfile changed
```

**Key takeaway:** `verifyDepsBeforeRun: install` eliminates stale node_modules issues.

### 2. Root package.json (Minimal)

Immich's root package.json is **extremely minimal** — no scripts, no deps, just metadata:

```json
{
  "name": "immich-monorepo",
  "version": "2.5.6",
  "description": "Monorepo for Immich",
  "private": true,
  "packageManager": "pnpm@10.30.3+sha512.c961d1..."
}
```

**Key takeaway:** All scripts live in individual packages or the Makefile. No root-level dev script.

### 3. Makefile as Dev Orchestrator (NOT Turbo)

Immich does NOT use Turborepo. They use Make for task orchestration:

```makefile
dev:
	@trap 'make dev-down' EXIT; COMPOSE_BAKE=true docker compose -f ./docker/docker-compose.dev.yml up --remove-orphans

build-%: install-%
	pnpm --filter $(call map-package,$*) run build

test-all:
	pnpm -r --filter '!documentation' run "/^test/"

check-all:
	pnpm -r --filter '!documentation' run "/^(check|check:svelte|check:typescript)$/"
```

**Key takeaway:** `make dev` is the single command to start everything. Docker Compose handles the actual orchestration.

### 4. Docker Compose Dev (All-in-Docker)

Immich runs EVERYTHING in Docker for dev — including the app itself:

- **immich-init**: Runs `pnpm install`, waits for completion via health check
- **immich-server**: NestJS with `nest start --watch` (file watching inside container)
- **immich-web**: Svelte dev server
- **immich-machine-learning**: Python ML service
- **redis**: Valkey (Redis fork), pinned with digest hash
- **database**: PostgreSQL with health check

Key patterns:
- `extends: immich-app-base` for shared volume mounts
- Named volumes for node_modules (avoids host/container conflicts)
- `depends_on` with `condition: service_healthy` for startup ordering
- Health checks on infrastructure services (redis-cli ping, pg_isready)
- `env_file: .env` for configuration
- Pinned image versions with SHA digests

### 5. NestJS Server Config

```json
{
  "scripts": {
    "start:dev": "nest start --watch --",
    "start:debug": "nest start --debug 0.0.0.0:9230 --watch --",
    "check": "tsc --noEmit",
    "check:code": "pnpm run format && pnpm run lint && pnpm run check",
    "test": "vitest --config test/vitest.config.mjs",
    "lint": "eslint \"src/**/*.ts\" \"test/**/*.ts\" --max-warnings 0"
  }
}
```

**Key takeaway:** Uses `nest start --watch` (SWC-based, fast restarts) — NOT nodemon.

### 6. Quality Gates

Each package has its own `check:code` script that runs format + lint + typecheck:
- `format`: prettier --check
- `lint`: eslint with --max-warnings 0 (zero tolerance)
- `check`: tsc --noEmit

The Makefile `check-all` runs these across all packages.

## Patterns to Adapt (Not Copy Directly)

1. **All-in-Docker dev**: Immich does this because they have a Python ML service. Botmem's Ollama is external — we should use Docker for infra services only, run Node locally.
2. **No Turborepo**: Immich has fewer packages and different needs. Botmem benefits from Turbo's caching + dependency-aware task running.
3. **pnpm 10**: Worth evaluating, but the research suggests staying on pnpm 9 with catalogs to avoid migration risk.
4. **Makefile**: Good pattern for dev commands. Could coexist with Turbo — Make for developer-facing commands, Turbo for build orchestration.

## Directly Applicable Patterns

| Pattern | Immich Approach | Botmem Adaptation |
|---------|----------------|-------------------|
| Dev startup | `make dev` → Docker Compose | `make dev` → Docker infra + turbo watch |
| Dep verification | `verifyDepsBeforeRun: install` | Add to pnpm-workspace.yaml |
| Image pinning | SHA digest pins on Redis, Postgres | Pin Redis + Qdrant images |
| Health checks | redis-cli ping, pg_isready | Add to all infra services |
| Quality scripts | `check:code` = format + lint + check | Add to each package |
| NestJS watch | `nest start --watch` (SWC) | Replace nodemon with this |
| Zero root scripts | All in packages or Makefile | Move dev orchestration to Makefile |
| Named volumes | node_modules in Docker volumes | For Docker-based services only |
| env_file | `env_file: .env` + `example.env` | Create .env.example |

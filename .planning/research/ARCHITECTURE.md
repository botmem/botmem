# Architecture Patterns

**Domain:** Monorepo restructuring and developer experience for a NestJS + React pnpm monorepo
**Researched:** 2026-03-08
**Confidence:** HIGH (based on direct codebase analysis + current Turborepo/pnpm documentation)

---

## Current State Analysis

### What Exists

```
botmem/
  apps/
    api/         NestJS 11 (CommonJS, nest build, nodemon, SWC)
    web/         React 19 + Vite 6 (ESM, embedded in API via Vite middleware mode)
  packages/
    shared/          Types + utilities (ESM, tsc build)
    connector-sdk/   BaseConnector abstract (ESM, tsc build)
    cli/             CLI tool (ESM, tsc build)
    connectors/
      gmail/         (ESM, depends on connector-sdk)
      slack/         (ESM, depends on connector-sdk)
      whatsapp/      (ESM, depends on connector-sdk)
      imessage/      (ESM, depends on connector-sdk)
      photos-immich/ (ESM, depends on connector-sdk)
      locations/     (ESM, depends on connector-sdk)
```

### Identified Problems

1. **CJS/ESM split**: API is CommonJS (`module: "commonjs"`, `moduleResolution: "node"`), every other package is ESM (`"type": "module"`, `module: "ESNext"`, `moduleResolution: "bundler"` via base). This works but creates friction with ESM-only dependencies.
2. **Mixed type resolution**: Library packages point `"types"` at `./src/index.ts` (live source) but `"main"` at `./dist/index.js` (built). Types come from source, runtime from dist -- version skew if you forget to rebuild.
3. **Nodemon watches dist of every package**: The API's `nodemon.json` manually lists every connector's `dist/` directory. Adding a connector requires editing this file.
4. **Root dev script is a hack**: `pnpm dev` first runs `turbo build` on all connectors/SDK/CLI, then runs `turbo dev` only for shared + API. First `pnpm dev` is slow, and connector changes require manual rebuild.
5. **No health checks in Docker Compose**: Services start without readiness checks, causing race conditions on cold start.
6. **Web embedded in API**: Vite runs in middleware mode inside the API process in dev. Clever for single-port but makes the web app not independently runnable.
7. **No Turborepo `watch` usage**: Project uses `nodemon` + `tsc --watch` instead of `turbo watch`, missing dependency-aware rebuilds.
8. **tsconfig.base.json inconsistency**: Base uses `moduleResolution: "bundler"` but API overrides to `moduleResolution: "node"` and `module: "commonjs"`. This is technically correct (NestJS needs CJS) but undocumented.
9. **Web tsconfig uses path aliases for workspace packages**: `@botmem/shared` is aliased to `../../packages/shared/src`, bypassing pnpm resolution entirely.
10. **No Docker profile separation**: Single docker-compose.yml with a half-configured API service (comment says "Dockerfile is added in a later phase").
11. **Qdrant uses `:latest` tag**: Breaking changes can silently land.
12. **API has Vite/Tailwind dev deps**: `@tailwindcss/vite` and `@vitejs/plugin-react` are devDependencies of the API because Vite middleware mode runs inside the API process. These belong in the web package.

---

## Recommended Architecture

### Package Dependency Graph

```
                    @botmem/shared
                   /       |        \
                  /        |         \
    @botmem/connector-sdk  |    @botmem/web
           |               |         |
     @botmem/connector-*   |    (depends on shared only)
           |               |
            \             /
             @botmem/api
                 |
            @botmem/cli (standalone, HTTP client only -- no internal deps)
```

**Dependency rules (enforce these):**

| Package | May Depend On | Must NOT Depend On |
|---------|--------------|-------------------|
| `@botmem/shared` | Nothing internal | Anything internal |
| `@botmem/connector-sdk` | `shared` | api, web, cli, connectors |
| `@botmem/connector-*` | `connector-sdk`, `shared` | api, web, cli, other connectors |
| `@botmem/web` | `shared` | api, connectors, cli |
| `@botmem/api` | `shared`, `connector-sdk`, all connectors, `web` | cli |
| `@botmem/cli` | Nothing internal | Everything (HTTP client only) |

**Internal package resolution**: Keep `workspace:*` protocol (already in place). Do NOT use `workspace:^` -- these are private packages that will never be published, so exact workspace resolution is correct.

**Confidence: HIGH** -- this matches the existing dependency graph, just made explicit and enforceable.

### Build Order (Turborepo DAG)

The `^build` dependency in turbo.json handles this correctly. Actual build order:

```
Layer 0: @botmem/shared, @botmem/cli (no internal deps)
Layer 1: @botmem/connector-sdk (depends on shared)
         @botmem/web (depends on shared)
Layer 2: @botmem/connector-* (depends on connector-sdk)
Layer 3: @botmem/api (depends on everything)
```

This is correct and requires no changes to the DAG. The issue is the dev workflow that bypasses it.

---

## Component Boundaries

| Component | Responsibility | Communicates With | Module System |
|-----------|---------------|-------------------|---------------|
| `@botmem/shared` | Types, constants, utilities (cn, format helpers) | Imported by all internal packages | ESM |
| `@botmem/connector-sdk` | BaseConnector, ConnectorRegistry, event types | Imported by connectors + API | ESM |
| `@botmem/connector-*` | Data source adapters (auth + sync) | Imported by API only | ESM |
| `@botmem/api` | REST API, WebSocket, BullMQ processors, DB, serves web | Consumes all packages, serves frontend | CJS (NestJS requirement) |
| `@botmem/web` | React SPA, Vite-built | Talks to API via HTTP/WS at runtime | ESM |
| `@botmem/cli` | CLI binary for humans and AI agents | Talks to API via HTTP | ESM |

---

## Detailed Architecture Recommendations

### 1. TypeScript: Conditional Exports with Live Types (No Project References)

**Decision: Use conditional `exports` field with types pointing to source. Do NOT adopt TypeScript project references.**

**Why NOT project references:**
- NestJS uses `nest build` with its own SWC compiler pipeline. Project references require `tsc -b` composite mode, which conflicts with NestJS's build system.
- Vite (web) does not emit JS from tsc -- it only type-checks. Path aliases resolved by Vite's `resolve.alias` are the standard pattern.
- Library packages are simple enough that `tsc` builds them fine. Project references add complexity for minimal gain in a <15 package monorepo.
- The TypeScript team recommends project references for large monorepos (50+ packages). This project has ~12 packages.

**What to do: Formalize the "live types" pattern.**

All library packages (`shared`, `connector-sdk`, `connectors/*`, `cli`) should use this package.json structure:

```jsonc
{
  "name": "@botmem/shared",
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch --preserveWatchOutput"
  }
}
```

**Remove** the legacy `"main"` and `"types"` top-level fields. The `exports` field supersedes them.

The `"types"` condition points to source (live types -- changes propagate instantly to IDE without rebuilding). The `"import"` and `"require"` conditions point to dist (built output used at runtime).

**For the web app**: Keep the `@/` Vite alias for intra-app imports. **Remove** the `@botmem/shared` path alias from `tsconfig.json` -- pnpm workspace resolution + the `exports` field handles it. Also remove `../../packages/shared/src` from the `include` array.

**Confidence: HIGH** -- this is the approach recommended by Turborepo's official docs and Colin McDonnell's "live types" essay. Already partially in place.

**Impact on existing code: LOW** -- package.json exports field changes, remove one tsconfig path alias. No runtime behavior changes.

### 2. Turbo Watch for Dev Mode (Replace Nodemon)

**Current problem:** Root `pnpm dev` does a full `turbo build` of all connectors first, then starts the API with nodemon watching dist directories. Slow and fragile.

**New turbo.json:**

```jsonc
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"],
      "inputs": ["src/**", "tsconfig.json", "package.json"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "dev:api": {
      "dependsOn": ["^build"],
      "cache": false,
      "persistent": true,
      "interruptible": true
    },
    "test": {
      "dependsOn": ["^build"],
      "inputs": ["src/**", "__tests__/**", "vitest.config.*"]
    },
    "test:coverage": {
      "dependsOn": ["^build"],
      "inputs": ["src/**", "__tests__/**", "vitest.config.*"],
      "outputs": ["coverage/**"]
    },
    "lint": {}
  }
}
```

**Key: The API uses `interruptible: true`.** This means `turbo watch` will kill and restart the API process when any dependency rebuilds. No more nodemon.

**Package dev scripts:**

| Package | `dev` Script | Strategy |
|---------|-------------|----------|
| `@botmem/shared` | `tsc --watch --preserveWatchOutput` | Persistent, rebuilds dist on change |
| `@botmem/connector-sdk` | `tsc --watch --preserveWatchOutput` | Persistent, rebuilds dist on change |
| `@botmem/connector-*` | `tsc --watch --preserveWatchOutput` | Persistent, rebuilds dist on change |
| `@botmem/api` | `nest build && node dist/main.js` | Interruptible, restarted by turbo watch |
| `@botmem/web` | `echo "Embedded in API"` | No-op (Vite middleware mode) |
| `@botmem/cli` | `tsc --watch --preserveWatchOutput` | Persistent |

**Root dev command:**

```jsonc
{
  "scripts": {
    "dev": "turbo watch dev dev:api --concurrency 20"
  }
}
```

This runs all `dev` tasks (tsc --watch for libraries) and the `dev:api` task (nest build + run, restartable). When a library's tsc --watch emits new dist files, turbo watch detects the change, sees that `@botmem/api` depends on that library, and restarts the API.

**Delete:** `apps/api/nodemon.json` (no longer needed).

**Impact on existing code: MEDIUM** -- replace nodemon with turbo watch, update dev scripts in all packages, delete nodemon.json. The `nest start --watch` alternative is simpler but does NOT detect changes in workspace dependency dist directories -- only turbo watch handles cross-package change propagation.

### 3. Docker Compose: Profiles with Health Checks

**Replace** docker-compose.yml entirely:

```yaml
services:
  redis:
    image: redis:7.4-alpine
    ports:
      - "${REDIS_PORT:-6379}:6379"
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  qdrant:
    image: qdrant/qdrant:v1.12.6
    ports:
      - "${QDRANT_PORT:-6333}:6333"
      - "${QDRANT_GRPC_PORT:-6334}:6334"
    volumes:
      - qdrant-data:/qdrant/storage
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:6333/healthz"]
      interval: 10s
      timeout: 5s
      retries: 5

  # Optional: local Ollama for developers without a GPU server
  ollama:
    image: ollama/ollama:latest
    profiles: ["ollama"]
    ports:
      - "${OLLAMA_PORT:-11434}:11434"
    volumes:
      - ollama-data:/root/.ollama
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:11434/api/tags"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 30s

  # Production: containerized API
  api:
    build: .
    profiles: ["prod"]
    ports:
      - "${PORT:-12412}:12412"
    environment:
      - NODE_ENV=production
      - DB_PATH=/data/botmem.db
      - REDIS_URL=redis://redis:6379
      - QDRANT_URL=http://qdrant:6333
      - OLLAMA_BASE_URL=${OLLAMA_BASE_URL:-http://host.docker.internal:11434}
    volumes:
      - botmem-data:/data
    depends_on:
      redis:
        condition: service_healthy
      qdrant:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:12412/api/version"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 30s

volumes:
  redis-data:
  qdrant-data:
  ollama-data:
  botmem-data:
```

**Usage patterns:**

```bash
# Dev (infrastructure only, API runs natively via pnpm dev)
docker compose up -d

# Dev with local Ollama (no remote GPU server)
docker compose --profile ollama up -d

# Production (full stack in Docker)
docker compose --profile prod up -d
```

**Key decisions:**
- **Ollama is a profile, not default.** The project uses a remote Ollama at 192.168.10.250. Local Ollama is opt-in for developers who need it.
- **API is prod-only in Docker.** In dev, the API runs natively for fast iteration.
- **Pin Qdrant version.** `:latest` risks silent breaking changes.
- **Health checks on everything.** Dependent services wait via `condition: service_healthy`.
- **Configurable ports.** Environment variables prevent conflicts.

**Impact on existing code: LOW** -- replaces docker-compose.yml, no code changes needed.

### 4. Shared Package Build Strategy: Plain tsc, No Bundler

**Decision: Keep `tsc` for all library packages. Do NOT introduce tsup/unbuild.**

**Rationale:**
- All library packages are private and consumed only within the monorepo
- No need for dual CJS/ESM output bundles (API uses dynamic import or Node 22's require-esm support)
- tsup/unbuild add dependency and config surface for zero benefit
- `tsc --watch` is fast enough for these small packages

**Exception:** If `@botmem/cli` is later published for global install (`npm install -g @botmem/cli`), use tsup for that single package to produce a clean distributable. Not needed now.

**Confidence: HIGH** -- bundlers for internal-only packages is over-engineering.

### 5. CJS/ESM Bridge: Keep API as CommonJS

**Decision: Do NOT migrate the API to ESM.** NestJS does not officially support ESM (as of NestJS 11, issue #13319 is still open). The effort is disproportionate to the benefit.

**How it works today:** Library packages are `"type": "module"` and output ESM `.js` files. The NestJS API is CJS (no `"type": "module"`). `nest build` compiles API source to CJS. At runtime, Node resolves workspace deps via pnpm symlinks to their dist output.

**This already works** because:
1. NestJS's `nest build` (via SWC) transpiles import statements to require() calls
2. Node can require() files from ESM packages when the specific file doesn't use top-level await or other ESM-only features
3. The library packages output simple declaration + export patterns that are CJS-compatible

**If this breaks in the future:** Node 22+ has `--experimental-require-module` that enables full require() of ESM modules. Add to the API's start script if needed.

**Confidence: MEDIUM** -- this is the area with the most risk. Test thoroughly after any tsconfig or exports field changes.

### 6. Vite Middleware Mode: Keep, Add Standalone Escape Hatch

**Current:** API imports Vite in middleware mode, serves frontend from port 12412 in dev. Good because:
- Single port (no CORS)
- HMR through the same connection
- Simpler than two processes

**Add standalone option for frontend-only work:**

```jsonc
// apps/web/package.json
{
  "scripts": {
    "dev": "echo 'Web runs embedded in API via Vite middleware. Use pnpm dev from root.'",
    "dev:standalone": "vite --port 5173",
    "build": "tsc -b && vite build"
  }
}
```

**Move Vite-related dev deps from API to web:** The `@tailwindcss/vite` and `@vitejs/plugin-react` packages are currently devDependencies of the API. They should be in the web package where they logically belong. The API can resolve them at runtime because pnpm hoists them.

Actually, since the API dynamically imports Vite and uses the web package's `vite.config.ts`, the Vite plugins need to be resolvable from the web package root, which they already are (they are devDeps of web too). The duplicates in the API can be removed.

**Impact on existing code: LOW** -- add a script, remove duplicate dev deps from API.

### 7. Build Gates (Test Before Build in CI)

**Decision: Do NOT make `build` depend on `test` globally.** This would slow down dev iteration. Instead, create a CI-specific pipeline task.

```jsonc
// turbo.json
{
  "tasks": {
    "ci": {
      "dependsOn": ["lint", "test", "build"]
    }
  }
}
```

```bash
# CI pipeline
pnpm turbo ci

# Dev (no test gate)
pnpm turbo build
```

**Impact: NONE** on dev workflow. CI gets the gate.

---

## Data Flow

### Dev Mode Data Flow (After Restructuring)

```
pnpm dev
  |
  turbo watch dev dev:api (concurrency 20)
  |
  +-- @botmem/shared:        tsc --watch (persistent, Layer 0)
  +-- @botmem/cli:           tsc --watch (persistent, Layer 0)
  +-- @botmem/connector-sdk: tsc --watch (persistent, Layer 1, waits for shared)
  +-- @botmem/connector-*:   tsc --watch (persistent, Layer 2, waits for sdk)
  +-- @botmem/api:           nest build && node dist/main.js (interruptible, Layer 3)
        |
        +-- Vite middleware mode (serves web from apps/web/src)
        +-- Connects to: Redis (docker), Qdrant (docker), Ollama (remote)
        +-- Serves: http://localhost:12412 (API + Web + HMR)
```

**When a connector file changes:**
1. `tsc --watch` in that connector rebuilds its `dist/`
2. Turbo watch detects the dependency output changed
3. API task (interruptible) is killed and restarted: `nest build && node dist/main.js`
4. API comes back up on the same port

**When a shared type changes:**
1. `tsc --watch` in shared rebuilds its `dist/`
2. Turbo watch sees shared changed
3. SDK and connectors rebuild (their tsc --watch picks up the new shared dist)
4. API restarts after its deps finish rebuilding
5. Vite HMR picks up type changes for the web app instantly (live types from source)

### Production Build Flow

```
pnpm build
  |
  turbo build
  |
  Layer 0: shared (tsc), cli (tsc)        -> dist/
  Layer 1: connector-sdk (tsc), web (vite) -> dist/
  Layer 2: connector-* (tsc)               -> dist/
  Layer 3: api (nest build)                -> dist/
  |
  Result: apps/api/dist/ = full API
          apps/web/dist/ = static web assets (served by API in prod via @nestjs/serve-static)
```

---

## Patterns to Follow

### Pattern 1: Conditional Exports for Internal Packages

**What:** Use the `exports` field with `types` condition pointing to source.

**When:** Every internal library package.

**Example:**
```jsonc
{
  "name": "@botmem/connector-gmail",
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./dist/index.js"
    }
  }
}
```

Remove legacy `"main"` and `"types"` top-level fields. The `exports` field supersedes them and is the modern standard.

### Pattern 2: Turbo Task Inputs for Cache Efficiency

**What:** Specify which files affect each task so Turborepo can skip unnecessary work.

**When:** All cacheable tasks (build, test, lint).

**Example:**
```jsonc
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"],
      "inputs": ["src/**", "tsconfig.json", "package.json"]
    },
    "test": {
      "dependsOn": ["^build"],
      "inputs": ["src/**", "__tests__/**", "vitest.config.*"]
    }
  }
}
```

This prevents cache invalidation from irrelevant file changes (README edits, etc.).

### Pattern 3: Consistent Package Layout

**What:** Every package follows the same directory convention.

```
packages/<name>/
  src/
    index.ts          # Public API barrel
    __tests__/        # Tests adjacent to source
  dist/               # Build output (gitignored)
  package.json
  tsconfig.json       # Extends ../../tsconfig.base.json (or ../../../tsconfig.base.json for connectors)
```

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Watching dist/ Directories with Nodemon

**What:** API's nodemon.json manually lists every connector's dist/ path.
**Why bad:** Fragile, does not scale, misses transitive changes, requires manual maintenance when adding packages.
**Instead:** Use `turbo watch` with `interruptible: true` for the API. Turborepo understands the dependency graph.

### Anti-Pattern 2: Pre-build Step in Dev Command

**What:** Root `pnpm dev` runs `turbo build --filter=...` before starting dev servers.
**Why bad:** Slow cold start (~15s before any server starts), defeats watch mode, confusing for new developers.
**Instead:** `turbo watch` starts all watch processes in parallel. Libraries build themselves via `tsc --watch`.

### Anti-Pattern 3: tsconfig Path Aliases for Workspace Packages

**What:** Web tsconfig aliases `@botmem/shared` to `../../packages/shared/src`.
**Why bad:** Bypasses pnpm module resolution, creates dev/prod resolution mismatch, requires manual path maintenance.
**Instead:** Let pnpm workspace + `exports` field handle it. Types resolve from source via `"types"` condition in exports.

### Anti-Pattern 4: `:latest` Tags for Infrastructure Images

**What:** `qdrant/qdrant:latest` in docker-compose.yml.
**Why bad:** Silent breaking changes. Qdrant storage format changes could corrupt data.
**Instead:** Pin versions: `qdrant/qdrant:v1.12.6`, `redis:7.4-alpine`.

### Anti-Pattern 5: Duplicate Dev Dependencies Across Apps

**What:** `@tailwindcss/vite`, `@vitejs/plugin-react` in both API and web devDeps.
**Why bad:** Version drift, confusing ownership, wasted install time.
**Instead:** Vite plugins belong in web only. API dynamically imports Vite using web's config.

---

## Migration Order (Incremental, Each Step Produces a Working System)

### Step 1: Fix Package Exports (LOW risk, HIGH value)
Update all library package.json files to use proper `exports` field. Remove legacy `main`/`types` top-level fields.

**Packages affected:** shared, connector-sdk, all 6 connectors, cli (9 packages)
**Verify:** `pnpm build && pnpm test` passes. IDE still resolves types.

### Step 2: Update turbo.json (LOW risk, MEDIUM value)
Add `inputs` to build/test tasks. Add `dev:api` task with `interruptible: true`. Add `ci` task.

**Files affected:** turbo.json only
**Verify:** `pnpm build` works, cache hits improve.

### Step 3: Replace Nodemon with Turbo Watch (MEDIUM risk, HIGH value)
Delete nodemon.json. Update API dev script to `nest build && node dist/main.js`. Update all library dev scripts to `tsc --watch --preserveWatchOutput`. Update root dev script.

**Files affected:** apps/api/nodemon.json (delete), apps/api/package.json, all library package.json, root package.json
**Verify:** `pnpm dev` starts all services. Change a connector file -- API restarts automatically.

### Step 4: Remove Web tsconfig Path Alias (LOW risk, LOW value)
Remove `@botmem/shared` path alias and shared/src include from web tsconfig. Verify pnpm workspace resolution handles it.

**Files affected:** apps/web/tsconfig.json
**Verify:** `pnpm dev` -- web types still resolve, HMR works, no red squiggles in IDE.

### Step 5: Docker Compose Overhaul (LOW risk, HIGH value)
Replace docker-compose.yml with profile-based version. Add health checks, pin versions, add Ollama profile.

**Files affected:** docker-compose.yml
**Verify:** `docker compose up -d` starts Redis + Qdrant. `docker compose ps` shows healthy status. `docker compose --profile ollama up -d` adds Ollama.

### Step 6: Clean Up Duplicate Dependencies (LOW risk, LOW value)
Remove Vite-related devDeps from API package.json.

**Files affected:** apps/api/package.json
**Verify:** `pnpm dev` -- Vite middleware mode still works (resolves plugins from web).

### Step 7: Standardize tsconfig (MEDIUM risk, MEDIUM value)
Ensure all library tsconfigs consistently extend base. Document the intentional CJS override in API's tsconfig. Add comments explaining the ESM/CJS boundary.

**Files affected:** All tsconfig.json files (minor changes)
**Verify:** `pnpm build` passes with no type errors.

**Total estimated effort:** 4-8 hours for all 7 steps. Steps 1-2 can be done in a single session. Steps 3-5 are the core improvements.

---

## Scalability Considerations

| Concern | Current (12 packages) | At 25 packages | At 50+ packages |
|---------|----------------------|-----------------|-----------------|
| Build time | ~15s cold, <1s cached | ~30s cold, turbo cache keeps warm | Consider remote cache |
| Watch mode | All tsc --watch feasible | Still fine | Need selective watching (`--filter`) |
| Docker Compose | 3-4 services | Fine | Split into override files |
| TypeScript checking | tsc fast | Consider `--incremental` | Consider project references |
| CI | turbo build/test | Add remote cache (Vercel) | Required: remote cache + affected testing |

---

## Sources

- [Turborepo: Structuring a Repository](https://turborepo.dev/docs/crafting-your-repository/structuring-a-repository) -- Official structure guidance, HIGH confidence
- [Turborepo: Watch Reference](https://turborepo.dev/docs/reference/watch) -- turbo watch docs incl. interruptible/persistent, HIGH confidence
- [Turborepo: Developing Applications](https://turborepo.dev/docs/crafting-your-repository/developing-applications) -- Dev server patterns, HIGH confidence
- [Live Types in a TypeScript Monorepo (Colin McDonnell)](https://colinhacks.com/essays/live-types-typescript-monorepo) -- Live types pattern rationale, HIGH confidence
- [NestJS ESM Support Issue #13319](https://github.com/nestjs/nest/issues/13319) -- NestJS remains CJS, HIGH confidence
- [Nx Blog: TypeScript Project References](https://nx.dev/blog/typescript-project-references) -- When project refs help vs hurt, MEDIUM confidence
- [Nhost: How We Configured pnpm and Turborepo](https://nhost.io/blog/how-we-configured-pnpm-and-turborepo-for-our-monorepo) -- Real-world patterns, MEDIUM confidence
- [Docker Compose Profiles (freeCodeCamp)](https://www.freecodecamp.org/news/how-to-use-docker-compose-for-production-workloads/) -- Profile patterns, MEDIUM confidence
- [Ollama Health Check Issue #1378](https://github.com/ollama/ollama/issues/1378) -- `/api/tags` health endpoint, HIGH confidence
- [pnpm Working with TypeScript](https://pnpm.io/typescript) -- pnpm's official TypeScript guidance, HIGH confidence

# Domain Pitfalls

**Domain:** Monorepo restructuring and developer experience for existing pnpm + Turborepo + NestJS + React project
**Researched:** 2026-03-08
**Overall confidence:** HIGH (based on direct codebase analysis of turbo.json, nodemon.json, tsconfig files, package.json files, docker-compose.yml, and established ecosystem patterns)

---

## Critical Pitfalls

Mistakes that cause multi-day debugging sessions, broken dev workflows, or require reverting the restructuring.

### Pitfall 1: ESM/CJS Module System Split Causes Silent Runtime Failures

**What goes wrong:** The API (`apps/api`) compiles to CommonJS (`"module": "commonjs"` in `apps/api/tsconfig.json`) while every other package in the monorepo is ESM (`"type": "module"` in their package.json, base tsconfig uses `"module": "ESNext"`). This currently works because all packages export `"types": "./src/index.ts"` (pointing at source, not compiled output), so TypeScript resolves types directly from source during development. Any restructuring that makes the build "proper" -- like switching `types` to `"./dist/index.d.ts"` or changing how modules are resolved -- will surface the CJS-importing-ESM incompatibility as runtime `ERR_REQUIRE_ESM` errors.

**Why it happens:** NestJS historically required CommonJS. The project started CJS for the API, added ESM packages over time, and papered over the mismatch with the `types: "./src/index.ts"` workaround.

**Consequences:** After restructuring, `nest build && node dist/main.js` throws `ERR_REQUIRE_ESM` or `Cannot find module` errors. TypeScript compiles successfully (it resolves source types), but Node.js crashes at runtime (it resolves compiled output). This failure mode is maddening because "the build succeeds but the app does not start."

**Severity:** BLOCKING -- the single most dangerous pitfall in this restructuring. Every other change touches this boundary.

**Detection:**
- `apps/api/tsconfig.json` has `"module": "commonjs"` while packages have `"type": "module"` -- the mismatch is already present
- Run `node dist/main.js` from `apps/api` after a clean build (not via nodemon) -- if it requires any workspace ESM package, it will crash
- Search for `require()` calls in API source that import workspace packages

**Prevention:**
- Decide ESM-everywhere or CJS-everywhere BEFORE touching anything else. Recommendation: migrate API to ESM. NestJS 11 supports it. SWC compiler handles it. This aligns with all other packages.
- Alternative: keep API as CJS and configure packages to dual-emit (CJS + ESM) using `tsup`. More complex but avoids touching NestJS internals.
- Test with a clean `rm -rf dist && nest build && node dist/main.js` after every tsconfig change.
- NEVER change the `types` field in package.json exports from `./src/index.ts` to `./dist/index.d.ts` without first resolving the module format mismatch.

**Phase this should be resolved in:** Phase 1 (foundation), before any other build configuration changes.

---

### Pitfall 2: Nodemon Watching 8+ dist/ Directories Creates Restart Storms and Port Conflicts

**What goes wrong:** The current `apps/api/nodemon.json` watches the `src` directory plus 7 package `dist/` directories (shared, connector-sdk, gmail, slack, whatsapp, imessage, photos-immich, locations). When `turbo dev` runs `tsc --watch` in each package, any source change propagates through the dependency chain: shared rebuilds -> connector-sdk rebuilds -> each connector rebuilds. Each `dist/` write triggers nodemon, which runs `nest build && node dist/main.js`. A single change to `@botmem/shared` can cause 3-8 API restarts in rapid succession. The 1-second delay in nodemon config is insufficient because `tsc --watch` emits files asynchronously across packages.

**Why it happens:** Nodemon has no concept of "wait for the full dependency chain to settle." It fires on each individual file change event. Each restart kills the previous `node` process and starts a new one. If the kill signal does not arrive before the new process tries to bind port 12412, both processes fight for the port.

**Consequences:** Multiple `node dist/main.js` processes compete for port 12412. The `detect-port` package (already in API dependencies) silently picks a different port, causing confusion. Developer sees "address already in use" errors, random crashes, or the API silently serving on the wrong port. This is exactly the port conflict issue described in the milestone context.

**Severity:** BLOCKING -- this is the primary bug the milestone was created to fix.

**Detection:**
- `ps aux | grep "node dist/main"` after saving a file in a shared package -- multiple processes means the storm is happening
- "EADDRINUSE" or "address already in use" errors in terminal
- API stops responding after editing code in a workspace package

**Prevention:**
- Replace nodemon + `nest build` with a single-process watch solution. Options:
  1. `nest start --watch` with SWC compiler (fast incremental rebuilds, single process, NestJS manages restarts)
  2. `tsc --build --watch` with TypeScript project references (single watcher that understands dependency order)
  3. Use `tsx --watch` or `ts-node --esm --watch` for direct source execution during dev (no compilation step)
- The key insight: during development, the API should read workspace package SOURCE directly (via the existing `types: "./src/index.ts"` pattern and TypeScript path aliases), not their compiled `dist/` output. This eliminates the need to watch dist directories entirely.
- If nodemon must be kept, increase delay to 3000ms and watch only `src`, not package dist directories.

**Phase this should be resolved in:** Phase 1 -- this is the primary DX pain point.

---

### Pitfall 3: Turborepo Cache Poisoning from Undeclared Inputs

**What goes wrong:** The current `turbo.json` defines `build` with `outputs: ["dist/**"]` and `dependsOn: ["^build"]`. Turbo's cache is content-addressed by file hashes. Any file that affects build output but is not tracked as an input silently poisons the cache:

1. `nest-cli.json` in `apps/api` controls the NestJS build (e.g., `deleteOutDir`, compiler options). Changes to it do not invalidate the Turbo cache because it is not in the default input set.
2. Environment variables not declared in `env` or `globalEnv` -- if any build step reads env vars, the cache ignores them.
3. `.env` files are not in Turbo's input hash by default. If build-time env substitution is added later, cache serves stale builds.

**Why it happens:** Turbo caches aggressively by default. Developers rarely notice because cache misses (from source changes) feel normal. The problem appears as a cache HIT that serves old output after a config-only change.

**Consequences:** `turbo build` succeeds but uses stale dist output. Tests pass locally but fail in CI (different cache state). Production builds contain old code from cached packages. Debugging takes hours because the build "succeeded."

**Severity:** BLOCKING when it happens, but intermittent -- the worst kind of bug.

**Detection:**
- Build behaves differently with `--force` vs without
- `turbo build --dry-run` shows cache HIT after changing a config file
- Fresh clone produces different output than incremental build

**Prevention:**
- Declare all inputs explicitly for the API build task: `"build": { "inputs": ["src/**", "tsconfig.json", "nest-cli.json", "package.json"] }`
- Add environment variables to `globalEnv` in turbo.json if any are read at build time
- Add `.env` files to `globalDependencies` if any build step reads them
- Always run `turbo build --force` in CI (cache is for local dev speed, not CI correctness)
- Add a verification step: change `nest-cli.json`, run `turbo build`, confirm it rebuilds (not cache hit)

**Phase this should be resolved in:** Phase 2 (Turborepo configuration).

---

### Pitfall 4: Breaking Existing Workflows During Migration (The "Big Bang" Trap)

**What goes wrong:** Developer restructures tsconfig, turbo.json, package.json scripts, Docker Compose, and module system all at once. The PR touches 30+ files. When it breaks, there is no way to bisect which change caused the failure. Meanwhile, the working branch is broken, blocking all other feature work.

**Why it happens:** Monorepo restructuring feels like it should be done atomically because "everything depends on everything." But this is false. Each layer (tsconfig, turbo, docker, scripts) can be changed independently if done in the right order.

**Consequences:** Multi-day debugging sessions. Rolling back loses all progress. Solo dev (or team) is blocked on all feature work until the restructuring is fixed.

**Severity:** BLOCKING -- project-level risk, not just a technical bug.

**Detection:**
- PR diff exceeds 500 lines across 10+ files
- `pnpm dev` does not work at every intermediate commit
- No rollback plan exists

**Prevention:**
- Migrate in small, independently-verifiable steps. Each step MUST leave `pnpm dev` and `pnpm build` working.
- Suggested order: (1) fix dev script and port conflicts, (2) standardize tsconfigs and module system, (3) configure Turbo properly, (4) add Docker services, (5) add build gates. Each is a separate commit that can be reverted independently.
- Create a `pnpm verify` script that checks build succeeds, dev starts, tests pass. Run it after every change.
- Tag the current working state (`git tag pre-restructure`) before starting.

**Phase this should be resolved in:** Applies to ALL phases -- this is a meta-pitfall about execution strategy.

---

### Pitfall 5: Root dev Script Two-Phase Build Masks Dependency Issues

**What goes wrong:** The current root `dev` script is:
```
turbo build --filter='./packages/connectors/*' --filter=@botmem/connector-sdk --filter=@botmem/cli && turbo dev --filter=@botmem/shared --filter=@botmem/api --concurrency 10
```
This pre-builds connectors before starting dev mode. It works, but the dependency relationship is encoded in a shell script, not in `turbo.json`. If someone runs `turbo dev` directly (without the pre-build), connectors have no `dist/` output and the API crashes with missing module errors at runtime. The workaround works but hides the real problem: the dev pipeline does not properly declare its dependencies.

**Severity:** BLOCKING for new developers or CI environments that run commands differently.

**Detection:**
- Run `turbo dev` without the pre-build step -- if the API crashes, the dependency is not properly declared
- Check if `turbo.json` `dev` task has a `dependsOn` that includes package builds

**Prevention:**
- Encode the dependency in turbo.json, not in shell scripts. The `dev` task for `@botmem/api` should declare `dependsOn: ["^build"]` so Turbo builds all upstream packages before starting the API's dev server.
- Turbo 2.4 supports this: a `persistent: true` task can have non-persistent dependencies. Turbo will complete the dependency builds, then start the persistent dev server.
- Simplify the root script to just `turbo dev` and let turbo.json handle ordering.

**Phase this should be resolved in:** Phase 1 (dev script redesign) or Phase 2 (Turbo configuration).

---

## Moderate Pitfalls

### Pitfall 6: TypeScript Project References Circular Dependency Trap

**What goes wrong:** When adding TypeScript project references (`composite: true`, `references: [...]`), the dependency graph must be a strict DAG. In this project, the expected hierarchy is: `shared` <- `connector-sdk` <- `connectors` <- `api`, and `shared` <- `web`. If any package imports a type from a package higher in the chain (e.g., a connector importing from `@botmem/api`), adding project references fails with `TS6202: Project references may not form a circular dependency`.

**Why it happens:** Without project references, TypeScript does not enforce acyclic dependencies -- it resolves everything via `node_modules`. Project references make the graph explicit, surfacing cycles that were always hidden.

**Consequences:** Cannot enable `tsc --build` mode (which provides fast incremental rebuilds across packages). Falls back to per-package `tsc` which does not understand cross-package ordering. The "fix" often involves splitting packages or moving types -- a larger refactor than expected.

**Severity:** Moderate-to-blocking, depending on whether cycles exist.

**Detection:**
- Before adding references, audit imports: does any connector import from `@botmem/api`? Does `@botmem/shared` import from any consumer?
- Use `npx madge --circular --extensions ts apps/api/src` to detect circular imports within the API
- Check if shared/connector-sdk have any dependency on api in their package.json

**Prevention:**
- Audit the dependency graph before enabling project references. The DAG should flow one direction only.
- If cycles exist, extract shared types into `@botmem/shared` (which is already the intended pattern).
- Add project references incrementally: start with `shared` -> `connector-sdk` -> one connector -> verify. Do not add all packages at once.
- Project references are OPTIONAL. If the graph is clean but adoption is complex, skip them and rely on Turbo's `dependsOn: ["^build"]` for ordering. The main benefit (fast `tsc --build --watch`) is valuable but not mandatory.

**Phase this should be resolved in:** Phase 2 (TypeScript configuration). Only after module system is resolved.

---

### Pitfall 7: Docker Volume Mount Performance on macOS Destroys Dev Speed

**What goes wrong:** Docker Desktop on macOS uses a Linux VM. File system mounts from macOS into the VM are 5-20x slower than native for `node_modules`-heavy workloads. `pnpm install` that takes 10s natively takes 60-120s with mounted volumes. `tsc --watch` inside Docker detects file changes with multi-second latency. Hot reload becomes useless.

**Severity:** Annoying but impactful -- does not break correctness but makes Docker-based development practically unusable for the application code.

**Prevention:**
- Do NOT run application dev servers (NestJS, Vite) inside Docker on macOS. Keep them native.
- Docker Compose dev file should containerize infrastructure only: Redis, Qdrant, and optionally Ollama. Application code runs natively with `pnpm dev`.
- Use `docker compose up redis qdrant` for infrastructure, `pnpm dev` for application code.
- If full containerization is needed later (CI, staging), use VirtioFS file sharing (default in recent Docker Desktop) and avoid mounting `node_modules` (use named volumes or install inside container).

**Phase this should be resolved in:** Phase 3 (Docker Compose). Design the dev compose file correctly from the start.

---

### Pitfall 8: Ollama Container GPU Passthrough Does Not Work on macOS

**What goes wrong:** Adding Ollama to Docker Compose with `deploy.resources.reservations.devices` for GPU access only works on Linux with NVIDIA drivers. On macOS (which this project develops on), Docker runs in a VM with no GPU passthrough. The Ollama container falls back to CPU inference, which is 10-50x slower for the models used (`qwen3:0.6b`, `nomic-embed-text`).

**Severity:** Moderate -- affects the "plug-and-play" goal. A developer who runs `docker compose up` expecting everything to work will get painfully slow AI inference.

**Prevention:**
- Use Docker Compose profiles: Ollama in a `gpu` profile, only started with `docker compose --profile gpu up`. Default profile includes Redis + Qdrant only.
- Document three Ollama options: (1) Use existing remote Ollama at `OLLAMA_BASE_URL`, (2) install Ollama natively on macOS (`brew install ollama`), (3) use Docker container on Linux with GPU.
- The env var `OLLAMA_BASE_URL` with default `http://host.docker.internal:11434` already handles the "native Ollama + Docker infra" pattern. Just make the Docker Ollama service optional.

**Phase this should be resolved in:** Phase 3 (Docker Compose).

---

### Pitfall 9: pnpm workspace:* Protocol Breaks Docker Image Builds

**What goes wrong:** `workspace:*` dependencies in package.json work locally because pnpm resolves them to local packages. During Docker image builds, if the Dockerfile copies only `apps/api` (to keep image size small), pnpm cannot resolve `workspace:*` and the install fails with "ERR_PNPM_NO_MATCHING_VERSION."

**Severity:** Moderate -- blocks production Docker image builds. Does not affect dev Docker Compose (which only runs infrastructure services).

**Detection:**
- Try `docker build .` -- if it copies partial monorepo, install will fail on workspace deps
- Check if `Dockerfile` exists and how it handles the monorepo structure

**Prevention:**
- Use Turborepo's `turbo prune --scope=@botmem/api --docker` to generate a pruned monorepo. This creates a `json/` directory (lockfile + package.jsons for layer caching) and `full/` directory (source). The Dockerfile copies `json` first, installs, then copies `full`.
- Alternatively, use `pnpm deploy --filter @botmem/api` which rewrites `workspace:*` to actual versions in the deployed output.
- Always copy the full `pnpm-workspace.yaml` and `pnpm-lock.yaml` into the Docker build context.
- Test Docker build from clean state (`docker build --no-cache .`) -- cached layers mask workspace resolution failures.

**Phase this should be resolved in:** Phase 3 (Docker) or Phase 4 (production build pipeline). Not needed for dev compose.

---

### Pitfall 10: Turborepo Watch Mode Does Not Restart Dependent Persistent Tasks

**What goes wrong:** `turbo dev` with `persistent: true` runs long-lived dev servers. But Turbo does NOT restart a persistent task when its upstream dependency rebuilds. If `@botmem/shared` changes and rebuilds, Turbo does not restart the API's dev server. The developer must rely on the API's own file-watching mechanism (currently nodemon) to detect the change. This creates a confusing two-layer watch system where neither layer handles all cases.

**Severity:** Moderate -- causes confusion about whether changes are picked up.

**Prevention:**
- Accept that Turbo's job is task ordering and caching, not cascading restarts. The API's own watch mechanism must handle dependency changes.
- Best pattern: during dev, the API resolves workspace package source directly (via the existing `types: "./src/index.ts"` pattern), not compiled `dist/`. This means changes in shared source are visible immediately without waiting for shared to rebuild its dist.
- For this to work with the CJS API: use `ts-node` with `paths` aliases, or `tsx`, or SWC in watch mode. All of these can resolve TypeScript source directly.
- For production builds, `turbo build` with `dependsOn: ["^build"]` handles ordering correctly. The watch mode gap only affects dev.

**Phase this should be resolved in:** Phase 1 (dev script redesign). Design the dev experience around this limitation.

---

### Pitfall 11: shamefully-hoist Leaking Into the Repository

**What goes wrong:** The production deployment notes in MEMORY.md mention `shamefully-hoist=true` was needed for Docker builds. If this gets added to `.npmrc` in the repository root, it changes how ALL packages resolve dependencies. Phantom dependencies (packages not declared in your package.json but accessible because they are hoisted from other packages) start working locally. Then they fail in CI, in fresh clones, or when packages are used independently.

**Severity:** Moderate -- creates "works on my machine" bugs that surface unpredictably.

**Detection:**
- Check `.npmrc` for `shamefully-hoist=true` or `hoist=true`
- Import a package not in your own package.json but present elsewhere in the monorepo -- if it works, hoisting is too aggressive

**Prevention:**
- Use `shamefully-hoist=true` ONLY inside the Dockerfile's build step (create `.npmrc` in Docker context), not in the repo root `.npmrc`.
- Better: identify WHY shamefully-hoist was needed. Usually it is a package with undeclared peer dependencies. Add the missing dep explicitly to the consuming package's `package.json`.
- If selective hoisting is needed, use `public-hoist-pattern[]` in `.npmrc` to hoist only specific packages rather than everything.

**Phase this should be resolved in:** Phase 3 (Docker) when writing the production Dockerfile.

---

## Minor Pitfalls

### Pitfall 12: Lockfile Corruption During Workspace Restructuring

**What goes wrong:** Moving packages between directories, renaming workspace packages, or changing `pnpm-workspace.yaml` paths causes `pnpm-lock.yaml` to reference stale package locations. `pnpm install` silently regenerates parts of the lockfile, creating a massive diff (1000+ lines) that is unreviable and may change resolved dependency versions.

**Prevention:**
- After any workspace structural change, run `pnpm install --lockfile-only` and commit the lockfile as a SEPARATE commit with a clear message like "chore: regenerate lockfile after workspace restructure."
- Never restructure packages AND update dependencies in the same commit.
- If the lockfile diff is unreasonably large, regenerate cleanly: `rm pnpm-lock.yaml && pnpm install`.

**Phase this should be resolved in:** Any phase that moves or renames packages.

---

### Pitfall 13: types: "./src/index.ts" Works Until Productionization

**What goes wrong:** All workspace packages currently export `"types": "./src/index.ts"` -- pointing at source, not compiled declarations. This is actually a great DX pattern for internal monorepo development (instant type updates without rebuilding). But it breaks in two scenarios: (1) publishing packages to npm (external consumers cannot access `src/`), and (2) tools that resolve `types` literally (some bundlers, API documentation generators, Deno).

**Prevention:**
- For now, KEEP `types: "./src/index.ts"` for internal packages -- it is the reason development works despite the ESM/CJS mismatch.
- When preparing for publishing or commercialization, switch to `"types": "./dist/index.d.ts"` and ensure `declaration: true` in all tsconfigs.
- Use conditional exports in `package.json` if both dev and production modes are needed: `"exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }` and use TypeScript's `customConditions` for development mode.

**Phase this should be resolved in:** Phase 4 or later (productionization). Not urgent for internal packages.

---

### Pitfall 14: Test Gates in Build Pipeline Cause Developer Frustration

**What goes wrong:** Making tests a prerequisite for builds (`"build": { "dependsOn": ["test"] }` in turbo.json) means every `turbo build` runs the entire test suite first. During active development with rapid iteration, this adds 10-30 seconds to every build cycle. Developers learn to bypass it with `--force` or `--filter`, defeating the purpose.

**Prevention:**
- Do NOT make `test` a dependency of `build`. Keep them as separate, independent tasks in turbo.json (which is the current correct configuration).
- Create a separate `check` task that runs everything: `"check": { "dependsOn": ["build", "test", "lint"] }`. Use `pnpm check` before committing or pushing.
- Use pre-commit hooks (husky + lint-staged) to run lint and type-check on changed files only. Full test suite runs in CI.
- CI runs `turbo build && turbo test && turbo lint` as independent steps. Local dev runs only `turbo build` (or just `turbo dev`).

**Phase this should be resolved in:** Phase 4 (build pipeline gates).

---

### Pitfall 15: NestJS CLI Version Conflicts in Monorepo

**What goes wrong:** `@nestjs/cli` is installed as a devDependency of `apps/api`. If the root `package.json` or another workspace also installs a different version (e.g., via a global install or through a dependency that pulls it in), `nest build` may use the wrong version, producing different output or version-specific compilation errors.

**Prevention:**
- Install `@nestjs/cli` ONLY in `apps/api/package.json`, never at the monorepo root.
- Pin to a specific minor version (e.g., `11.0.5` not `^11.0.0`) to avoid surprise updates.
- Verify the correct version is used: `npx --prefix apps/api nest info`
- Consider replacing `nest build` with direct `tsc` or `swc` compilation to remove the CLI dependency entirely. The NestJS CLI adds SWC compilation, but `@swc/cli` (already installed) can do the same without the NestJS wrapper.

**Phase this should be resolved in:** Phase 2 (build configuration).

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation | Severity |
|-------------|---------------|------------|----------|
| Dev script redesign | Port conflict restart storms (#2) | Replace nodemon dist-watching with single-process watch or source-based resolution | Blocking |
| Dev script redesign | Turbo watch does not cascade restarts (#10) | API watches source directly via path aliases, not dist | Moderate |
| Dev script redesign | Root script masks dependency issues (#5) | Encode deps in turbo.json, simplify root script to `turbo dev` | Blocking |
| TypeScript configuration | ESM/CJS mismatch surfaces (#1) | Decide and resolve module system FIRST | Blocking |
| TypeScript configuration | Circular deps block project refs (#6) | Audit dependency graph before enabling composite | Moderate |
| Turborepo configuration | Cache poisoning from undeclared inputs (#3) | Declare all inputs, env vars, config files explicitly | Blocking |
| Docker Compose | macOS volume performance (#7) | Run app natively, containerize infrastructure only | Annoying |
| Docker Compose | Ollama GPU passthrough (#8) | Make Ollama optional via Docker Compose profiles | Moderate |
| Docker Compose | workspace:* breaks Docker builds (#9) | Use turbo prune or pnpm deploy for production images | Moderate |
| Docker Compose | shamefully-hoist leaking (#11) | Keep hoist config Docker-only, fix root causes | Moderate |
| Build pipeline gates | Tests blocking builds (#14) | Separate test and build tasks, use a `check` meta-task | Annoying |
| Any structural change | Lockfile corruption (#12) | Separate lockfile commits, clean regen when needed | Minor |
| Migration execution | Big bang trap (#4) | Small incremental steps, verify `pnpm dev` works at each | Blocking |
| Productionization | types pointing at src (#13) | Switch to dist types only when publishing | Minor |

## Critical Execution Order (Derived from Pitfall Dependencies)

The pitfall analysis constrains what must happen first:

1. **Module system decision** (Pitfall 1) -- ESM or CJS for the API. Everything else depends on this.
2. **Dev script fix** (Pitfalls 2, 5, 10) -- Eliminate restart storms and port conflicts. This is the primary user-facing pain.
3. **TypeScript standardization** (Pitfalls 1, 6) -- Consistent tsconfigs, optional project references.
4. **Turbo configuration** (Pitfall 3) -- Proper inputs, env declarations, dependency graph.
5. **Docker Compose** (Pitfalls 7, 8, 9, 11) -- Infrastructure services, profiles for Ollama.
6. **Build gates** (Pitfall 14) -- Check task, CI pipeline, pre-commit hooks.

Each step must leave `pnpm dev` and `pnpm build` working (Pitfall 4).

## Sources

All findings are HIGH confidence, derived from direct analysis of project files:

- `turbo.json` -- current task configuration, no `inputs` or `env` declarations
- `apps/api/nodemon.json` -- watches 8 dist directories with 1s delay, runs `nest build && node dist/main.js`
- `apps/api/tsconfig.json` -- `module: "commonjs"` overriding base `module: "ESNext"`
- `apps/api/nest-cli.json` -- `deleteOutDir: true`, not tracked by Turbo
- `tsconfig.base.json` -- base config with `module: "ESNext"`, `moduleResolution: "bundler"`
- `package.json` (root) -- two-phase dev script with explicit `--filter` ordering
- `packages/shared/package.json` -- `type: "module"`, `types: "./src/index.ts"`
- `packages/connector-sdk/package.json` -- same ESM + source types pattern
- `packages/connectors/gmail/package.json` -- same pattern across all connectors
- `docker-compose.yml` -- production-oriented, no Ollama, no dev-specific compose file
- `pnpm-workspace.yaml` -- workspace paths for apps, packages, and nested connectors
- `.planning/PROJECT.md` -- v3.0 milestone goals, known port conflict issues
- MEMORY.md -- `shamefully-hoist=true` note, NestJS watch mode limitation, port 12412 configuration

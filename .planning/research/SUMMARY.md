# Project Research Summary

**Project:** Botmem v3.0 Monorepo & Developer Experience
**Domain:** pnpm + Turborepo monorepo restructuring for NestJS + React project
**Researched:** 2026-03-08
**Confidence:** HIGH

## Executive Summary

Botmem's monorepo works but has accumulated significant developer experience debt. The core problem is a fragile dev workflow: a two-phase root dev script that manually pre-builds connectors, nodemon watching 8+ dist directories causing restart storms and port conflicts, zero linting or formatting, no pre-commit hooks, and a Docker Compose file that only serves production. Every research file converges on the same conclusion -- the existing Turborepo setup is barely utilized, and the tools already in place (pnpm workspaces, Turbo task graph, SWC in NestJS) can solve all of these problems without adding heavy new dependencies.

The recommended approach is incremental, config-first migration. Start by fixing what hurts most (dev script reliability, port conflicts), then layer on quality tooling (ESLint 9, Prettier, Husky), then optimize builds (pnpm catalogs, Docker profiles). The Immich reference validates key patterns: `nest start --watch` replacing nodemon, health checks on all Docker services, `tsc --noEmit` as a standalone check task, and a Makefile as the developer-facing command layer on top of build tooling. Critically, do NOT attempt to migrate the API from CJS to ESM -- NestJS 11 still does not officially support ESM, and the current CJS/ESM bridge works. Fixing it is high risk for zero user-facing value.

The single biggest risk is the ESM/CJS boundary. The project papers over the mismatch with `types: "./src/index.ts"` pointing at source. This works and should be preserved during restructuring. Any change that switches types to dist output will surface `ERR_REQUIRE_ESM` runtime errors. The second risk is "big bang" migration -- touching tsconfig, turbo.json, Docker, and scripts in one PR. Each step must leave `pnpm dev` and `pnpm build` working. Tag `pre-restructure` before starting.

## Key Findings

### Recommended Stack

No new runtime dependencies. This milestone is entirely about tooling and configuration. See [STACK.md](./STACK.md) for full details.

**Core additions:**
- **pnpm catalogs** (stay on 9.15): Centralize TypeScript, Vitest, and Vite version specifiers in `pnpm-workspace.yaml`. Eliminates duplication across 10+ package.json files. Do NOT upgrade to pnpm 10 -- breaking changes not worth the risk.
- **Turborepo 2.8** (upgrade from 2.4): Stable watch mode, `interruptible` tasks, better caching. The key enabler for replacing nodemon.
- **ESLint 9 + Prettier 3**: Single root `eslint.config.mjs` with flat config. No shared config package needed for a single-developer project. ESLint 8 is EOL.
- **Husky 9 + lint-staged 16**: Pre-commit hooks for formatting and linting staged files. Pre-push hooks for typecheck.
- **Docker Compose profiles**: Ollama as an opt-in profile, Redis + Qdrant as defaults. Health checks on all services. Pin image versions.
- **Makefile** (from Immich): Developer-facing command layer (`make dev`, `make check`). Coexists with Turbo for build orchestration.

**Explicitly rejected:** pnpm 10, Nx, Biome, TypeScript project references, shared config packages, changesets, Storybook, remote caching, commitlint.

### Expected Features

Three tiers of features identified. See [FEATURES.md](./FEATURES.md) for the complete landscape.

**Must have (table stakes):**
- ESLint + Prettier configuration (zero linting exists today)
- `typecheck` as a standalone Turbo task
- Reliable `pnpm dev` that starts everything without manual pre-builds
- `.env.example` documenting all 11 environment variables
- `.npmrc` with correct monorepo settings
- Docker Compose with health checks for dev infrastructure
- Git hooks (pre-commit: lint+format, pre-push: typecheck)
- Health check endpoint (`/api/health`) for Docker readiness probes
- Fix nodemon hardcoded watch paths (or replace nodemon entirely)
- Consistent `exports` field in all library package.json files

**Should have (differentiators for DX):**
- pnpm catalogs for version deduplication
- Docker Compose profiles (Ollama, prod)
- `tsx watch` or `nest start --watch` replacing nodemon
- Vitest workspace config consolidation
- Root `setup` script for onboarding
- Makefile for developer commands

**Defer:**
- Docker multi-stage production build optimization
- SWC for library package builds
- CI/CD GitHub Actions workflow
- Remote Turbo caching
- Publishing packages to npm

### Architecture Approach

The dependency graph is clean and should be made explicit. See [ARCHITECTURE.md](./ARCHITECTURE.md) for component boundaries and data flow.

**Major components and their migration impact:**
1. **Package exports** -- Switch all libraries to conditional `exports` field with `types` pointing to source (live types pattern). Remove legacy `main`/`types` top-level fields.
2. **Turbo task graph** -- Add `inputs` to all tasks for cache efficiency. Add `interruptible: true` for API dev task. Encode dependency ordering in turbo.json, not in shell scripts.
3. **Dev mode orchestration** -- Replace nodemon with `turbo watch` (libraries do `tsc --watch`, API uses `nest start --watch` or `interruptible` restart). Root script simplifies to `turbo watch dev`.
4. **Docker Compose** -- Profiles for Ollama and prod API. Health checks on Redis, Qdrant, Ollama. Pin versions. Infrastructure-only in dev (app runs natively).
5. **CJS/ESM bridge** -- Keep API as CJS. Do NOT migrate. The `types: "./src/index.ts"` pattern is the bridge and must be preserved.

### Critical Pitfalls

Top 5 from [PITFALLS.md](./PITFALLS.md), ordered by severity:

1. **ESM/CJS module split causes silent runtime failures** -- Keep API as CJS, preserve `types: "./src/index.ts"`, do NOT switch types to dist output. Test with clean `rm -rf dist && nest build && node dist/main.js` after every tsconfig change.
2. **Nodemon restart storms and port conflicts** -- Replace nodemon entirely. Use `nest start --watch` (Immich pattern) or `turbo watch` with `interruptible`. This is the primary bug this milestone fixes.
3. **Turbo cache poisoning from undeclared inputs** -- Declare `nest-cli.json`, `package.json`, and all config files in task `inputs`. Add env vars to `globalEnv`. Run `--force` in CI.
4. **Big bang migration trap** -- Each change must be a separate, revertable commit. Tag `pre-restructure` before starting. Verify `pnpm dev` and `pnpm build` work after every step.
5. **Root dev script masking dependency issues** -- Move dependency ordering into turbo.json `dependsOn`, not shell script `--filter` chains. Root script becomes `turbo watch dev`.

## Implications for Roadmap

Based on combined research, 5 phases are recommended. The ordering is constrained by pitfall dependencies: module system must be stable before build config changes, dev workflow must work before adding quality gates.

### Phase 1: Foundation Config

**Rationale:** Zero-risk config-only changes that establish the baseline. No structural changes, no behavior changes. Everything added here is a prerequisite for later phases.
**Delivers:** Linting, formatting, typecheck, .env documentation, .npmrc, editorconfig
**Addresses:** ESLint config, Prettier, typecheck task, .env.example, .npmrc, .editorconfig, tsconfig NestJS base
**Avoids:** Big bang trap (Pitfall 4) -- pure additions, nothing removed or changed
**Effort:** 2-3 hours

Key tasks:
- Root `eslint.config.mjs` (ESLint 9 flat config + typescript-eslint + prettier)
- Root `.prettierrc` and `.editorconfig`
- `.env.example` with all variables and safe defaults
- `.npmrc` with monorepo settings (but NOT `shamefully-hoist` -- Docker-only)
- `tsconfig.nestjs.json` extending base with CJS overrides
- Add `lint` and `typecheck` scripts to all packages
- Update `turbo.json` with `lint` and `typecheck` tasks

### Phase 2: Dev Workflow Fix

**Rationale:** Fixes the primary pain point (restart storms, port conflicts) and establishes the correct dev loop. This is the highest-value phase and the reason the milestone exists.
**Delivers:** Reliable `pnpm dev`, no port conflicts, dependency-aware restarts, health endpoint
**Addresses:** Dev script reliability, nodemon replacement, health check endpoint, package exports consistency
**Avoids:** Restart storms (Pitfall 2), root script masking deps (Pitfall 5), turbo watch cascade limitation (Pitfall 10)
**Effort:** 4-6 hours

Key tasks:
- Upgrade Turbo to 2.8
- Rewrite `turbo.json` with proper `inputs`, `outputs`, `dependsOn`, `interruptible`
- Update all library dev scripts to `tsc --watch --preserveWatchOutput`
- Replace nodemon with `nest start --watch` (validated by Immich) or turbo watch interruptible restart
- Delete `apps/api/nodemon.json`
- Simplify root dev script to `turbo watch dev`
- Fix `exports` field in all library package.json (conditional exports, remove legacy `main`/`types`)
- Add `GET /api/health` endpoint checking Redis + Qdrant + SQLite
- Remove web tsconfig path alias for `@botmem/shared` (let pnpm resolve it)

### Phase 3: Docker & Infrastructure

**Rationale:** With dev workflow stable, containerize the infrastructure properly. Health checks enable `depends_on: condition: service_healthy`.
**Delivers:** One-command infrastructure startup, Ollama as opt-in profile, pinned versions, health checks
**Addresses:** Docker Compose dev profile, Ollama profile, pinned image versions, health checks
**Avoids:** macOS volume performance (Pitfall 7), GPU passthrough issues (Pitfall 8), shamefully-hoist leaking (Pitfall 11)
**Effort:** 2-3 hours

Key tasks:
- Replace `docker-compose.yml` with profile-based version (default: Redis + Qdrant; `ollama` profile; `prod` profile)
- Pin Redis (`7.4-alpine`), Qdrant (`v1.12.6` or `v1.13.2`), Ollama versions
- Add health checks to all services
- Add `depends_on: condition: service_healthy` for prod API
- Create Makefile with `dev`, `check`, `setup` targets (inspired by Immich)
- Add root `setup` script: `pnpm install && docker compose up -d && pnpm build`

### Phase 4: Build Optimization & Consistency

**Rationale:** With workflow and infrastructure stable, optimize the build pipeline and add version consistency.
**Delivers:** Centralized dependency versions, pre-commit hooks, consolidated test config
**Addresses:** pnpm catalogs, Husky + lint-staged, Vitest workspace, build pipeline gates
**Avoids:** Lockfile corruption (Pitfall 12), test gates blocking dev (Pitfall 14)
**Effort:** 3-5 hours

Key tasks:
- Add pnpm catalogs to `pnpm-workspace.yaml` (TypeScript, Vitest, Vite, @types/node)
- Update all package.json to use `catalog:` protocol (mechanical, touches every file)
- Regenerate lockfile in a separate commit
- Install and configure Husky 9 + lint-staged 16
- Pre-commit: `eslint --fix` + `prettier --write` on staged `.ts/.tsx` files
- Pre-push: `turbo typecheck` + `turbo test --filter='...[HEAD~1]'`
- Create `ci` meta-task in turbo.json (`dependsOn: ["lint", "test", "build"]`)
- Optional: Vitest workspace config to consolidate 10 vitest configs

### Phase 5: Production Docker & Cleanup

**Rationale:** Final polish. Production Docker image optimization and cleanup of any remaining debt.
**Delivers:** Optimized Docker image, clean duplicate deps, documentation
**Addresses:** Docker multi-stage build, duplicate Vite deps in API, workspace:* Docker builds
**Avoids:** workspace:* breaking Docker builds (Pitfall 9)
**Effort:** 2-4 hours

Key tasks:
- Docker multi-stage build using `turbo prune --scope=@botmem/api --docker`
- Remove duplicate Vite dev deps from API package.json
- Add `shamefully-hoist=true` inside Dockerfile only (not repo root)
- Clean up any remaining anti-patterns identified during earlier phases

### Phase Ordering Rationale

- **Phase 1 before Phase 2:** Linting and typecheck must exist before they can be used as build gates or pre-commit hooks. The NestJS tsconfig base must be in place before touching build configuration.
- **Phase 2 before Phase 3:** The health endpoint (Phase 2) is needed by Docker Compose health checks (Phase 3). Dev workflow must be stable before adding infrastructure complexity.
- **Phase 3 before Phase 4:** Makefile targets reference Docker Compose commands. Infrastructure must be in place before the developer onboarding script works.
- **Phase 4 before Phase 5:** pnpm catalogs touch every package.json -- must be done before the production Docker build is finalized (lockfile stability).
- **Each phase is independently shippable.** If the milestone is cut short, Phase 2 alone delivers the highest value.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 2 (Dev Workflow):** The `nest start --watch` vs `turbo watch interruptible` decision needs hands-on testing. Both approaches are valid but behave differently with workspace dependency changes. Test both before committing to one.
- **Phase 2 (CJS/ESM):** The ESM/CJS bridge is the highest-risk area. After changing package exports, run a clean build and verify the API starts without module resolution errors.

Phases with standard, well-documented patterns (skip research-phase):
- **Phase 1 (Foundation Config):** ESLint 9 flat config, Prettier, tsconfig -- all thoroughly documented.
- **Phase 3 (Docker):** Docker Compose profiles and health checks are well-established patterns.
- **Phase 4 (Build Optimization):** pnpm catalogs and Husky are straightforward configuration.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All recommendations based on official docs (pnpm, Turbo, ESLint). Versions verified on npm. No novel technology choices. |
| Features | HIGH | Feature list derived from direct codebase analysis. Every gap has evidence (missing files, broken scripts). |
| Architecture | HIGH | Dependency graph verified from actual package.json files. Turbo watch and conditional exports are documented patterns. |
| Pitfalls | HIGH | All pitfalls derived from reading actual project files (nodemon.json, turbo.json, tsconfig). ESM/CJS risk is the only MEDIUM-confidence area. |

**Overall confidence:** HIGH

### Gaps to Address

- **ESM/CJS runtime behavior after exports change:** The `types: "./src/index.ts"` pattern currently masks module resolution issues. After switching to proper conditional exports, the CJS API importing ESM packages needs runtime verification. Cannot be fully assessed from static analysis alone -- must test.
- **`nest start --watch` with workspace deps:** Immich uses this pattern but Immich's server does not import from workspace ESM packages the same way Botmem does. Need to verify that `nest start --watch` correctly picks up changes in workspace package dist directories.
- **Turbo 2.8 `interruptible` behavior:** This feature is documented but the interaction with `tsc --watch` persistent tasks and SWC compilation needs hands-on validation. The docs suggest it works but edge cases with signal handling are possible.

## Sources

### Primary (HIGH confidence)
- [pnpm Catalogs](https://pnpm.io/catalogs) -- catalog protocol, version management
- [Turborepo Watch](https://turborepo.dev/docs/reference/watch) -- interruptible tasks, dev mode
- [Turborepo Structuring a Repository](https://turborepo.dev/docs/crafting-your-repository/structuring-a-repository) -- task inputs, outputs, caching
- [ESLint Flat Config](https://eslint.org/docs/latest/use/configure/configuration-files) -- ESLint 9 configuration
- [Docker Compose Profiles](https://docs.docker.com/compose/profiles/) -- service profiles
- [Husky](https://typicode.github.io/husky/) -- git hooks
- [NestJS ESM Issue #13319](https://github.com/nestjs/nest/issues/13319) -- CJS requirement confirmed
- [Immich monorepo](https://github.com/immich-app/immich) -- production NestJS monorepo patterns (Makefile, nest start --watch, health checks)

### Secondary (MEDIUM confidence)
- [Live Types in TypeScript Monorepo](https://colinhacks.com/essays/live-types-typescript-monorepo) -- conditional exports pattern
- [pnpm + NestJS CJS/ESM interop guide](https://dev.to/lico/step-by-step-guide-sharing-types-and-values-between-react-esm-and-nestjs-cjs-in-a-pnpm-monorepo-2o2j) -- module resolution strategies
- [Nhost Turborepo configuration](https://nhost.io/blog/how-we-configured-pnpm-and-turborepo-for-our-monorepo) -- real-world patterns
- Direct codebase analysis: turbo.json, nodemon.json, all package.json files, tsconfig files, docker-compose.yml

### Tertiary (LOW confidence)
- Turbo 2.8 `interruptible` + SWC interaction -- documented but not widely battle-tested in this specific configuration

---
*Research completed: 2026-03-08*
*Ready for roadmap: yes*

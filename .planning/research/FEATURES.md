# Feature Landscape

**Domain:** Monorepo tooling and developer experience for pnpm + NestJS + React
**Researched:** 2026-03-08
**Context:** Single-developer project with 10+ packages, existing Turborepo setup, targeting production-grade DX

## Table Stakes

Features every serious pnpm monorepo has. Missing these means constant friction and wasted time.

| Feature | Why Expected | Complexity | Change Type | Notes |
|---------|--------------|------------|-------------|-------|
| Shared tsconfig bases (plural) | Prevents config drift. Currently `tsconfig.base.json` uses `moduleResolution: bundler` but API overrides to `node` + `commonjs`. Need separate bases: one for ESM packages, one for NestJS CJS. | Low | Config only | Create `tsconfig.nestjs.json` extending base with CJS overrides. All connectors + shared + web use the ESM base as-is |
| ESLint shared config | No lint config exists anywhere. `turbo lint` has nothing to run. Zero linting across 10+ packages. | Medium | New config + per-package scripts | Root `eslint.config.mjs` (flat config) with `@typescript-eslint`. Each package gets `"lint": "eslint src"`. No need for a shared config package -- flat config at root with Turbo handles it |
| Prettier + EditorConfig | Zero formatting config exists. No `.prettierrc`, no `.editorconfig`. Code style is whatever each file happened to be when written. | Low | Config only | Root `.prettierrc` + `.editorconfig`. Formatting enforced via lint-staged pre-commit, not as a Turbo task |
| `typecheck` as a separate Turbo task | `tsc --noEmit` is not run anywhere independently. Type errors only surface during build, which is slow. Need a fast type-check gate. | Low | Config only | Add `"typecheck": "tsc --noEmit"` to each package, register in `turbo.json`. Runs in parallel across all packages |
| Build pipeline quality gates | Current `turbo.json` has no dependency between build and quality checks. Tests can fail and build still succeeds. Build should not pass unless lint + typecheck + test pass. | Low | Config only | Update `turbo.json`: `"build": { "dependsOn": ["^build", "lint", "typecheck"] }`. Tests run in parallel with build, not as a gate (too slow for dev loop) |
| Docker Compose for local dev | Current compose is a self-hosting/prod config (builds API from Dockerfile). Missing Ollama, no health checks, no dev profiles. New developer has to know to run services manually. | Medium | New compose file | Create `docker-compose.dev.yml` with Redis, Qdrant, Ollama (CPU). Keep existing `docker-compose.yml` for prod self-hosting |
| `.env.example` with all variables | No `.env.example` exists. Developer must read CLAUDE.md to discover env vars. 11 variables with non-obvious defaults (e.g., Ollama at `192.168.10.250`). | Low | New file | List every variable from `config.service.ts` with safe defaults. Ollama default should be `http://localhost:11434` (not the private IP) |
| `pnpm dev` starts everything reliably | Current root `dev` script pre-builds ALL connectors with explicit `--filter`, then starts only API + shared. Web is excluded. Adding a connector requires editing the root script. | Medium | Script rewrite | Turbo should handle dependency ordering via `dependsOn`. Root `dev` should just be `turbo dev`. Pre-build step is a workaround for missing Turbo config |
| Hardcoded nodemon watch paths | `nodemon.json` explicitly lists every single connector dist path. Adding a new connector requires editing this file or the API won't reload. | Low | Config change | Use glob pattern `../../packages/*/dist` and `../../packages/connectors/*/dist`. Or migrate to `tsx watch` entirely |
| `.npmrc` with monorepo settings | No `.npmrc` exists. Missing `shamefully-hoist=true` (known Docker build requirement per project memory), missing peer dependency config. | Low | New file | `shamefully-hoist=true`, `strict-peer-dependencies=false`, `auto-install-peers=true` |
| Health check endpoint | Only `/api/version` exists. No endpoint verifies Redis, Qdrant, SQLite connectivity. Docker Compose `depends_on` cannot wait for readiness. | Low | Small code change | Add `GET /api/health` returning status of all dependencies. Used by Docker `healthcheck` and by developer to verify stack is up |
| Consistent `exports` in package.json | `@botmem/shared` and `@botmem/connector-sdk` point `types` at `./src/index.ts` (source). Works in dev but breaks if someone consumes the built package. Inconsistent resolution between dev and prod. | Low | Package.json edits | Point `types` to `./dist/index.d.ts`. Use `"typesVersions"` or just ensure `tsc --watch` keeps `.d.ts` fresh during dev |
| Git hooks with lint-staged | No pre-commit hooks. Bad formatting and lint errors only caught if developer manually runs checks. | Low | Config only | `husky` + `lint-staged`: run Prettier + ESLint on staged files only. Fast, non-intrusive |

## Differentiators

Features that dramatically improve solo-dev productivity. Not expected in every monorepo, but high ROI here.

| Feature | Value Proposition | Complexity | Change Type | Notes |
|---------|-------------------|------------|-------------|-------|
| pnpm catalogs | TypeScript (5.7), Vitest (3.0), Vite (6.1) versions duplicated across 10+ `package.json` files. Catalogs centralize version specifiers in `pnpm-workspace.yaml`. Change once, all packages get the same version. Eliminates version drift. | Medium | pnpm-workspace.yaml + all package.json | Requires pnpm 9.5+ (already on 9.15). Define `catalog:` section, replace version ranges with `catalog:default` protocol. Touches every package.json but is mechanical |
| Docker Compose profiles | `--profile dev` = Redis+Qdrant+Ollama. `--profile ci` = Redis+Qdrant only. `--profile gpu` = Ollama with GPU passthrough. One file, multiple modes for different needs. | Medium | Compose rewrite | Use `profiles:` key on services. Default (no profile) = just Redis+Qdrant (backward compatible). `dev` adds Ollama |
| Vitest workspace config | 10 separate `vitest.config.ts` files with duplicated config (coverage thresholds, SWC plugin, globals). Vitest workspace file at root defines all projects once. | Medium | New root config | Create `vitest.workspace.ts` at root. Remove per-package configs (or make them minimal overrides). Coverage thresholds defined once. Single `pnpm test` at root runs everything |
| `tsx watch` replacing nodemon | nodemon + nest build + node = 3-step restart cycle. `tsx watch src/main.ts` = instant restart via esbuild, no intermediate build. Saves 2-5 seconds per reload. | Low | Config change | `tsx` uses esbuild. NestJS decorators work fine with SWC/esbuild at runtime. Keep `nest build` for production builds only. Dev loop becomes: tsx watches source, restarts on change |
| Docker multi-stage build | Current Dockerfile exists but is basic. Proper multi-stage: deps -> build -> runtime. Reduces image from ~1GB to ~200MB. Faster deploys, less bandwidth. | Medium | Dockerfile rewrite | Stage 1: pnpm fetch (cached layer). Stage 2: build with Turbo. Stage 3: Alpine runtime with only dist + node_modules. `shamefully-hoist=true` in `.npmrc` required |
| Root `setup` script | `pnpm install && docker compose up -d && pnpm build` as a single command. Currently requires reading docs and running 3 separate commands. | Low | Script in package.json | Add `"setup": "pnpm install && docker compose -f docker-compose.dev.yml up -d && pnpm build"` |
| SWC for package builds | API already uses SWC. Library packages (`shared`, `connector-sdk`, connectors) use plain `tsc` which is 20-70x slower. | Medium | Config per package | Use SWC for JS emit, keep `tsc --emitDeclarationOnly` for `.d.ts` files. Two-step build: `swc src -d dist && tsc --emitDeclarationOnly`. Faster rebuild loop |

## Anti-Features

Features to explicitly NOT build. Either overkill for a single developer or creates more problems than it solves.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Changesets / automated versioning | All packages are private (`"private": true`), nothing published to npm. Version management overhead with zero benefit for internal-only packages. | Keep `version: 0.0.1` in all packages. Version the product via git tags |
| Nx migration | Turbo already works. Nx is more complex to configure, has a steeper learning curve, and its advantages (computation cache graph, affected detection) only pay off at 50+ packages. Migration cost is high for marginal gain. | Keep Turborepo. It handles 10-15 packages perfectly |
| Lerna | Dead tool. pnpm workspaces + Turbo already do everything Lerna did and more | Already using the right tools |
| TypeScript project references | Sounds good for incremental builds but requires `composite: true` and `references` array in every `tsconfig.json`. Turbo already handles build ordering via `dependsOn: ["^build"]`. Project references add config complexity for no additional benefit when Turbo is present. | Turbo handles build ordering. TypeScript project references are redundant |
| Module federation / micro-frontends | Single React app, single developer. Module federation adds webpack/Vite plugin complexity for zero benefit. This is not a micro-frontend architecture. | Single Vite build for the web app |
| Monorepo-wide convenience scripts | Root `package.json` should have only: `dev`, `build`, `test`, `lint`, `typecheck`, `setup`. Proliferating scripts like `test:api`, `build:web`, `lint:shared` creates confusion about where to run what. | Minimal root scripts. Use `turbo run test --filter=@botmem/api` for targeted runs |
| Verdaccio / private registry | All packages use `workspace:*` protocol. No need for a registry when nothing is published. | `workspace:*` handles internal dependency resolution |
| Separate CI matrix jobs | Single developer. One `turbo run lint typecheck test build` command is sufficient. Matrix strategies with parallel jobs are for teams needing fast feedback across many PRs. | Single CI job with Turbo parallelism handles everything |
| Commitlint / conventional commits enforcement | Adds pre-commit friction for a solo developer. Convention is good; enforcement tooling has maintenance cost that exceeds value for one person. | Follow conventional commit style by habit, not by hook |
| Storybook | No component library, no design system, no team to collaborate with on UI components. Storybook is for shared component documentation across teams. | Test components with Vitest + Testing Library (already configured) |
| Monorepo-wide eslint config package | Creating a `packages/eslint-config` shared package adds a build step and versioning. With ESLint flat config, a single `eslint.config.mjs` at the root covers all packages via Turbo's directory traversal. | Single root `eslint.config.mjs` with flat config format |

## Feature Dependencies

```
.npmrc setup ---------> pnpm catalogs (catalogs need .npmrc to be correct first)
                    |
ESLint flat config -+-> lint-staged + husky (lint must exist before staged linting)
Prettier config ----+
                    |
typecheck task -----+-> build pipeline gates (tasks must exist before gating on them)
lint task ----------+
                    |
health endpoint -------> Docker Compose dev health checks (endpoint must exist first)
                    |
.env.example ----------> Docker Compose dev (compose references same env vars)
                    |
tsconfig bases --------> SWC migration (need correct tsconfig before switching compilers)
                    |
nodemon fix / tsx ------> pnpm dev reliability (dev script depends on watch working)
```

## MVP Recommendation

Three phases, each self-contained and independently shippable.

### Phase 1: Foundation Config (no structural changes, config files only)
1. `.npmrc` with `shamefully-hoist=true`, `strict-peer-dependencies=false`, `auto-install-peers=true`
2. `.env.example` documenting all 11+ environment variables with safe defaults
3. `.editorconfig` + `.prettierrc` at root
4. Root `eslint.config.mjs` (flat config) with `@typescript-eslint` rules
5. Add `"typecheck"` and `"lint"` scripts to all packages
6. Update `turbo.json`: add `typecheck` and `lint` tasks, make `build` depend on them
7. Create `tsconfig.nestjs.json` base for CJS targets

**Effort:** 2-3 hours. **Risk:** Low -- config files only.

### Phase 2: Dev Workflow (daily experience improvements)
1. `docker-compose.dev.yml` with Redis, Qdrant, Ollama (CPU), health checks, profiles
2. `/api/health` endpoint checking Redis + Qdrant + SQLite connectivity
3. Fix `pnpm dev`: remove manual pre-build, let Turbo handle ordering
4. Replace hardcoded nodemon paths with glob or migrate to `tsx watch`
5. Root `"setup"` script
6. Fix `exports.types` to point at `dist/` not `src/` in library packages

**Effort:** 4-6 hours. **Risk:** Medium -- touches daily dev workflow, must test thoroughly.

### Phase 3: Build Optimization (speed and consistency)
1. pnpm catalogs for shared dependency versions (TypeScript, Vitest, Vite, etc.)
2. Vitest workspace config (consolidate 10 vitest configs)
3. Docker multi-stage build for API image
4. `husky` + `lint-staged` for pre-commit hooks
5. SWC for library package builds (where applicable)

**Effort:** 3-5 hours. **Risk:** Medium -- pnpm catalogs touch every package.json, Vitest workspace changes test infra.

**Defer to v3.1 (CI/CD milestone):** GitHub Actions workflow, remote caching, automated deployments.

## Current State Gaps (Evidence)

| What's Missing | Evidence |
|---|---|
| No ESLint config | Zero eslint configs in project source (only in node_modules). `turbo lint` has no tasks to run |
| No Prettier config | No `.prettierrc` at project root or in any package |
| No `.npmrc` | File does not exist at repo root |
| No `.env.example` | File does not exist (or is gitignored with no public equivalent) |
| No `.editorconfig` | File does not exist at repo root |
| No `typecheck` task | Not in any package.json scripts, not in turbo.json tasks |
| No `lint` task in packages | Only root package.json has `"lint": "turbo lint"`, no package defines its own lint script |
| No git hooks | No `.husky` directory, no `lint-staged` in dependencies |
| No health check endpoint | Only `/api/version` exists, no dependency health verification |
| Docker Compose is prod-oriented | Builds API from Dockerfile, no Ollama, no health checks, no dev profile |
| nodemon hardcodes every path | `nodemon.json` explicitly lists 7 connector dist directories by name |
| tsconfig inconsistency | Base: `moduleResolution: bundler`, `module: ESNext`. API overrides both to `node` + `commonjs`. No shared NestJS base |
| Dev script is fragile | Root `dev` pre-builds connectors with 7 explicit `--filter` flags, then runs only API + shared. Web excluded |
| Duplicate dependency versions | TypeScript `^5.7.0` appears in root + 10 packages. Vitest `^3.0.0` in root + 10 packages. No central version management |

## Sources

- [pnpm Catalogs documentation](https://pnpm.io/catalogs) -- version catalog protocol (HIGH confidence, official docs)
- [pnpm Workspaces documentation](https://pnpm.io/workspaces) -- workspace configuration (HIGH confidence)
- [Turborepo best practices](https://github.com/vercel/turborepo/blob/main/skills/turborepo/references/best-practices/structure.md) -- official structure guide (HIGH confidence)
- [Turborepo CI construction guide](https://turborepo.dev/docs/crafting-your-repository/constructing-ci) -- pipeline patterns (HIGH confidence)
- [Complete Monorepo Guide: pnpm + Workspace (2025)](https://jsdev.space/complete-monorepo-guide/) -- community practices (MEDIUM confidence)
- [NestJS + pnpm monorepo patterns](https://gist.github.com/leandroluk/ead95513d3666326d364248ae98eb2e3) -- NestJS-specific setup (MEDIUM confidence)
- [Sharing Types Between React ESM and NestJS CJS in pnpm Monorepo](https://dev.to/lico/step-by-step-guide-sharing-types-and-values-between-react-esm-and-nestjs-cjs-in-a-pnpm-monorepo-2o2j) -- CJS/ESM interop (MEDIUM confidence)
- [Docker Compose profiles](https://docs.docker.com/compose/profiles/) -- service profiles (HIGH confidence, official docs)
- [n8n self-hosted AI starter kit](https://github.com/n8n-io/self-hosted-ai-starter-kit/blob/main/docker-compose.yml) -- Ollama + Qdrant compose example (MEDIUM confidence)
- [Mastering pnpm Workspaces (2025)](https://blog.glen-thomas.com/software%20engineering/2025/10/02/mastering-pnpm-workspaces-complete-guide-to-monorepo-management.html) -- .npmrc and hoisting patterns (MEDIUM confidence)
- Botmem codebase analysis: `package.json`, `turbo.json`, `pnpm-workspace.yaml`, `docker-compose.yml`, `tsconfig.base.json`, `apps/api/nodemon.json`, `apps/api/package.json`, all package configs

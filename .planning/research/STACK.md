# Technology Stack: Monorepo & Developer Experience

**Project:** Botmem v3.0 Monorepo & Developer Experience
**Researched:** 2026-03-08
**Focus:** Stack additions/changes for proper monorepo setup, NOT re-evaluating existing stack

## Current State Assessment

The monorepo works but has accumulated technical debt:

- **pnpm 9.15** with basic workspace config, no catalogs, duplicate version specifiers across 10+ package.json files
- **Turborepo 2.4** with minimal turbo.json (no watch mode, no remote caching, no inputs/outputs optimization)
- **No linting config** at all -- no ESLint, no Prettier, no shared configs
- **No pre-commit hooks** -- no Husky, no lint-staged, no build gates
- **Docker Compose** only has Redis + Qdrant for self-hosting, no dev profile
- **TypeScript** uses tsconfig.base.json inheritance but API overrides to CommonJS (NestJS requirement), no project references
- **Dev script** is a workaround: builds connectors first, then runs turbo dev on only API + shared -- a sign of missing proper task dependencies
- **Duplicate devDependencies**: `typescript`, `vitest` appear in every package.json instead of being managed centrally

## Recommended Stack Additions

### 1. pnpm Catalogs (Stay on pnpm 9.15, add catalogs)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| pnpm | 9.15.x (keep current) | Package manager | pnpm 10 has breaking changes (no hoisting, lifecycle script restrictions) that add migration risk without proportional value. Catalogs work in 9.5+. Upgrade to 10 later when the ecosystem stabilizes. |

**What to add:** `catalog` field in `pnpm-workspace.yaml` to centralize version specifiers.

```yaml
# pnpm-workspace.yaml
packages:
  - "apps/*"
  - "packages/*"
  - "packages/connectors/*"

catalog:
  # Runtime
  typescript: "^5.7.0"
  # Testing
  vitest: "^3.0.0"
  "@vitest/coverage-v8": "^3.2.4"
  # Node types
  "@types/node": "^22.0.0"
```

Then in each package.json: `"typescript": "catalog:"` instead of `"^5.7.0"`.

**Why NOT pnpm 10:** pnpm 10 (released Jan 2025) removes default lifecycle script execution, stops hoisting ESLint/Prettier by default, and drops lockfile v6-to-v9 conversion. These are good long-term changes but add migration friction now. Catalogs already work in 9.5+, which is the feature we actually need. The `packageManager` field stays at `pnpm@9.15.0`.

**Confidence:** HIGH (catalogs are documented and stable in pnpm 9.x, verified via pnpm.io)

### 2. Turborepo Upgrade (2.4 -> 2.8)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| turbo | ^2.8.0 | Build orchestration | Gains watch mode caching (2.4 experimental -> stable), sidecar tasks (2.5), and accumulated bug fixes. Drop-in upgrade. |

**What to change in turbo.json:**

```jsonc
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "inputs": ["src/**", "tsconfig.json", "package.json"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true,
      "dependsOn": ["^build"]
    },
    "lint": {
      "dependsOn": ["^build"],
      "inputs": ["src/**", "eslint.config.mjs"]
    },
    "test": {
      "dependsOn": ["^build"],
      "inputs": ["src/**", "vitest.config.*"]
    },
    "test:coverage": {
      "dependsOn": ["^build"],
      "inputs": ["src/**"],
      "outputs": ["coverage/**"]
    },
    "typecheck": {
      "dependsOn": ["^build"],
      "inputs": ["src/**", "tsconfig.json"]
    }
  }
}
```

**Key additions:**
- `inputs` on every task: prevents cache invalidation from unrelated file changes
- `dependsOn: ["^build"]` on `dev`: fixes the current hack where `pnpm dev` manually builds connectors first
- `typecheck` task: separate from build for use in pre-commit/pre-push hooks
- Use `turbo watch dev` instead of the current manual build-then-dev script

**Why NOT remote caching:** Single developer project. Remote caching (Vercel or self-hosted) adds complexity for zero benefit when there is one contributor. Revisit if team grows.

**Confidence:** HIGH (Turborepo 2.8.13 is current latest on npm, verified)

### 3. Docker Compose with Dev Profiles

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Docker Compose | v2 (bundled with Docker Desktop) | Service orchestration | Profiles separate dev infrastructure from production deployment |

**Architecture:** Two compose files, not one overloaded file.

```
docker-compose.yml          # Dev: Redis + Qdrant + Ollama (optional profile)
docker-compose.prod.yml     # Prod: already exists on VPS
```

**Dev compose with profiles:**

```yaml
services:
  redis:
    image: redis:7-alpine
    ports:
      - "${REDIS_PORT:-6379}:6379"
    volumes:
      - redis-data:/data

  qdrant:
    image: qdrant/qdrant:v1.13.2  # Pin version, not :latest
    ports:
      - "${QDRANT_HTTP_PORT:-6333}:6333"
      - "${QDRANT_GRPC_PORT:-6334}:6334"
    volumes:
      - qdrant-data:/qdrant/storage

  ollama:
    image: ollama/ollama:0.6.2  # Pin version
    profiles: ["ollama"]  # Only starts with --profile ollama
    ports:
      - "${OLLAMA_PORT:-11434}:11434"
    volumes:
      - ollama-data:/root/.ollama
    environment:
      - OLLAMA_MAX_CONCURRENT_REQUESTS=2
    restart: unless-stopped
    # GPU support (uncomment if available):
    # deploy:
    #   resources:
    #     reservations:
    #       devices:
    #         - driver: nvidia
    #           count: 1
    #           capabilities: [gpu]

volumes:
  redis-data:
  qdrant-data:
  ollama-data:
```

**Why Ollama is a profile, not default:** The project already uses a remote Ollama instance (192.168.10.250). Making Ollama a profile means `docker compose up` starts Redis + Qdrant (what you always need), and `docker compose --profile ollama up` adds local Ollama for people without a remote GPU.

**Why pin versions:** Qdrant and Ollama have had breaking changes between minor versions. `:latest` in dev means "works on my machine" problems.

**Confidence:** HIGH (Docker Compose profiles are stable and well-documented)

### 4. Build Pipeline Gates (Husky + lint-staged)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| husky | ^9.1.7 | Git hooks management | De facto standard, zero-config, stable (no updates needed in 12+ months = mature) |
| lint-staged | ^16.3.0 | Run tasks on staged files only | Latest version, actively maintained, fast |

**Pre-commit hook strategy:**

```bash
# .husky/pre-commit
pnpm lint-staged
```

**Root lint-staged config (package.json or .lintstagedrc):**

```json
{
  "*.{ts,tsx}": ["eslint --fix", "prettier --write"],
  "*.{json,md,yml,yaml}": ["prettier --write"]
}
```

**Pre-push hook (heavier checks):**

```bash
# .husky/pre-push
turbo typecheck
turbo test --filter='...[HEAD~1]'
```

**Why lint-staged at root, not per-package:** lint-staged automatically uses the config closest to a staged file. Start with root config; add per-package configs only if different packages need different rules (unlikely for this project).

**Why NOT commitlint/conventional commits:** Overhead without proportional value for a single-developer project. The commit history shows clear, descriptive messages already. Add later if team grows.

**Confidence:** HIGH (husky 9.x and lint-staged 16.x are well-established)

### 5. TypeScript Configuration Strategy

| Decision | Recommendation | Why |
|----------|---------------|-----|
| Project references | **Do NOT add** | Maintenance burden of manually managing `references` arrays across 10+ packages outweighs compile-time benefit for a project this size. The current `extends` + `tsconfig.base.json` pattern is correct. |
| tsconfig paths | **Keep for web only** | Web app already uses paths for `@/*` alias via Vite resolution. API uses workspace imports which resolve through pnpm. |
| Base config | **Keep tsconfig.base.json** | Already works. Do NOT create a `@botmem/tsconfig` package -- it adds indirection for a single base file that `extends` handles fine. |
| Separate typecheck task | **Add to turbo.json** | `tsc --noEmit` as a standalone turbo task enables pre-push type checking without rebuilding |

**What to fix in existing tsconfigs:**

The API tsconfig overrides `module: "commonjs"` and `moduleResolution: "node"` -- this is correct and required for NestJS with `emitDecoratorMetadata`. Do not change this. The base tsconfig sets `moduleResolution: "bundler"` which the API then overrides. This is fine -- NestJS is the exception, all other packages use the base config as-is.

**Add a `typecheck` script to every package:**

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```

**Confidence:** HIGH (based on direct analysis of existing tsconfig files and NestJS requirements)

### 6. Shared Linting & Formatting Config

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| eslint | ^9.0.0 | Linting | ESLint 9 with flat config is the current standard. ESLint 8 is EOL. |
| @eslint/js | ^9.0.0 | Base ESLint rules | Official recommended rules |
| typescript-eslint | ^8.0.0 | TypeScript ESLint support | Flat config compatible, replaces old @typescript-eslint packages |
| prettier | ^3.4.0 | Code formatting | Consistent formatting, no debates |
| eslint-config-prettier | ^10.0.0 | Disable ESLint rules that conflict with Prettier | Prevents ESLint/Prettier fights |

**Implementation: Single root config, NOT a shared package.**

For a single-developer project with 10 packages, creating a `@botmem/eslint-config` internal package is overengineering. Use a single `eslint.config.mjs` at the repo root.

```javascript
// eslint.config.mjs (root)
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**"],
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  }
);
```

```json
// .prettierrc (root)
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2
}
```

**Why NOT a shared config package:** Internal config packages (`packages/eslint-config`) make sense when you have multiple repos or 5+ developers who need to stay in sync. With one repo and one developer, a root config file achieves the same thing without the package boilerplate, build step, or version management.

**Confidence:** HIGH (ESLint 9 flat config is stable, typescript-eslint v8 supports it natively)

### 7. Dev Experience Improvements

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| turbo watch | (built into turbo ^2.8) | Dev mode orchestration | Replaces the current hack `dev` script. Dependency-aware: rebuilds packages when their deps change, then restarts consumers. |
| detect-port | already installed | Port conflict detection | Already in API deps. Use it properly at startup, not as a fallback. |

**Fix the dev script:**

Current (broken):
```json
"dev": "turbo build --filter='./packages/connectors/*' --filter=@botmem/connector-sdk --filter=@botmem/cli && turbo dev --filter=@botmem/shared --filter=@botmem/api --concurrency 10"
```

Fixed:
```json
"dev": "turbo watch dev --concurrency 20"
```

This works because `turbo.json` now has `dev.dependsOn: ["^build"]`, which means turbo automatically builds dependencies before starting dev servers. Watch mode re-runs when source files change.

**Port conflict fix:** The issue described in PROJECT.md ("file changes spawning competing instances") is likely caused by nodemon restarting the API while turbo also tries to restart it. The fix:

1. Use `turbo watch` instead of nodemon + turbo running concurrently
2. Or configure nodemon with `--signal SIGTERM` and a proper delay to avoid overlapping restarts
3. API startup should detect-port and fail fast with a clear error if port 12412 is already bound

**Why NOT concurrently:** `concurrently` is dependency-unaware. It starts everything simultaneously without knowing that the API depends on shared, which depends on connector-sdk. Turbo watch handles this natively.

**Confidence:** HIGH (turbo watch is stable since 2.0, the dev script analysis is from reading the actual package.json)

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Package manager | pnpm 9.15 (stay) | pnpm 10 | Breaking changes (hoisting, lifecycle scripts) add migration risk without needed features |
| Build orchestrator | Turborepo 2.8 | Nx | Already using Turbo, Nx migration is high-effort for marginal gain |
| Git hooks | Husky 9 | simple-git-hooks, lefthook | Husky is most widely used, best documented, good enough |
| Linting | ESLint 9 flat config | Biome | Biome is fast but ESLint ecosystem is broader, NestJS tooling expects ESLint |
| Formatting | Prettier 3 | Biome | Same as above -- ecosystem compatibility matters more than speed |
| Dev orchestration | turbo watch | concurrently, nodemon | turbo watch is dependency-aware, others are not |
| TS config sharing | Root tsconfig.base.json | @botmem/tsconfig package | Overengineered for single-repo project |
| Lint config sharing | Root eslint.config.mjs | @botmem/eslint-config package | Overengineered for single-repo project |
| Docker profiles | Compose profiles | Separate compose files per service | Profiles are cleaner, single file for dev |
| Project references | Do not add | Full TS project references | Maintenance burden exceeds compile-time savings at this scale |

## What NOT to Add

| Tool | Why Skip |
|------|----------|
| Changesets | Single developer, no need for automated changelog/versioning |
| Commitlint / Conventional Commits | Commit messages are already clear, adds friction without team benefit |
| Remote caching (Vercel) | Single developer, local caching is sufficient |
| @botmem/tsconfig package | One base file with `extends` is simpler |
| @botmem/eslint-config package | Root config file is simpler |
| pnpm 10 upgrade | Breaking changes not worth the migration cost right now |
| Nx | Already invested in Turborepo, switching has no ROI |
| Docker Compose watch mode | API runs outside Docker in dev (faster iteration), Docker is for infrastructure services only |
| Monorepo-wide vitest config | Each package having its own vitest config is correct for different test environments (Node vs jsdom) |

## Installation

```bash
# Dev tooling (root devDependencies)
pnpm add -Dw turbo@^2.8.0 husky@^9.1.7 lint-staged@^16.3.0

# Linting & formatting (root devDependencies)
pnpm add -Dw eslint@^9.0.0 @eslint/js@^9.0.0 typescript-eslint@^8.0.0 prettier@^3.4.0 eslint-config-prettier@^10.0.0

# Initialize husky
pnpm exec husky init
```

Note: `typescript` and `vitest` should be moved to the pnpm catalog and referenced as `"typescript": "catalog:"` in each package.json, rather than duplicated with explicit version ranges.

## Migration Order

1. **Add pnpm catalogs** to `pnpm-workspace.yaml`, update package.json files to use `catalog:` protocol
2. **Upgrade turbo** to 2.8, update `turbo.json` with inputs/outputs/dependsOn
3. **Fix dev script** to use `turbo watch dev`
4. **Add ESLint 9 + Prettier** root configs, add `lint` scripts to packages
5. **Add Husky + lint-staged** for pre-commit hooks
6. **Update Docker Compose** with pinned versions and Ollama profile
7. **Add typecheck task** and pre-push hook

## Sources

- [pnpm Catalogs documentation](https://pnpm.io/catalogs) -- HIGH confidence
- [pnpm 10 breaking changes discussion](https://github.com/orgs/pnpm/discussions/8945) -- HIGH confidence
- [Turborepo 2.4 blog post](https://turborepo.dev/blog/turbo-2-4) -- HIGH confidence
- [Turborepo 2.5 blog post](https://turborepo.com/blog/turbo-2-5) -- HIGH confidence
- [Turborepo watch mode docs](https://turborepo.dev/docs/reference/watch) -- HIGH confidence
- [Turborepo remote caching docs](https://turborepo.dev/docs/core-concepts/remote-caching) -- HIGH confidence
- [Husky documentation](https://typicode.github.io/husky/) -- HIGH confidence
- [lint-staged on npm](https://www.npmjs.com/package/lint-staged) -- HIGH confidence (v16.3.2 latest)
- [TypeScript project references vs paths (Nx blog)](https://nx.dev/blog/typescript-project-references) -- MEDIUM confidence (Nx-biased but analysis is sound)
- [ESLint flat config monorepo discussion](https://github.com/eslint/eslint/discussions/16960) -- MEDIUM confidence
- [Docker Compose profiles + GPU support guide](https://www.freecodecamp.org/news/how-to-use-docker-compose-for-production-workloads/) -- MEDIUM confidence
- [Ollama Docker deployment guide](https://www.sitepoint.com/ollama-local-llm-production-deployment-docker/) -- MEDIUM confidence

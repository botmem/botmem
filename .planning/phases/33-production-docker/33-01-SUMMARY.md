---
phase: 33-production-docker
plan: 01
subsystem: infra
tags: [docker, turbo-prune, multi-stage, pnpm, alpine]

# Dependency graph
requires:
  - phase: 32-build-optimization
    provides: pnpm catalogs and stable lockfile
  - phase: 30-dev-workflow-fix
    provides: health endpoint for container verification
provides:
  - Multi-stage Dockerfile with turbo prune for API-only images
  - .dockerignore for optimized build context
  - .npmrc with shamefully-hoist for NestJS Docker compatibility
  - ServeStaticModule guarded with existsSync for API-only deploys
affects: [production-deployment, ci-cd]

# Tech tracking
tech-stack:
  added: [turbo-prune, multi-stage-docker]
  patterns: [turbo-prune-docker, workspace-aware-dockerfile, existsSync-guard]

key-files:
  created:
    - Dockerfile
    - .dockerignore
    - .npmrc
  modified:
    - apps/api/package.json
    - apps/api/src/app.module.ts

key-decisions:
  - 'ServeStaticModule guarded with existsSync instead of NODE_ENV alone -- supports API-only Docker images'
  - '4-stage build with separate prod-deps prune to minimize final image node_modules'
  - '--ignore-scripts + selective rebuild for native modules to skip husky in Docker'
  - 'Copy workspace packages (shared, connector-sdk, connectors) to runner for module resolution'

patterns-established:
  - 'turbo prune --docker: Use for workspace-scoped Docker builds, copy tsconfig.base.json separately'
  - 'pnpm in Docker: PNPM_HOME env var + shamefully-hoist=true required for NestJS'
  - 'Non-root user: nestjs user (uid 1001) in production containers'

requirements-completed: [BUILD-02]

# Metrics
duration: 22min
completed: 2026-03-09
---

# Phase 33 Plan 01: Production Docker Summary

**Multi-stage Dockerfile with turbo prune producing API-only container that starts and serves /api/health**

## Performance

- **Duration:** 22 min
- **Started:** 2026-03-08T20:00:51Z
- **Completed:** 2026-03-08T20:22:51Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments

- Removed @botmem/web dependency from API package, enabling turbo prune to exclude web app entirely
- Created 4-stage multi-stage Dockerfile: base (node+pnpm+turbo), pruner (turbo prune), builder (compile), runner (minimal)
- Container starts on port 12412 and responds to GET /api/health with all services connected
- ServeStaticModule now guarded with existsSync so API starts cleanly whether web/dist exists or not

## Task Commits

Each task was committed atomically:

1. **Task 1: Remove @botmem/web dependency and guard ServeStaticModule** - `167d400` (feat)
2. **Task 2: Create Dockerfile, .dockerignore, and .npmrc** - `7caf4c6` (feat)

## Files Created/Modified

- `Dockerfile` - 4-stage multi-stage build with turbo prune @botmem/api --docker
- `.dockerignore` - Excludes node_modules, .git, data, .env, .planning, .claude from build context
- `.npmrc` - Enables shamefully-hoist=true for NestJS module resolution in Docker
- `apps/api/package.json` - Removed @botmem/web workspace dependency
- `apps/api/src/app.module.ts` - ServeStaticModule guarded with existsSync check

## Decisions Made

- ServeStaticModule guarded with existsSync instead of NODE_ENV alone -- allows API-only containers to start without web/dist directory
- 4-stage build with in-place prod prune (rm node_modules + reinstall --prod) instead of separate prod-deps stage -- avoids double native module compilation
- --ignore-scripts skips husky prepare hook in Docker, then selective pnpm rebuild for better-sqlite3 and bcrypt native modules
- Workspace packages (shared, connector-sdk, connectors) copied to runner to preserve pnpm workspace symlink resolution
- PNPM_HOME env var set explicitly for global turbo install in Alpine

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] PNPM_HOME not set in Alpine**

- **Found during:** Task 2 (Dockerfile creation)
- **Issue:** pnpm add -g turbo failed because PNPM_HOME was not set in Alpine container
- **Fix:** Added ENV PNPM_HOME="/pnpm" and added to PATH
- **Committed in:** 7caf4c6

**2. [Rule 3 - Blocking] tsconfig.base.json missing from turbo prune output**

- **Found during:** Task 2 (Docker build)
- **Issue:** turbo prune --docker does not include root tsconfig.base.json, causing TS5083 compile error
- **Fix:** Added explicit COPY --from=pruner /app/tsconfig.base.json step
- **Committed in:** 7caf4c6

**3. [Rule 3 - Blocking] Husky prepare script fails in Docker**

- **Found during:** Task 2 (Docker build)
- **Issue:** pnpm install triggers root prepare script (husky) which is not available in Docker
- **Fix:** Used --ignore-scripts flag with selective pnpm rebuild for native modules
- **Committed in:** 7caf4c6

**4. [Rule 1 - Bug] Workspace packages not found at runtime**

- **Found during:** Task 2 (container test)
- **Issue:** Runner stage only had API dist + root node_modules, but @botmem/\* workspace symlinks pointed to missing package dirs
- **Fix:** Copy workspace package dist outputs (shared, connector-sdk, connectors) to runner
- **Committed in:** 7caf4c6

---

**Total deviations:** 4 auto-fixed (3 blocking, 1 bug)
**Impact on plan:** All fixes necessary for a working Docker build. No scope creep.

### Image Size Note

The production image is 823MB, exceeding the plan's 500MB target. This is because the production dependency tree includes heavy packages: googleapis (115MB), pdfjs-dist (27MB), canvas binaries (24MB), WhatsApp/Baileys (8MB). These are legitimate runtime dependencies of the connector packages. The 500MB estimate did not account for connector dependency weight. Reducing image size would require either dropping connectors from the Docker image or optimizing individual connector dependencies -- both are out of scope for this plan.

## Issues Encountered

- Multiple Docker build iterations required to resolve Alpine-specific issues (PNPM_HOME, husky, tsconfig resolution, workspace symlinks)
- Image size 823MB vs 500MB target due to heavy connector dependencies (googleapis, pdfjs, canvas) -- documented but not addressed as it requires connector dependency optimization

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- v3.0 Monorepo & Developer Experience milestone is now complete (all phases 29-33 done)
- Docker image can be deployed to VPS with existing docker-compose.prod.yml
- Future optimization: consider separate connector-less base image or lazy-loading connectors to reduce image size

---

_Phase: 33-production-docker_
_Completed: 2026-03-09_

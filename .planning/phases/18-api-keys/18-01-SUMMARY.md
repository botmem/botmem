# Phase 18, Plan 01 — Summary

**Completed:** 2026-03-08

## What was built

API key backend: schema, service, controller, dual auth guard, and read-only enforcement.

### Files created
- `apps/api/src/api-keys/api-keys.service.ts` — Key CRUD, SHA-256 hashing, validation, 10-key limit, name uniqueness
- `apps/api/src/api-keys/api-keys.controller.ts` — POST/GET/DELETE `/api-keys` with `@RequiresJwt()`
- `apps/api/src/api-keys/api-keys.module.ts` — `@Global()` module (so guard can inject service)
- `apps/api/src/api-keys/__tests__/api-keys.service.test.ts` — 14 tests covering all behaviors
- `apps/api/src/user-auth/decorators/requires-jwt.decorator.ts` — `@RequiresJwt()` metadata decorator

### Files modified
- `apps/api/src/db/schema.ts` — Added `apiKeys` table definition
- `apps/api/src/db/db.service.ts` — Added CREATE TABLE + indexes for api_keys
- `apps/api/src/user-auth/jwt-auth.guard.ts` — Dual auth: `bm_sk_` prefix → API key path, otherwise JWT
- `apps/api/src/user-auth/__tests__/global-guard.test.ts` — Updated for async canActivate + ApiKeysService injection
- `apps/api/src/app.module.ts` — Registered ApiKeysModule
- `apps/api/src/accounts/accounts.controller.ts` — `@RequiresJwt()` on POST, PATCH, DELETE
- `apps/api/src/memory/memory.controller.ts` — `@RequiresJwt()` on all mutation endpoints
- `apps/api/src/contacts/contacts.controller.ts` — `@RequiresJwt()` on all mutation endpoints
- `apps/api/src/jobs/jobs.controller.ts` — `@RequiresJwt()` on sync, retry-failed, cancel
- `apps/api/src/agent/agent.controller.ts` — `@RequiresJwt()` on ask, remember, forget, summarize
- `apps/api/src/settings/settings.controller.ts` — `@RequiresJwt()` on PATCH

## Test results
- 14/14 new API key service tests pass
- 3/3 existing guard tests pass (updated for new constructor signature)
- TypeScript compiles cleanly (`tsc --noEmit`)

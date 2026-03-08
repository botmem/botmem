# Phase 34: NestJS Best Practices Maturation - Context

**Gathered:** 2026-03-08
**Status:** Ready for planning
**Source:** Comprehensive NestJS audit (33 issues across 9 categories)

<domain>
## Phase Boundary

Bring the NestJS API up to best practices standards based on a full audit. Focus on the 8 critical/high-priority fixes that have the most impact on security, reliability, and maintainability. Lower-priority items (API versioning, lazy loading, repository pattern) are deferred.

This phase does NOT change business logic or features. It hardens the existing codebase.
</domain>

<decisions>
## Implementation Decisions

### Input Validation (Critical)
- Add `class-validator` and `class-transformer` dependencies
- Create DTO classes with validation decorators for ALL controller endpoints
- Enable global `ValidationPipe` with `whitelist: true, transform: true` in `main.ts`
- DTOs for: register, login, forgot-password, reset-password, search, account creation, contact update, agent ask/remember/summarize, memory-bank creation, api-key creation

### Rate Limiting (Critical)
- Install `@nestjs/throttler`
- Apply strict limits to auth endpoints (login: 5/min, register: 3/min, forgot-password: 3/min)
- Apply moderate limits to expensive AI endpoints (agent/ask, agent/summarize: 20/min)
- Apply generous limits to read endpoints (100/min default)
- Configure ThrottlerModule globally in AppModule

### Database Transactions (Critical)
- Wrap multi-table delete operations in SQLite transactions using `better-sqlite3` `.transaction()`
- Key locations: `accounts.service.ts:remove()`, `contacts.service.ts:mergeContacts()`, `memory.controller.ts:retryFailed()`
- Do NOT change single-table operations

### Structured Logging (High)
- Replace ALL `console.log/warn/error` (56 occurrences across 17 files) with NestJS `Logger`
- Each service/processor gets `private readonly logger = new Logger(ClassName.name)`
- Keep log messages identical — only change the mechanism
- Use appropriate levels: `.log()`, `.warn()`, `.error()`

### Security Hardening (High)
- Add production secret validation: fail startup if JWT_ACCESS_SECRET or APP_SECRET are default values when NODE_ENV=production
- Fix authorization gaps: `accounts.controller.ts:get()` must verify account belongs to user, `contacts.controller.ts:getSuggestions()` and `getMemories()` must filter by user
- Restrict admin/debug endpoints (`qdrant-info`, `queue-status`) to JWT-only (not API key)

### Error Handling Cleanup (High)
- Add error logging to empty catch blocks that currently swallow errors silently
- In processors (`embed`, `enrich`): convert `catch {}` to `catch (err) { this.logger.warn(...) }`
- Fix `agent.controller.ts`: use proper HTTP exceptions instead of returning `{ success: false }` with 200 status
- Do NOT add error handling where it isn't needed

### Claude's Discretion
- Exact DTO class structure and naming conventions
- Throttler storage backend (default in-memory is fine for now)
- Whether to put DTOs in separate files or alongside controllers
- Logger format customization (default NestJS format is fine)
</decisions>

<specifics>
## Specific References

### Files with empty catch blocks needing attention:
- `auth.service.ts:38` — credential parsing
- `embed.processor.ts:125, 207, 533` — memory bank, thread linking, auth context
- `enrich.processor.ts:115` — encryption
- `memory.controller.ts:279` — account auth lookup
- `jobs.controller.ts:154` — pipeline retry

### Authorization gaps:
- `accounts.controller.ts:30-33` — GET /:id doesn't check user ownership
- `contacts.controller.ts:28-29` — suggestions/memories not filtered by user
- `me.controller.ts:19` — GET /set uses GET for mutation
- `memory.controller.ts:207-210, 35-49` — qdrant-info and queue-status expose internals

### N+1 query patterns:
- `jobs.service.ts:43-51` — fetches all then filters in JS
- `jobs.controller.ts:50-57` — same pattern
</specifics>

<deferred>
## Deferred Ideas

- Repository pattern abstraction (arch-use-repository-pattern) — too large a refactor for this phase
- API versioning (api-versioning) — no external consumers yet
- Lazy module loading (perf-lazy-loading) — premature optimization
- Caching layer (perf-use-caching) — separate performance phase
- Migration system (db-use-migrations) — works fine with current approach
- Injection tokens for interfaces (di-use-interfaces-tokens) — low ROI
- Circular dependency resolution (arch-avoid-circular-deps) — risky refactor, forwardRef works
- God service splitting (arch-single-responsibility) — separate refactoring phase
- E2E tests (test-e2e-supertest) — separate testing phase
- Response DTOs / ClassSerializerInterceptor — can add when needed
</deferred>

---

*Phase: 34-nestjs-best-practices-maturation*
*Context gathered: 2026-03-08 via NestJS audit report*

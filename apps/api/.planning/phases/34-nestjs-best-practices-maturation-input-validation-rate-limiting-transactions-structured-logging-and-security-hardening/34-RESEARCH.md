# Phase 34: NestJS Best Practices Maturation - Research

**Researched:** 2026-03-08
**Domain:** NestJS hardening -- input validation, rate limiting, transactions, structured logging, security
**Confidence:** HIGH

## Summary

This phase addresses 6 categories of NestJS best practices issues identified in a 33-issue audit. The project runs NestJS 11.1.14 with better-sqlite3 (Drizzle ORM), BullMQ, and currently has no input validation (no `class-validator`, no `ValidationPipe`), no rate limiting (no `@nestjs/throttler`), inconsistent logging (56 `console.log/warn/error` calls across 17+ files), and several authorization gaps in controllers.

The codebase is well-structured with feature modules, but all controller endpoints accept raw `@Body()` objects without validation. Auth endpoints (`/user-auth/register`, `/user-auth/login`, `/user-auth/forgot-password`) are completely unprotected against brute-force. Multi-table delete operations (e.g., `accounts.service.ts:remove()`) run without transactions, risking partial deletes on failure. The agent controller returns `{ success: false, error }` with HTTP 200 status instead of proper HTTP exceptions.

**Primary recommendation:** Install `class-validator`, `class-transformer`, and `@nestjs/throttler` as new dependencies. Create DTOs in separate files within each feature module. Enable global `ValidationPipe` and `ThrottlerGuard` in `main.ts`/`AppModule`. Replace all `console.*` calls with NestJS `Logger`. Wrap multi-step DB operations in `better-sqlite3` transactions. Fix authorization gaps and error handling.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Add `class-validator` and `class-transformer` dependencies
- Create DTO classes with validation decorators for ALL controller endpoints
- Enable global `ValidationPipe` with `whitelist: true, transform: true` in `main.ts`
- DTOs for: register, login, forgot-password, reset-password, search, account creation, contact update, agent ask/remember/summarize, memory-bank creation, api-key creation
- Install `@nestjs/throttler`
- Apply strict limits to auth endpoints (login: 5/min, register: 3/min, forgot-password: 3/min)
- Apply moderate limits to expensive AI endpoints (agent/ask, agent/summarize: 20/min)
- Apply generous limits to read endpoints (100/min default)
- Configure ThrottlerModule globally in AppModule
- Wrap multi-table delete operations in SQLite transactions using `better-sqlite3` `.transaction()`
- Key transaction locations: `accounts.service.ts:remove()`, `contacts.service.ts:mergeContacts()`, `memory.controller.ts:retryFailed()`
- Do NOT change single-table operations
- Replace ALL `console.log/warn/error` (56 occurrences across 17 files) with NestJS `Logger`
- Each service/processor gets `private readonly logger = new Logger(ClassName.name)`
- Keep log messages identical -- only change the mechanism
- Use appropriate levels: `.log()`, `.warn()`, `.error()`
- Add production secret validation: fail startup if JWT_ACCESS_SECRET or APP_SECRET are default values when NODE_ENV=production
- Fix authorization gaps: `accounts.controller.ts:get()` must verify account belongs to user, `contacts.controller.ts:getSuggestions()` and `getMemories()` must filter by user
- Restrict admin/debug endpoints (`qdrant-info`, `queue-status`) to JWT-only (not API key)
- Add error logging to empty catch blocks that currently swallow errors silently
- Fix `agent.controller.ts`: use proper HTTP exceptions instead of returning `{ success: false }` with 200 status

### Claude's Discretion
- Exact DTO class structure and naming conventions
- Throttler storage backend (default in-memory is fine for now)
- Whether to put DTOs in separate files or alongside controllers
- Logger format customization (default NestJS format is fine)

### Deferred Ideas (OUT OF SCOPE)
- Repository pattern abstraction (arch-use-repository-pattern) -- too large a refactor for this phase
- API versioning (api-versioning) -- no external consumers yet
- Lazy module loading (perf-lazy-loading) -- premature optimization
- Caching layer (perf-use-caching) -- separate performance phase
- Migration system (db-use-migrations) -- works fine with current approach
- Injection tokens for interfaces (di-use-interfaces-tokens) -- low ROI
- Circular dependency resolution (arch-avoid-circular-deps) -- risky refactor, forwardRef works
- God service splitting (arch-single-responsibility) -- separate refactoring phase
- E2E tests (test-e2e-supertest) -- separate testing phase
- Response DTOs / ClassSerializerInterceptor -- can add when needed
</user_constraints>

## Standard Stack

### Core (New Dependencies)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| class-validator | ^0.14.1 | Decorator-based DTO validation | Official NestJS recommendation, works with ValidationPipe |
| class-transformer | ^0.5.1 | Type transformation for DTOs | Required by ValidationPipe for `transform: true` |
| @nestjs/throttler | ^6.4.0 | Rate limiting per-route | Official NestJS package, supports named throttlers and per-route overrides |

### Already Installed (Used As-Is)
| Library | Version | Purpose | Relevance |
|---------|---------|---------|-----------|
| @nestjs/common | 11.1.14 | Core framework (includes Logger, ValidationPipe) | Logger class used for structured logging |
| better-sqlite3 | ^11.0.0 | SQLite driver | `.transaction()` API for wrapping multi-step operations |
| drizzle-orm | ^0.38.0 | ORM | Transaction support via `db.transaction()` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| In-memory throttler storage | Redis throttler storage (`@nestjs/throttler-storage-redis`) | Only needed for multi-instance deployments; single-instance is fine |
| NestJS Logger | nestjs-pino | Pino is faster but adds complexity; NestJS Logger is sufficient for this codebase size |
| class-validator | zod + custom pipe | class-validator is the NestJS standard; zod requires custom pipe integration |

**Installation:**
```bash
cd apps/api && pnpm add class-validator class-transformer @nestjs/throttler
```

## Architecture Patterns

### Recommended DTO Structure
```
src/
  user-auth/
    dto/
      register.dto.ts
      login.dto.ts
      forgot-password.dto.ts
      reset-password.dto.ts
  accounts/
    dto/
      create-account.dto.ts
  contacts/
    dto/
      update-contact.dto.ts
      search-contacts.dto.ts
      split-contact.dto.ts
      merge-contact.dto.ts
      dismiss-suggestion.dto.ts
  agent/
    dto/
      ask.dto.ts
      remember.dto.ts
      summarize.dto.ts
  memory-banks/
    dto/
      create-memory-bank.dto.ts
      rename-memory-bank.dto.ts
  api-keys/
    dto/
      create-api-key.dto.ts
  memory/
    dto/
      search-memories.dto.ts
```

**Recommendation:** Put DTOs in a `dto/` subdirectory per module. This keeps controllers clean and DTOs reusable. Each DTO file is small (one class per file).

### Pattern 1: ValidationPipe Global Setup
**What:** Single global pipe handles all validation and transformation
**When to use:** Always -- applied once in `main.ts`
**Example:**
```typescript
// In main.ts, after app creation
import { ValidationPipe } from '@nestjs/common';

app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,        // Strip properties not in DTO
    transform: true,        // Auto-transform payloads to DTO instances
    transformOptions: {
      enableImplicitConversion: true,  // Convert string query params to numbers
    },
  }),
);
```

### Pattern 2: ThrottlerModule with Named Throttlers
**What:** Multiple named rate limits applied globally, overridden per-route
**When to use:** Always -- registered in AppModule, applied via APP_GUARD
**Example:**
```typescript
// In app.module.ts
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60000,   // 1 minute
        limit: 100,   // 100 requests per minute
      },
    ]),
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}

// Per-route override in controller
import { Throttle, SkipThrottle } from '@nestjs/throttler';

@Post('login')
@Throttle({ default: { limit: 5, ttl: 60000 } })  // 5 per minute
async login(@Body() dto: LoginDto) { ... }

// Skip throttling for health/version
@SkipThrottle()
@Get()
healthCheck() { return 'ok'; }
```

### Pattern 3: better-sqlite3 Transaction Wrapper
**What:** Wrap multi-table operations in synchronous transactions
**When to use:** Any operation that deletes/modifies across multiple tables
**Example:**
```typescript
// In accounts.service.ts:remove()
// Access raw sqlite handle via dbService.sqlite
async remove(id: string) {
  await this.getById(id); // throws if not found

  const db = this.dbService.db;
  const sqlite = this.dbService.sqlite;

  // Wrap everything in a transaction
  sqlite.transaction(() => {
    // ... all the delete operations using db.delete()...run()
  })();
}
```

Note: `contacts.service.ts:mergeContacts()` already uses `db.transaction()` correctly. The Drizzle `db.transaction()` and raw `sqlite.transaction()` both work -- use whichever matches the existing code style in each file.

### Pattern 4: NestJS Logger Usage
**What:** Replace console.* with Logger instance per class
**When to use:** Every service, controller, and processor
**Example:**
```typescript
import { Logger } from '@nestjs/common';

@Injectable()
export class EmbedProcessor {
  private readonly logger = new Logger(EmbedProcessor.name);

  // Before: console.warn('[embed worker]', err.message)
  // After:
  this.logger.warn(`Worker error: ${err.message}`);

  // Before: console.error('Contact resolution failed:', err)
  // After:
  this.logger.error('Contact resolution failed', err instanceof Error ? err.stack : String(err));
}
```

### Pattern 5: Production Secret Validation
**What:** Fail-fast on startup if production secrets are defaults
**When to use:** In ConfigService or bootstrap, when NODE_ENV=production
**Example:**
```typescript
// In config.service.ts, add a validate method
validateProductionSecrets() {
  if (process.env.NODE_ENV !== 'production') return;

  const defaults = [
    { name: 'APP_SECRET', value: this.appSecret, default: 'dev-app-secret-change-in-production' },
    { name: 'JWT_ACCESS_SECRET', value: this.jwtAccessSecret, default: 'dev-access-secret-change-in-production' },
    { name: 'JWT_REFRESH_SECRET', value: this.jwtRefreshSecret, default: 'dev-refresh-secret-change-in-production' },
  ];

  for (const { name, value, default: def } of defaults) {
    if (value === def) {
      throw new Error(`FATAL: ${name} is using default value in production. Set a secure value.`);
    }
  }
}
```

### Anti-Patterns to Avoid
- **Returning error objects with 200 status:** The agent controller returns `{ success: false, error: "..." }` with HTTP 200. Use `throw new BadRequestException()` or `throw new InternalServerErrorException()` instead.
- **Empty catch blocks:** `catch {}` hides errors silently. Always log at minimum: `catch (err) { this.logger.warn('...', err) }`.
- **GET for mutations:** `me.controller.ts:setSelfContact` uses `@Get('set')` for a mutation. Should be `@Post('set')` or `@Patch('set')`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Input validation | Manual `if (!body.email)` checks | `class-validator` decorators + `ValidationPipe` | Covers type coercion, nested objects, error messages automatically |
| Rate limiting | Custom middleware with counters | `@nestjs/throttler` | Handles IP tracking, TTL expiry, per-route overrides, WebSocket awareness |
| Request logging | Custom middleware with console.log | NestJS `Logger` class | Contextual class names, log levels, production-safe |
| Transaction management | Manual try/catch with rollback | `better-sqlite3 .transaction()` | Auto-rollback on throw, no partial state |

**Key insight:** NestJS has official solutions for all of these. Custom implementations miss edge cases (validation error formatting, throttler IP extraction behind proxies, transaction deadlock handling).

## Common Pitfalls

### Pitfall 1: ValidationPipe Not Transforming Query Params
**What goes wrong:** Query parameters remain strings even with `transform: true`
**Why it happens:** `enableImplicitConversion` must be set in `transformOptions`
**How to avoid:** Set `transformOptions: { enableImplicitConversion: true }` in ValidationPipe config
**Warning signs:** Query params like `?limit=10` arriving as string `"10"` in DTO

### Pitfall 2: ThrottlerGuard Blocks WebSocket Connections
**What goes wrong:** WebSocket connections get rate-limited or throw errors
**Why it happens:** ThrottlerGuard tries to extract HTTP context from WS connections
**How to avoid:** Use `@SkipThrottle()` on WebSocket gateways, or override `ThrottlerGuard.handleRequest()` to skip WS context
**Warning signs:** WebSocket connection failures after adding throttler

### Pitfall 3: Transaction Scope with Async Drizzle Operations
**What goes wrong:** Using `await` inside `sqlite.transaction()` breaks the transaction
**Why it happens:** `better-sqlite3` transactions are synchronous. The `.transaction()` method wraps a synchronous function.
**How to avoid:** Use synchronous `.all()`, `.run()`, `.get()` methods inside transactions, NOT `await`-ed Drizzle queries. The `accounts.service.ts:remove()` method already uses `.run()` -- keep this pattern.
**Warning signs:** "This statement has been garbage collected" or transaction not rolling back

### Pitfall 4: Class-Validator Not Working Due to Missing reflect-metadata
**What goes wrong:** Decorators are silently ignored
**Why it happens:** class-validator needs `reflect-metadata` at import time
**How to avoid:** Already handled -- `main.ts` line 1 imports `reflect-metadata`
**Warning signs:** DTOs pass validation even with invalid data

### Pitfall 5: Throttler Not Counting Correctly Behind Reverse Proxy
**What goes wrong:** All requests appear to come from same IP
**Why it happens:** Express sees proxy IP, not client IP
**How to avoid:** Set `app.set('trust proxy', 1)` in main.ts if behind Caddy/nginx (production)
**Warning signs:** Rate limit triggers too early or not at all

### Pitfall 6: Empty Catch Blocks Hiding Real Errors
**What goes wrong:** Operations silently fail, data becomes inconsistent
**Why it happens:** Previous developer used `catch {}` for "best-effort" operations
**How to avoid:** Replace with `catch (err) { this.logger.warn('...', err) }` -- still non-blocking, but visible
**Warning signs:** Data inconsistencies with no error logs

## Code Examples

### DTO with Validation Decorators
```typescript
// src/user-auth/dto/register.dto.ts
import { IsEmail, IsString, MinLength, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class RegisterDto {
  @IsEmail()
  @Transform(({ value }) => value?.toLowerCase().trim())
  email: string;

  @IsString()
  @MinLength(8)
  @MaxLength(100)
  password: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Transform(({ value }) => value?.trim())
  name: string;
}
```

### DTO for Agent Ask Endpoint
```typescript
// src/agent/dto/ask.dto.ts
import { IsString, IsOptional, IsInt, Min, Max, ValidateNested, IsNotEmpty } from 'class-validator';
import { Type } from 'class-transformer';

class AskFiltersDto {
  @IsOptional()
  @IsString()
  sourceType?: string;

  @IsOptional()
  @IsString()
  connectorType?: string;

  @IsOptional()
  @IsString()
  contactId?: string;
}

export class AskDto {
  @IsString()
  @IsNotEmpty()
  query: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AskFiltersDto)
  filters?: AskFiltersDto;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
```

### Agent Controller with Proper HTTP Exceptions
```typescript
// BEFORE (returns 200 with error body):
@Post('ask')
async ask(@Body() body: { query?: string }) {
  try {
    if (!body.query?.trim()) return fail('query is required');
    const result = await this.agentService.ask(body.query, {});
    return ok(result);
  } catch (err: any) {
    return fail(err.message || 'ask failed');
  }
}

// AFTER (uses HTTP exceptions, ValidationPipe handles missing query):
@Post('ask')
async ask(@Body() dto: AskDto) {
  // ValidationPipe rejects empty/missing query with 400 automatically
  const start = Date.now();
  const result = await this.agentService.ask(dto.query, {
    filters: dto.filters,
    limit: dto.limit,
  });
  const sources = [...new Set(result.results.map((r) => r.connectorType))];
  return ok(result, {
    queryTime: Date.now() - start,
    resultCount: result.results.length,
    sources,
  });
  // No try/catch needed -- NestJS global exception filter handles errors
}
```

### Transaction Wrapping for Account Removal
```typescript
// In accounts.service.ts
async remove(id: string) {
  await this.getById(id); // throws if not found

  const db = this.dbService.db;

  // Wrap all deletes in a transaction for atomicity
  db.transaction((tx) => {
    const accountMemories = tx
      .select({ id: memories.id })
      .from(memories)
      .where(eq(memories.accountId, id))
      .all();
    const memoryIds = accountMemories.map((m) => m.id);

    if (memoryIds.length > 0) {
      for (let i = 0; i < memoryIds.length; i += 500) {
        const batch = memoryIds.slice(i, i + 500);
        tx.delete(memoryContacts).where(inArray(memoryContacts.memoryId, batch)).run();
        tx.delete(memoryLinks).where(inArray(memoryLinks.srcMemoryId, batch)).run();
        tx.delete(memoryLinks).where(inArray(memoryLinks.dstMemoryId, batch)).run();
      }
    }

    tx.delete(memories).where(eq(memories.accountId, id)).run();
    tx.delete(rawEvents).where(eq(rawEvents.accountId, id)).run();
    tx.delete(logs).where(eq(logs.accountId, id)).run();
    tx.delete(jobs).where(eq(jobs.accountId, id)).run();
    tx.delete(accounts).where(eq(accounts.id, id)).run();
  });
}
```

### Authorization Fix for Account Get
```typescript
// In accounts.controller.ts
@Get(':id')
async get(
  @CurrentUser() user: { id: string },
  @Param('id') id: string,
) {
  const account = await this.accountsService.getById(id);
  if (account.userId !== user.id) {
    throw new ForbiddenException('Account does not belong to user');
  }
  return toApiAccount(account);
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `@nestjs/throttler` v4 (single config) | v6 (named throttlers array) | 2024 | Config format changed: `forRoot({ ttl, limit })` became `forRoot([{ name, ttl, limit }])` |
| `class-validator` `@IsUUID()` | Still current | Stable | No changes needed |
| `ValidationPipe({ transform: true })` | Still current in NestJS 11 | Stable | Same API since NestJS 9+ |
| `better-sqlite3` sync transactions | Still current | Stable | `.transaction()` returns a function that executes synchronously |

**Deprecated/outdated:**
- ThrottlerModule v4 single-config format: Use array format with named throttlers in v6+
- `@UseGuards(ThrottlerGuard)` per-controller: Use `APP_GUARD` for global application

## Open Questions

1. **WebSocket gateway throttling**
   - What we know: ThrottlerGuard may interfere with WebSocket connections via EventsGateway
   - What's unclear: Whether NestJS 11 ThrottlerGuard auto-skips WS context
   - Recommendation: Add `@SkipThrottle()` to EventsGateway proactively

2. **me.controller.ts GET-for-mutation**
   - What we know: `@Get('set')` is used for a mutation (`setSelfContact`)
   - What's unclear: Whether frontend relies on this being GET
   - Recommendation: Change to `@Post('set')` and update frontend call (small scope)

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 3 |
| Config file | `apps/api/vitest.config.ts` |
| Quick run command | `cd apps/api && pnpm test` |
| Full suite command | `cd apps/api && pnpm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| BP-01 | ValidationPipe rejects invalid input | unit | `cd apps/api && npx vitest run src/__tests__/validation.test.ts -x` | No -- Wave 0 |
| BP-02 | ThrottlerGuard limits auth endpoints | unit | `cd apps/api && npx vitest run src/__tests__/throttler.test.ts -x` | No -- Wave 0 |
| BP-03 | Account removal is transactional | unit | `cd apps/api && npx vitest run src/accounts/__tests__/accounts.service.test.ts -x` | Yes (extend) |
| BP-04 | console.log replaced with Logger | manual | `grep -rn 'console\.' src/ --include='*.ts' \| grep -v node_modules \| grep -v __tests__` | N/A -- lint check |
| BP-05 | Production secrets validated at startup | unit | `cd apps/api && npx vitest run src/config/__tests__/config.service.test.ts -x` | Yes (extend) |
| BP-06 | Account GET checks user ownership | unit | `cd apps/api && npx vitest run src/accounts/__tests__/accounts.controller.test.ts -x` | Yes (extend) |
| BP-07 | Agent controller throws HTTP exceptions | unit | `cd apps/api && npx vitest run src/agent/__tests__/agent.controller.test.ts -x` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `cd apps/api && pnpm test`
- **Per wave merge:** `cd apps/api && pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/__tests__/validation.test.ts` -- test ValidationPipe rejects bad DTOs
- [ ] `src/__tests__/throttler.test.ts` -- test ThrottlerGuard applies rate limits (may be manual verification)
- [ ] `src/agent/__tests__/agent.controller.test.ts` -- test proper HTTP exceptions

## Sources

### Primary (HIGH confidence)
- Project codebase analysis: `apps/api/src/` -- all controllers, services, processors examined
- NestJS skill rules: `.claude/skills/nestjs-best-practices/rules/` -- security-validate-all-input.md, security-rate-limiting.md, db-use-transactions.md, devops-use-logging.md
- `apps/api/package.json` -- confirmed NestJS 11.1.14, no class-validator/throttler installed

### Secondary (MEDIUM confidence)
- NestJS official documentation patterns for ValidationPipe, ThrottlerModule v6, Logger class
- better-sqlite3 transaction API (synchronous `.transaction()` wrapper)

### Tertiary (LOW confidence)
- None -- all findings verified against codebase and official docs

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- NestJS official packages, well-documented
- Architecture: HIGH -- Patterns verified against existing codebase structure
- Pitfalls: HIGH -- Transaction sync/async pitfall verified from existing code patterns; throttler WS issue documented
- Code examples: HIGH -- Based on actual project files and NestJS 11 API

**Research date:** 2026-03-08
**Valid until:** 2026-04-08 (stable libraries, 30-day validity)

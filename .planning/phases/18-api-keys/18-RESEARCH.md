# Phase 18: API Keys - Research

**Researched:** 2026-03-08
**Domain:** API key authentication, NestJS guard composition, Drizzle ORM schema extension
**Confidence:** HIGH

## Summary

Phase 18 adds named, read-only API keys for programmatic access (CLI, agents). The implementation spans three layers: a new `apiKeys` database table with SHA-256 hashed keys, a modified `JwtAuthGuard` that detects the `bm_sk_` prefix to route between JWT and API key auth paths, and a frontend Settings page extension with an API Keys tab for key CRUD. The existing codebase provides strong foundations -- the refresh token table already uses SHA-256 hashing, the `@Public()` decorator pattern directly informs the new `@RequiresJwt()` decorator, and the Settings page already exists with Profile and Pipeline sections that can be reorganized into tabs.

The critical design choice is dual-auth in a single guard: the global `JwtAuthGuard` (registered as `APP_GUARD`) intercepts all requests. When a Bearer token starts with `bm_sk_`, the guard bypasses Passport/JWT entirely and performs a direct SHA-256 hash lookup against the `apiKeys` table. The request context gets a reduced user object `{ userId, apiKeyId, scopes: ['read'], bankIds: [...] }` distinguishable from JWT sessions which carry `{ id, email }`.

**Primary recommendation:** Modify the existing `JwtAuthGuard` to handle both auth paths. Create a new `api-keys` NestJS module for key CRUD. Add `@RequiresJwt()` decorator to all mutation endpoints. Extend the Settings page with a Tabs component for Profile, API Keys, and Pipeline sections.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Key format: `bm_sk_` prefix + 32 hex chars (41 total), shown once at creation, stored as SHA-256 hash
- Maximum 10 keys per user
- Optional expiration date (no expiry = valid until revoked)
- Prefix detection on Bearer header: `bm_sk_` -> API key path, else -> JWT decode via Passport
- Single unified guard handles both auth methods
- API key requests get reduced context: `{ userId, apiKeyId, scopes: ['read'], bankIds: [...] }`
- Decorator-based read-only enforcement: `@RequiresJwt()` on mutation endpoints blocks API key access with 403
- `bankIds` column (nullable JSON array text) added now; `null` = access all data (Phase 18 default)
- Settings page with tabs: [Profile] [API Keys] [Security]
- Key names unique per user
- Create key: inline modal with name + optional expiry
- After creation: modal shows full key once with copy button + warning

### Claude's Discretion
- Settings page routing and navigation integration
- Exact modal styling and animation
- Error handling patterns (duplicate names, expired key cleanup)
- API endpoint naming and response shapes

### Deferred Ideas (OUT OF SCOPE)
- Bank scoping enforcement (non-nullable bankIds) -- Phase 19
- Rate limiting per API key -- v2.0 out of scope
- Key usage analytics/last-used tracking -- future enhancement
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| KEY-01 | Create multiple named API keys per user (cryptographic generation, stored hashed) | Schema table `apiKeys` with SHA-256 hash pattern from `refreshTokens`; `crypto.randomBytes(16).toString('hex')` for key generation; unique constraint on (userId, name) |
| KEY-02 | All API keys are read-only (search, list memories/contacts -- no writes, no sync, no delete) | `@RequiresJwt()` decorator on all mutation endpoints; guard checks `request.user.apiKeyId` presence to identify key-based auth |
| KEY-03 | Keys scoped to specific memory bank(s) at creation time | `bankIds` nullable JSON text column; Phase 18 defaults to null (no banks yet); Phase 19 will enforce non-null |
| KEY-04 | List and revoke API keys via authenticated endpoints | `GET /api-keys` returns list (name, masked key, created, expiry); `DELETE /api-keys/:id` sets `revokedAt`; both require JWT auth (not API key) |
| KEY-05 | API keys authenticate via `Authorization: Bearer <key>` header, coexist with JWT auth | Modified `JwtAuthGuard.canActivate()` checks `bm_sk_` prefix before delegating to Passport |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `crypto` (Node built-in) | N/A | SHA-256 hashing, `randomBytes` for key generation | Already used for refresh tokens; no external deps needed |
| `drizzle-orm` | existing | Schema definition for `apiKeys` table | Project standard ORM |
| `@nestjs/common` | existing | Decorators (`SetMetadata`), Guards, Controllers | Project framework |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| N/A | - | - | No new dependencies needed |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Custom prefix detection in guard | Passport custom strategy | Passport strategy adds complexity for simple hash lookup; direct guard modification is simpler and matches project patterns |
| UUID-based API keys | `bm_sk_` + hex | Prefix enables instant routing in the guard without attempting JWT decode first |

**Installation:**
```bash
# No new packages needed -- all functionality available from existing deps
```

## Architecture Patterns

### Recommended Project Structure
```
apps/api/src/
  api-keys/
    api-keys.module.ts         # NestJS module
    api-keys.controller.ts     # CRUD endpoints (JWT-only)
    api-keys.service.ts        # Business logic + DB operations
    __tests__/
      api-keys.service.test.ts
  user-auth/
    jwt-auth.guard.ts          # MODIFIED: dual auth (JWT + API key)
    decorators/
      public.decorator.ts      # EXISTING
      requires-jwt.decorator.ts # NEW: blocks API key access
      current-user.decorator.ts # EXISTING (works for both auth types)

apps/web/src/
  pages/
    SettingsPage.tsx            # MODIFIED: add tabs, extract sections
  components/
    settings/
      ApiKeysTab.tsx            # Key list + create/revoke
      CreateKeyModal.tsx        # Name + expiry input
      KeyCreatedModal.tsx       # Show key once + copy
    ui/
      Tabs.tsx                  # EXISTING: reuse for settings tabs
      Modal.tsx                 # EXISTING: reuse for key modals
  hooks/
    useApiKeys.ts              # API key CRUD hook
  store/
    apiKeyStore.ts             # Zustand store for API keys state
```

### Pattern 1: Dual Auth Guard
**What:** Single `JwtAuthGuard` handles both JWT tokens and API keys by checking Bearer token prefix
**When to use:** Every authenticated request
**Example:**
```typescript
// Modified JwtAuthGuard
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private reflector: Reflector,
    private apiKeysService: ApiKeysService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check @Public() first
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    // API key path: prefix detection
    if (authHeader?.startsWith('Bearer bm_sk_')) {
      const rawKey = authHeader.slice(7); // Remove "Bearer "
      const keyRecord = await this.apiKeysService.validateKey(rawKey);
      if (!keyRecord) return false;

      // Check @RequiresJwt() -- block API key access
      const requiresJwt = this.reflector.getAllAndOverride<boolean>(REQUIRES_JWT_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (requiresJwt) {
        throw new ForbiddenException('This endpoint requires full authentication');
      }

      // Set reduced user context
      request.user = {
        id: keyRecord.userId,
        apiKeyId: keyRecord.id,
        scopes: ['read'],
        bankIds: keyRecord.bankIds ? JSON.parse(keyRecord.bankIds) : null,
      };
      return true;
    }

    // JWT path: delegate to Passport
    return super.canActivate(context) as Promise<boolean>;
  }
}
```

### Pattern 2: @RequiresJwt Decorator
**What:** Metadata decorator that blocks API key access to mutation endpoints
**When to use:** On all POST/PATCH/DELETE endpoints that modify data
**Example:**
```typescript
// requires-jwt.decorator.ts
import { SetMetadata } from '@nestjs/common';
export const REQUIRES_JWT_KEY = 'requiresJwt';
export const RequiresJwt = () => SetMetadata(REQUIRES_JWT_KEY, true);

// Usage on controllers:
@RequiresJwt()
@Post('sync/:accountId')
async triggerSync(@Param('accountId') accountId: string) { ... }
```

### Pattern 3: API Key Generation
**What:** Cryptographically secure key with prefix, stored as SHA-256 hash
**When to use:** Key creation endpoint
**Example:**
```typescript
import { randomBytes, createHash } from 'crypto';

function generateApiKey(): { raw: string; hash: string } {
  const raw = `bm_sk_${randomBytes(16).toString('hex')}`;
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}
```

### Anti-Patterns to Avoid
- **Storing raw API keys:** Never persist the plaintext key. Only store the SHA-256 hash. Return the raw key exactly once at creation time.
- **Separate guard for API keys:** Don't create a second guard -- use the existing global `APP_GUARD` with prefix detection. Two guards create ordering issues.
- **API key self-management:** Don't allow API keys to create/delete other API keys. Key management endpoints must require JWT auth (`@RequiresJwt()`).
- **Timing-attack vulnerable comparison:** Use constant-time comparison (`timingSafeEqual`) when comparing key hashes, even though SHA-256 makes this less critical.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Cryptographic key generation | Custom random string | `crypto.randomBytes(16).toString('hex')` | Cryptographically secure; 128 bits of entropy |
| Hash computation | Custom hashing | `crypto.createHash('sha256')` | Standard, constant-time digest |
| Modal component | Custom overlay | Existing `Modal.tsx` component | Already styled with neobrutalist theme |
| Tab navigation | Custom tab switcher | Existing `Tabs.tsx` component | Already styled, handles active state |

## Common Pitfalls

### Pitfall 1: Guard Circular Dependency
**What goes wrong:** `JwtAuthGuard` depends on `ApiKeysService` which depends on `DbModule`, but `JwtAuthGuard` is provided as `APP_GUARD` in `AppModule`. NestJS may fail to resolve dependencies.
**Why it happens:** `APP_GUARD` providers are resolved at the module level where they're declared. If `ApiKeysService` isn't available in that scope, injection fails.
**How to avoid:** Either: (a) use `@Inject(forwardRef(() => ApiKeysService))` in the guard, or (b) make `ApiKeysModule` a global module that exports `ApiKeysService`, or (c) inject `ModuleRef` and resolve lazily. Approach (b) is cleanest -- mark with `@Global()`.
**Warning signs:** `Nest could not resolve dependencies of JwtAuthGuard` error at startup.

### Pitfall 2: Forgetting to Add @RequiresJwt to Mutation Endpoints
**What goes wrong:** An API key gains write access to an endpoint that should be restricted.
**Why it happens:** Developer adds a new POST endpoint but doesn't add the decorator.
**How to avoid:** Add `@RequiresJwt()` to every controller method that performs mutations. The audit list (from grep above) shows all POST/PATCH/DELETE endpoints that need it. The `search` endpoint is POST but is a read operation -- it should NOT get `@RequiresJwt()`.
**Warning signs:** API key successfully calling mutation endpoints in tests.

### Pitfall 3: Key Shown Multiple Times
**What goes wrong:** Raw key is returned on subsequent GET requests, defeating the security model.
**Why it happens:** Accidentally storing raw key or including hash in list response.
**How to avoid:** `POST /api-keys` returns `{ key: 'bm_sk_...', id, name }`. `GET /api-keys` returns `{ id, name, lastFour, createdAt, expiresAt }`. The raw key never exists after creation response.

### Pitfall 4: Settings Page Tab State
**What goes wrong:** Navigating away and back resets to the first tab, losing the user's place.
**Why it happens:** Tab state stored only in component state.
**How to avoid:** Use URL search params (`?tab=api-keys`) or keep it simple with local state since Settings page visits are short-lived.

### Pitfall 5: Expired Key Cleanup
**What goes wrong:** Expired keys accumulate in the database, and hash lookups get slower over time.
**Why it happens:** No cleanup mechanism for expired keys.
**How to avoid:** Check expiration during `validateKey()` -- reject expired keys at auth time. Optionally, add periodic cleanup but it's not required for correctness.

## Code Examples

### Database Schema Addition
```typescript
// In apps/api/src/db/schema.ts
export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull(),
  lastFour: text('last_four').notNull(),
  bankIds: text('bank_ids'), // nullable JSON array, null = all banks
  expiresAt: text('expires_at'), // nullable, null = never expires
  revokedAt: text('revoked_at'), // nullable, null = active
  createdAt: text('created_at').notNull(),
});
```

### SQL Table Creation (in db.service.ts)
```sql
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  last_four TEXT NOT NULL,
  bank_ids TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_user_name ON api_keys(user_id, name);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
```

### API Key Validation Service Method
```typescript
async validateKey(rawKey: string): Promise<ApiKeyRecord | null> {
  const hash = createHash('sha256').update(rawKey).digest('hex');
  const rows = await this.db.db
    .select()
    .from(apiKeys)
    .where(and(
      eq(apiKeys.keyHash, hash),
      isNull(apiKeys.revokedAt),
    ))
    .limit(1);

  const key = rows[0];
  if (!key) return null;

  // Check expiration
  if (key.expiresAt && new Date(key.expiresAt) < new Date()) {
    return null;
  }

  return key;
}
```

### Controller Endpoints
```typescript
@Controller('api-keys')
export class ApiKeysController {
  constructor(private apiKeysService: ApiKeysService) {}

  @RequiresJwt()
  @Post()
  async create(
    @CurrentUser() user: { id: string },
    @Body() body: { name: string; expiresAt?: string },
  ) {
    return this.apiKeysService.create(user.id, body.name, body.expiresAt);
  }

  @RequiresJwt()
  @Get()
  async list(@CurrentUser() user: { id: string }) {
    return this.apiKeysService.listByUser(user.id);
  }

  @RequiresJwt()
  @Delete(':id')
  async revoke(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    return this.apiKeysService.revoke(user.id, id);
  }
}
```

### Read-Only Endpoints (Accept Both JWT and API Key)
These endpoints do NOT get `@RequiresJwt()`:
- `GET /memories` -- list memories
- `GET /memories/:id` -- get memory by ID
- `GET /memories/stats` -- memory statistics
- `GET /memories/graph` -- graph data
- `POST /memories/search` -- search (POST but read-only)
- `GET /people` -- list contacts
- `GET /people/:id` -- get contact
- `POST /people/search` -- search contacts (POST but read-only)

### Mutation Endpoints (Require JWT, Get @RequiresJwt)
Full list from codebase grep:
- `POST /accounts` -- create account
- `PATCH /accounts/:id` -- update account
- `DELETE /accounts/:id` -- delete account
- `PATCH /settings` -- update settings
- `POST /auth/:type/initiate` -- initiate auth
- `POST /auth/:type/complete` -- complete auth
- `POST /memories/retry-failed` -- retry failed jobs
- `POST /memories/backfill-contacts` -- backfill
- `POST /memories/backfill-embeddings` -- backfill
- `POST /memories/relabel-unknown` -- relabel
- `POST /memories/:id/pin` -- pin memory
- `DELETE /memories/:id/pin` -- unpin memory
- `POST /memories/:id/recall` -- record recall
- `DELETE /memories/:id` -- delete memory
- `POST /memories/purge` -- purge all
- `POST /memories/vector-index/reset` -- reset vectors
- `POST /people/auto-merge` -- auto merge
- `POST /people/reclassify` -- reclassify
- `PATCH /people/:id` -- update contact
- `DELETE /people/:id` -- delete contact
- `DELETE /people/:id/identifiers/:identId` -- remove identifier
- `POST /people/:id/split` -- split contact
- `POST /people/:id/merge` -- merge contacts
- `POST /people/normalize` -- normalize
- `POST /people/suggestions/dismiss` -- dismiss
- `POST /people/suggestions/undismiss` -- undismiss
- `POST /jobs/sync/:accountId` -- trigger sync
- `POST /jobs/retry-failed` -- retry jobs
- `DELETE /jobs/:id` -- cancel job
- `POST /agent/ask` -- agent ask
- `POST /agent/remember` -- agent remember
- `DELETE /agent/forget/:id` -- agent forget
- `POST /agent/summarize` -- agent summarize
- `POST /api-keys` -- create key (self-referential JWT requirement)
- `GET /api-keys` -- list keys (JWT only -- key management)
- `DELETE /api-keys/:id` -- revoke key (JWT only)

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Separate API key guard | Unified guard with prefix detection | Current best practice | Single point of auth, no guard ordering issues |
| Storing encrypted keys | Storing SHA-256 hash only | Standard practice | Simpler, no decryption needed, one-way by design |
| Complex RBAC systems | Decorator-based scope control | NestJS convention | Lightweight, fits project's existing decorator patterns |

## Open Questions

1. **Should `POST /memories/search` and `POST /people/search` accept API keys?**
   - What we know: These are POST methods but perform read-only operations
   - What's unclear: CONTEXT.md says "search, list memories/contacts" are read-only -- implies these should accept API keys
   - Recommendation: YES, do not add `@RequiresJwt()` to search endpoints. They are read operations using POST for body params.

2. **Should key management endpoints (`GET/POST/DELETE /api-keys`) be accessible via API keys?**
   - What we know: CONTEXT.md says key management needs JWT auth
   - Recommendation: All `/api-keys` endpoints get `@RequiresJwt()`. API keys cannot manage themselves.

3. **What about the agent endpoints (`/agent/ask`)?**
   - What we know: `POST /agent/ask` is a read-like operation (queries memories), but also involves AI processing
   - Recommendation: Mark as `@RequiresJwt()` for now. Agent endpoints are write-like (they create summaries, remember things). Can be relaxed later if needed.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 3 |
| Config file | `apps/api/vitest.config.ts` (workspace-level) |
| Quick run command | `cd apps/api && npx vitest run src/api-keys --reporter=verbose` |
| Full suite command | `pnpm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| KEY-01 | Create API key, returns raw key once, stores hash | unit | `cd apps/api && npx vitest run src/api-keys/__tests__/api-keys.service.test.ts -x` | Wave 0 |
| KEY-01 | Max 10 keys per user enforced | unit | same file | Wave 0 |
| KEY-01 | Key names unique per user | unit | same file | Wave 0 |
| KEY-02 | Mutation endpoints return 403 for API key auth | unit | `cd apps/api && npx vitest run src/api-keys/__tests__/requires-jwt.test.ts -x` | Wave 0 |
| KEY-02 | Read endpoints (search, list) accept API key | unit | same file | Wave 0 |
| KEY-03 | bankIds stored as nullable JSON, null = all access | unit | `cd apps/api && npx vitest run src/api-keys/__tests__/api-keys.service.test.ts -x` | Wave 0 |
| KEY-04 | List keys returns masked data (no hash, no raw key) | unit | same file | Wave 0 |
| KEY-04 | Revoke key sets revokedAt, key no longer validates | unit | same file | Wave 0 |
| KEY-05 | Bearer bm_sk_ prefix routes to API key auth path | unit | `cd apps/api && npx vitest run src/api-keys/__tests__/dual-auth-guard.test.ts -x` | Wave 0 |
| KEY-05 | Bearer JWT token routes to Passport path | unit | same file | Wave 0 |
| KEY-05 | Expired key returns 401 | unit | same file | Wave 0 |

### Sampling Rate
- **Per task commit:** `cd apps/api && npx vitest run src/api-keys -x`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `apps/api/src/api-keys/__tests__/api-keys.service.test.ts` -- covers KEY-01, KEY-03, KEY-04
- [ ] `apps/api/src/api-keys/__tests__/dual-auth-guard.test.ts` -- covers KEY-05
- [ ] `apps/api/src/api-keys/__tests__/requires-jwt.test.ts` -- covers KEY-02

## Sources

### Primary (HIGH confidence)
- Project codebase: `apps/api/src/user-auth/jwt-auth.guard.ts` -- existing guard pattern
- Project codebase: `apps/api/src/user-auth/decorators/public.decorator.ts` -- decorator pattern for `@RequiresJwt()`
- Project codebase: `apps/api/src/db/schema.ts` -- Drizzle schema patterns, `refreshTokens` SHA-256 precedent
- Project codebase: `apps/api/src/db/db.service.ts` -- table creation + migration patterns
- Project codebase: `apps/api/src/user-auth/users.service.ts` -- DB operation patterns
- Project codebase: `apps/web/src/components/ui/Modal.tsx` -- existing modal component
- Project codebase: `apps/web/src/components/ui/Tabs.tsx` -- existing tabs component
- Project codebase: `apps/web/src/pages/SettingsPage.tsx` -- existing settings page to extend

### Secondary (MEDIUM confidence)
- Node.js `crypto` module docs -- `randomBytes`, `createHash` API (stable, well-known)
- NestJS guards documentation -- `APP_GUARD`, `Reflector`, `SetMetadata` patterns

### Tertiary (LOW confidence)
- None -- all findings verified from codebase

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies, all existing patterns
- Architecture: HIGH -- guard modification pattern verified from existing code, all integration points identified
- Pitfalls: HIGH -- circular dependency risk is well-known NestJS pattern; endpoint audit complete from codebase grep

**Research date:** 2026-03-08
**Valid until:** 2026-04-08 (stable -- no external deps, internal patterns only)

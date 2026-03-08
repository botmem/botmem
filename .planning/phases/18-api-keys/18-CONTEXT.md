# Phase 18: API Keys - Context

**Gathered:** 2026-03-08
**Status:** Ready for planning

<domain>
## Phase Boundary

Named, read-only API keys for programmatic access to memories and contacts. Users create keys via authenticated session, keys authenticate via Bearer header alongside JWT. Keys are scoped to memory bank(s) when banks exist (Phase 19). Covers KEY-01 through KEY-05.

</domain>

<decisions>
## Implementation Decisions

### Key format & display
- Prefix: `bm_sk_` followed by 32 cryptographically random hex characters (41 chars total)
- Full key shown only once at creation time with copy button and warning
- After creation, only last 4 characters visible (e.g., `bm_sk_...n4o5`)
- Key stored as SHA-256 hash in database (same pattern as refresh tokens)
- Maximum 10 keys per user
- Optional expiration date at creation time — key auto-invalidates after expiry; no expiry = valid until revoked

### Auth coexistence
- Prefix detection on `Authorization: Bearer` header: if value starts with `bm_sk_` → API key auth path (SHA-256 hash → DB lookup); otherwise → JWT decode via Passport
- Single unified guard handles both auth methods
- API key requests get reduced context: `{ userId, apiKeyId, scopes: ['read'], bankIds: [...] }` — distinguishable from JWT sessions which carry `{ id, email }`

### Read-only enforcement
- Decorator-based: `@RequiresJwt()` on mutation endpoints blocks API key access with 403
- Endpoints without the decorator accept both JWT and API key authentication
- Read-only scope covers: search, list memories, list contacts, get memory by ID

### Bank scoping
- `bankIds` column (nullable JSON array text) added to apiKeys table now
- `null` = access all user data (no scoping) — this is the Phase 18 default since banks don't exist yet
- Phase 19 will populate bankIds when bank selection UI is built
- **NOTE:** Remove bankIds nullability when Phase 19 memory banks are implemented — make bank scoping required

### Management UI
- Settings page with tabbed sections: [Profile] [API Keys] [Security]
- API Keys tab shows list of keys with name, masked key, created date, expiry, and Revoke button
- Shows count against limit (e.g., "3/10")
- Create key: inline modal with name field + optional expiry date picker
- After creation: modal shows full key once with copy button + "you won't see this again" warning
- Revoke: confirmation dialog before permanent revocation

### Claude's Discretion
- Settings page routing and navigation integration
- Exact modal styling and animation
- Error handling patterns (duplicate names, expired key cleanup)
- API endpoint naming and response shapes

</decisions>

<specifics>
## Specific Ideas

- When Phase 19 (Memory Banks) ships, bankIds must become non-nullable — add a migration to enforce bank scoping on all existing keys
- Key names should be unique per user to avoid confusion in the list
- The Settings page is new — this phase introduces it. Profile and Security tabs can be stubs for now.

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `JwtAuthGuard` (`apps/api/src/user-auth/jwt-auth.guard.ts`): Extend with prefix detection for dual auth
- `JwtStrategy` (`apps/api/src/user-auth/jwt.strategy.ts`): Bearer token extraction already in place
- `@Public()` decorator (`apps/api/src/user-auth/decorators/public.decorator.ts`): Pattern for `@RequiresJwt()` decorator
- SHA-256 hashing pattern from refresh token storage (`refreshTokens` table)
- `users` table with `id` field — foreign key target for apiKeys

### Established Patterns
- Drizzle ORM schema definitions in `apps/api/src/db/schema.ts` — add `apiKeys` table here
- NestJS module structure: controller + service + module per feature
- Zustand stores for frontend state management
- Modal patterns likely exist in connectors setup flow

### Integration Points
- `JwtAuthGuard` needs modification to support dual auth (JWT + API key)
- New `api-keys` module alongside existing `user-auth` module
- Frontend: new Settings page + route in React Router config
- Sidebar navigation needs Settings link added

</code_context>

<deferred>
## Deferred Ideas

- Bank scoping enforcement (non-nullable bankIds) — Phase 19
- Rate limiting per API key — noted in v2.0 out of scope, can add later
- Key usage analytics/last-used tracking — future enhancement

</deferred>

---

*Phase: 18-api-keys*
*Context gathered: 2026-03-08*

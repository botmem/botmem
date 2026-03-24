# Trust Boundaries, Components, and Data Flows

CASA Tier 2 self-attestation for ASVS 1.1.4, 1.4.1, 1.14.6.

## System Architecture

```
                         EXTERNAL ZONE
  +-----------------------------------------------------------+
  |  Browser (React 19)   Mobile Clients   AI Agents (CLI/MCP) |
  +----------------------------+------------------------------+
                               |
                          HTTPS (TLS 1.2+)
                               |
                         DMZ ZONE
  +----------------------------v------------------------------+
  |                    Caddy 2 (Alpine)                        |
  |  - Automatic TLS via Let's Encrypt (ACME)                 |
  |  - HSTS enforcement                                        |
  |  - Reverse proxy to NestJS API (:12412)                    |
  |  - Static docs serving                                     |
  +----------------------------+------------------------------+
                               |
                          HTTP (loopback)
                               |
                      APPLICATION ZONE
  +----------------------------v------------------------------+
  |                   NestJS 11 API                            |
  |                                                            |
  |  Guards (authentication):                                  |
  |    AuthProviderGuard  -> routes to Firebase or JWT guard   |
  |    FirebaseAuthGuard  -> Firebase ID token verification    |
  |    JwtAuthGuard       -> JWT access token + API key auth   |
  |    WriteScopeGuard    -> enforces write permissions         |
  |    PlanGuard          -> billing/plan enforcement           |
  |                                                            |
  |  Interceptors:                                             |
  |    RlsInterceptor     -> AsyncLocalStorage per-request     |
  |                          user context for row-level        |
  |                          security on all DB queries         |
  |                                                            |
  |  Global pipes:                                             |
  |    ValidationPipe     -> whitelist + transform input       |
  |                          (rejects unknown properties)      |
  |                                                            |
  |  Rate limiting:                                            |
  |    @nestjs/throttler   -> 60s window, configurable limits  |
  |                                                            |
  |  CORS:                                                     |
  |    Origin whitelist from FRONTEND_URL env var              |
  +----+----------+----------+----------+---------------------+
       |          |          |          |
       v          v          v          v
                       DATA ZONE
  +-----------------------------------------------------------+
  |  PostgreSQL 16    Redis 7.4     Typesense 30   Qdrant     |
  |  (Drizzle ORM)    (BullMQ +     (BM25 +       (Vector     |
  |                    DEK cache)    vector)        search)    |
  |                                                            |
  |  All services on internal Docker network (no port expose)  |
  |  Only API container can reach data services                |
  +-----------------------------------------------------------+
```

## Access Control Enforcement Points

### Authentication Layer

All routes pass through `AuthProviderGuard` (registered as global `APP_GUARD`), which delegates to either `FirebaseAuthGuard` or `JwtAuthGuard` based on the `AUTH_PROVIDER` environment variable.

Both guards also accept API keys (`bm_sk_...` prefix). API key validation:

- SHA-256 hash lookup in `api_keys` table
- Expiration check
- Revocation check (`revoked_at IS NULL`)
- Memory bank scoping: keys carry optional `memory_bank_ids` JSON; queries are restricted to those banks

Public endpoints (`/api/version`, `/api/health`, `/.well-known/*`) are excluded via `@Public()` decorator.

### Authorization Layer

- **WriteScopeGuard** (global `APP_GUARD`): enforces write permissions on mutating endpoints.
- **PlanGuard** (global `APP_GUARD`): enforces billing plan limits.
- **RlsInterceptor** (global `APP_INTERCEPTOR`): wraps every authenticated HTTP request in an `AsyncLocalStorage` context carrying `userId`. All database queries go through `DbService.withCurrentUser()`, which filters by `userId` column -- preventing cross-user data access at the ORM level.

### Input Validation

- `ValidationPipe` with `whitelist: true` strips unknown properties from all request bodies.
- `class-validator` decorators enforce type, length, and format constraints on DTOs.
- `class-transformer` with `enableImplicitConversion` handles type coercion.

## OAuth Flow Data Path

```
Browser -> GET /api/auth/:connectorType/initiate
        -> API creates OAuth state (CSRF token stored in Redis, 10min TTL)
        -> 302 redirect to provider (Google, Slack, etc.)
        -> Provider callback: GET /api/auth/:connectorType/callback?code=...&state=...
        -> API validates state token (Redis lookup + delete)
        -> Exchanges code for tokens via provider SDK
        -> Tokens encrypted with AES-256-GCM (APP_SECRET derived key)
        -> Stored in accounts.auth_context (encrypted text column)
        -> Redirect to frontend with success/error status
```

## Memory Ingestion Pipeline Data Path

```
Connector.sync(ctx)
  |
  v
[rawEvents table] -- immutable payload store, encrypted text
  |
  v
[sync queue] SyncProcessor
  - Orchestrates connector.sync()
  - Writes raw events to PostgreSQL
  - Enqueues clean jobs
  |
  v
[clean queue] CleanProcessor
  - Parses raw event payload
  - Extracts clean text
  - Enqueues embed jobs
  |
  v
[embed queue] EmbedProcessor
  - Creates Memory record in PostgreSQL
  - Generates embedding via AI backend (Ollama/OpenRouter/Gemini)
  - Resolves participants -> People (dedup by email/phone/handle)
  - Enqueues enrich job
  |
  v
[enrich queue] EnrichProcessor (48 retries, exponential backoff from 30s)
  - Extracts entities via AI (text or vision-language model)
  - Extracts claims
  - Classifies factuality (FACT / UNVERIFIED / FICTION)
  - Computes importance baseline
  - Encrypts memory fields (text, entities, claims, metadata) with per-user DEK
  - Upserts document to Typesense collection
  - Marks memory as pipeline_complete
```

## BullMQ Queue Isolation

Queues registered in MemoryModule:

- `clean` -- text extraction from raw events
- `embed` -- embedding generation + contact resolution
- `enrich` -- entity/claim extraction + encryption + Typesense upsert (48 attempts, exponential backoff)
- `maintenance` -- decay processor, periodic tasks

Queues registered in JobsModule:

- `sync` -- connector synchronization orchestration

All queues share a single Redis instance but use separate BullMQ queue names, providing logical isolation. Each queue has its own processor class with independent concurrency and retry settings. Job payloads contain `accountId` and `memoryBankId` for user-scoped processing.

## Deprecated Technology Audit (CASA 1.14.6)

The application uses no deprecated client-side technologies:

- **No Flash, Shockwave, ActiveX, Silverlight, or NACL** -- confirmed absent from frontend codebase
- **Frontend stack**: React 19.2, Vite 6, Tailwind 4, ES modules only
- **No Java applets, browser plugins, or legacy NPAPI/PPAPI plugins**
- **No inline `<object>`, `<embed>`, or `<applet>` tags** in any HTML template
- **Build target**: ES2022 with modern ESNext module output
- All dependencies are actively maintained (verified via package.json)

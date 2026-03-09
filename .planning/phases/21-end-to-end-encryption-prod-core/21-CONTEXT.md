# Phase 21: End-to-End Encryption (Prod-Core) - Context

**Gathered:** 2026-03-09
**Status:** Ready for planning

<domain>
## Phase Boundary

Memory text and metadata are encrypted with a user-specific key derived from their password, ensuring that database theft alone cannot expose memory content. The server derives and holds user keys in memory only (never on disk/DB). Embedding vectors remain plaintext in Qdrant for semantic search. Password change triggers server-side batch re-encryption from old key to new key.

</domain>

<decisions>
## Implementation Decisions

### Key derivation & storage

- Argon2id via WASM library (`argon2-browser` or equivalent) for key derivation from user password
- Key derived on login (server-side), stored in server memory only (`Map<userId, Buffer>`)
- Key cached in browser IndexedDB for client-side decryption (cleared on logout)
- Key stays in server memory until server restart — no TTL, no eviction
- User keys are NEVER stored in database or on disk — memory only

### Encryption scope & pipeline

- E2EE is always-on for all users — no opt-in toggle
- Server runs full pipeline as today (embed + enrich via Ollama)
- After enrichment, server encrypts `text`, `entities`, `claims`, `metadata` with USER key (from in-memory Map)
- Embedding vectors remain plaintext in Qdrant — semantic search continues to work
- Replaces current APP_SECRET encryption of memory fields (APP_SECRET still used for wrapping credentials in accounts/connectorCredentials)
- If user key is NOT in server memory (server restarted, user hasn't logged in): sync jobs are QUEUED until user logs in and key is re-derived

### Sync pipeline change

- Current flow: enrich → encrypt with APP_SECRET → store
- New flow: enrich → encrypt with user key (from memory Map) → store
- If no user key available: job stays in queue, not processed
- On login: derive key → store in Map → resume queued jobs
- WhatsApp real-time messages: same rule — queue if no key, process when key available

### Reading/search flow

- User authenticates (JWT or API key)
- Server decrypts memory fields using in-memory user key
- Returns plaintext to browser
- API key auth: works only if user key is in server memory (from a prior login)

### Password change re-encryption

- Server-side batch re-encryption (server has both old key and derives new key)
- Track key version per memory for resumability (if interrupted, resume from last processed)
- Non-blocking: syncs and searches continue during re-encryption
- New memories encrypted with new key; search tries new key first, falls back to old key
- Silent background process — no UI progress indicator
- Password change returns immediately; re-encryption happens asynchronously

### Claude's Discretion

- Argon2id parameter tuning (memory cost, time cost, parallelism)
- In-memory key Map implementation details (cleanup, concurrency)
- Key version column naming and migration approach
- BullMQ queue pausing/resuming mechanism for "queue until login" behavior
- Exact re-encryption batch size and error handling per row

</decisions>

<specifics>
## Specific Ideas

- "User keys are never stored in DB, they're wrapped in memory" — keys exist only in server process memory
- "When storing data, keys can't be on disk, they have to remain in memory"
- "When reading, this only happens when user is around (via u/p auth or api key) at that point we can decrypt for search"
- Queue sync jobs when no key available rather than fallback to APP_SECRET encryption

</specifics>

<code_context>

## Existing Code Insights

### Reusable Assets

- `CryptoService` (apps/api/src/crypto/crypto.service.ts): AES-256-GCM encrypt/decrypt/isEncrypted — needs extension for per-user keys
- `encryptMemoryFields` / `decryptMemoryFields`: Already wired into embed.processor, enrich.processor, memory.service, backfill.processor
- BullMQ job queue infrastructure: sync, embed, enrich queues with progress tracking
- EventsGateway WebSocket for real-time updates (available if needed)
- Backfill processor pattern (Phase 27): batch processing with resumability via `enrichedAt` marker

### Established Patterns

- Encrypt on write, decrypt on read — already in place, just needs key source change (APP_SECRET → user key)
- OnModuleInit for startup validation
- BullMQ job pausing/resuming patterns available

### Integration Points

- `enrich.processor.ts:125`: Currently calls `crypto.encryptMemoryFields()` with APP_SECRET key — needs to use per-user key
- `embed.processor.ts:277`: Same encrypt call — needs per-user key
- `memory.service.ts`: Multiple `decryptMemoryFields()` calls — need per-user key
- `backfill.processor.ts`: Both encrypt and decrypt calls — needs per-user key
- `user-auth.service.ts`: Login flow — needs to derive and cache user key
- `auth.controller.ts`: Password change endpoint — needs to trigger re-encryption

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

_Phase: 21-end-to-end-encryption-prod-core_
_Context gathered: 2026-03-09_

# Security, Auth & Encryption Pitfalls for Botmem v2.0

**Domain:** JWT auth, E2EE, PostgreSQL RLS, SQLite-to-Postgres migration, encryption at rest, API keys, Firebase auth, CORS
**System:** Botmem (NestJS 11, Drizzle ORM, SQLite currently, migrating to PostgreSQL)
**Researched:** 2026-03-08
**Confidence:** HIGH (based on codebase analysis + real-world NestJS/PostgreSQL security incidents)

---

## 1. JWT Security Mistakes

### 1.1 Token Storage: localStorage is an XSS Target

**What goes wrong:** Storing JWTs in `localStorage` or `sessionStorage` exposes them to any JavaScript running on the page. A single XSS vulnerability (even via a third-party dependency) lets an attacker exfiltrate all tokens. This is the most common JWT vulnerability in SPAs.

**Severity:** CRITICAL

**Current risk in Botmem:** The frontend is React 19 with Zustand stores. The natural pattern is `authStore.setToken(jwt)` which persists to localStorage. Every npm dependency in the frontend bundle becomes an attack surface.

**Mitigation:**
- Store access tokens in `httpOnly`, `Secure`, `SameSite=Strict` cookies. Never expose them to JavaScript.
- If you must use localStorage (e.g., for SSR-less SPAs where cookies are awkward), use short-lived access tokens (5-15 min) and keep the refresh token in an httpOnly cookie.
- In NestJS, use `@nestjs/passport` with a cookie-based JWT strategy. Set cookies in the auth controller response, not in the response body.
- Zustand auth store should track "is authenticated" state, not hold the actual token.

### 1.2 Refresh Token Rotation: Race Conditions on Concurrent Requests

**What goes wrong:** With refresh token rotation (each refresh issues a new refresh token and invalidates the old one), concurrent API requests that both detect an expired access token will both attempt to refresh simultaneously. The first succeeds, invalidating the old refresh token. The second request's refresh fails because it sends the now-invalidated token. The user gets logged out randomly.

**Severity:** HIGH

**Mitigation:**
- Implement a token refresh mutex on the frontend: queue all requests that detect a 401, let exactly one perform the refresh, then replay the queued requests with the new token. Axios interceptors with a promise-based lock work well.
- On the backend, implement a grace period: when a refresh token is rotated, keep the old one valid for 10-30 seconds to handle in-flight requests.
- Alternatively, use refresh token families: track a chain of refresh tokens. If an old token in the family is reused after rotation, invalidate the entire family (indicates theft).

### 1.3 Token Revocation: JWTs Are Stateless By Design

**What goes wrong:** JWTs are self-contained -- the server does not need to check a database to validate them. This means you cannot "revoke" a JWT once issued. If a user logs out, changes their password, or has their account compromised, their existing tokens remain valid until they expire.

**Severity:** HIGH

**Mitigation:**
- Keep access token lifetime short (5-15 minutes). This limits the window of exposure.
- Maintain a server-side token blocklist (Redis set of revoked `jti` values) checked on every request. The blocklist only needs entries for tokens that have not yet expired.
- On password change or account compromise, invalidate all refresh tokens in the database and add any issued access token JTIs to the blocklist.
- For Botmem specifically: a Redis-backed blocklist is natural since Redis is already in the stack for BullMQ.

### 1.4 Algorithm Confusion: `none` and HS256/RS256 Mismatch

**What goes wrong:** Some JWT libraries accept `alg: "none"` (no signature) if not explicitly configured to reject it. Worse, if the server uses RS256 (asymmetric) but accepts HS256, an attacker can sign a token using the public key as the HMAC secret -- the server validates it because the public key is not secret.

**Severity:** CRITICAL

**Mitigation:**
- In `@nestjs/jwt` or `jsonwebtoken`, always specify `algorithms: ['RS256']` (or whichever single algorithm you chose) in the verification options. Never leave it as default.
- Use `jsonwebtoken` >= 9.x which rejects `alg: "none"` by default.
- Prefer RS256 (asymmetric) for production: the signing key stays on the auth server, verification uses a public key that can be distributed.
- For a single-server setup like Botmem, HS256 is acceptable but you must never expose the secret. RS256 becomes important if you add microservices or third-party token verification.

### 1.5 Clock Skew Between Services

**What goes wrong:** JWT `exp` and `iat` claims are Unix timestamps. If the auth server and the API server have different system clocks (even by 30 seconds), tokens may be rejected as expired immediately after issuance, or accepted after they should have expired.

**Severity:** LOW (single-server), MEDIUM (distributed)

**Mitigation:**
- Use NTP on all servers.
- Configure a `clockTolerance` of 30-60 seconds in the JWT verification options (`jsonwebtoken` supports this).
- For Firebase token verification, clock skew is especially important -- Firebase's servers are authoritative on time. See section 7.

---

## 2. E2EE Key Loss and Re-Encryption

### 2.1 Password-Derived Keys: Forgot Password = Lost Data

**What goes wrong:** If encryption keys are derived from the user's password (e.g., PBKDF2/Argon2 -> AES key), and the user forgets their password, there is no way to recover the encrypted data. This is by design in zero-knowledge systems, but users expect a "forgot password" flow. There is no good solution that preserves both zero-knowledge and recoverability.

**Severity:** CRITICAL (data loss)

**Current risk in Botmem:** The schema comments say `authContext` and `credentials` are "encrypted JSON" but the current code stores them as plaintext JSON strings -- encryption has not been implemented yet. When adding it, the key derivation strategy determines whether password reset causes data loss.

**Mitigation:**
- **Option A: Server-held key (recommended for Botmem).** Encrypt data with a server-managed `APP_SECRET`, not a password-derived key. Password reset does not affect encryption. The tradeoff: the server operator can decrypt data. For a self-hosted personal memory system, this is acceptable.
- **Option B: Key escrow.** Encrypt the user's key with a recovery key, store the recovery key encrypted with a separate passphrase or printed on paper. Adds UX complexity.
- **Option C: True zero-knowledge.** Accept that forgot-password = data loss. Warn users clearly. Provide a "download encrypted backup" feature so they can try brute-forcing their own password.
- For Botmem v2.0, Option A is strongly recommended. This is a personal tool, not a multi-tenant SaaS where the operator should not see user data.

### 2.2 Re-Encryption on Password Change: Race Conditions

**What goes wrong:** If the encryption key is derived from the password, changing the password requires re-encrypting every encrypted field with the new key. During re-encryption: (1) the system holds both old and new keys in memory, (2) some records are encrypted with the old key, some with the new, (3) if the process crashes midway, you have a mix of keys with no way to know which records use which key, (4) concurrent reads during re-encryption may get garbled data.

**Severity:** HIGH

**Mitigation:**
- Add a `keyVersion` column to every table with encrypted fields. On password change, encrypt new records with the new key version. Run a background migration to re-encrypt old records, checking `keyVersion` to know which key to use.
- Use a transaction for each row re-encryption. If the process crashes, un-migrated rows still have the old `keyVersion` and can be decrypted with the old key (which should be kept until migration completes).
- For Botmem with server-managed keys (Option A above): password change does NOT require re-encryption. Only changing `APP_SECRET` triggers re-encryption, which is an ops task, not a user action.

### 2.3 Performance of Re-Encrypting Large Datasets

**What goes wrong:** If Botmem has 100K+ memories with encrypted text fields, re-encrypting all of them is a multi-hour operation. During this time, the system must handle mixed encryption states, and if it is a blocking migration, the app is down.

**Severity:** MEDIUM

**Mitigation:**
- Use `keyVersion`-based lazy re-encryption: decrypt with the correct key version on read, re-encrypt with the new key on next write. Over time, all records migrate naturally.
- For bulk migration, process in batches of 100-500 records with small delays between batches to avoid starving other queries.
- Never make re-encryption a blocking migration. Always support reading both old and new key versions simultaneously.

---

## 3. PostgreSQL RLS Bypass Risks

### 3.1 Superuser and Table Owner Bypass RLS

**What goes wrong:** PostgreSQL RLS policies are NOT enforced for superusers or the table owner by default. If your application connects as the table owner (which is the default in most setups -- the user that ran `CREATE TABLE`), RLS policies do nothing. Every query sees all rows, defeating the entire purpose.

**Severity:** CRITICAL

**Mitigation:**
- Create a separate PostgreSQL role for the application (e.g., `botmem_app`) that is NOT the table owner and NOT a superuser.
- Run `ALTER TABLE memories FORCE ROW LEVEL SECURITY` on every table -- this makes RLS apply even to the table owner (belt-and-suspenders).
- Use a migration role (superuser or table owner) for schema changes and a restricted app role for runtime queries.
- In Drizzle ORM, configure the connection pool to use the restricted role. Migrations use a separate connection with the privileged role.

### 3.2 Drizzle ORM and Connection Pooling Bypass

**What goes wrong:** RLS policies typically rely on `SET LOCAL` session variables (e.g., `SET LOCAL app.current_user_id = '...'`) to identify the current user. With connection pooling (pgBouncer, Drizzle's pool), connections are shared. If you set a session variable on a pooled connection and another request reuses that connection, it may see the previous user's session variable, leaking data.

**Severity:** CRITICAL

**Mitigation:**
- Use `SET LOCAL` (transaction-scoped) instead of `SET` (session-scoped). Wrap every request in a transaction that sets the user context first.
- In NestJS with Drizzle, create a middleware or interceptor that wraps each request's database calls in a transaction: `BEGIN; SET LOCAL app.current_user_id = $1; ... queries ...; COMMIT;`
- Alternatively, use `RESET` at the end of each request to clear session variables.
- Test with concurrent requests from different users: fire 100 parallel requests from 2 users and verify no cross-user data leakage.

### 3.3 Forgotten Policies on New Tables

**What goes wrong:** RLS must be explicitly enabled per table (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`) and policies must be created. When a developer adds a new table (e.g., `api_keys`, `user_settings`), they may forget to add RLS policies. The new table is wide open -- all users see all rows.

**Severity:** HIGH

**Mitigation:**
- Add a CI check: query `pg_tables` for tables without RLS enabled and fail the build if any are found (excluding system tables and explicitly exempted tables like `migrations`).
- Use a helper function in the Drizzle migration system that automatically enables RLS and creates a default deny-all policy on every new table.
- Keep a checklist in the PR template: "Does this migration add new tables? Are RLS policies included?"

### 3.4 RLS and Migrations: Locking Issues

**What goes wrong:** Adding or modifying RLS policies requires `ALTER TABLE`, which takes an `ACCESS EXCLUSIVE` lock. On a table with active queries, this can block all reads and writes until the migration completes, causing downtime.

**Severity:** MEDIUM

**Mitigation:**
- Set a lock timeout on migration connections: `SET lock_timeout = '5s'`. If the lock is not acquired within 5 seconds, the migration fails and can be retried during a quieter period.
- For large tables, add policies during low-traffic windows.
- Test policy changes on a copy of the production schema before applying to production.

---

## 4. SQLite to PostgreSQL Migration Dangers

### 4.1 Type Differences: TEXT for Everything No Longer Works

**What goes wrong:** Botmem's SQLite schema stores everything as `text`: UUIDs, timestamps, JSON, booleans (as integers). PostgreSQL has proper types (`uuid`, `timestamptz`, `jsonb`, `boolean`). A naive migration that keeps `text` columns works but loses all the benefits of PostgreSQL (type safety, JSON operators, timestamp comparisons, indexing). But converting types during migration can fail on data that does not conform to the target type.

**Severity:** HIGH

**Mitigation:**
- Map types explicitly: `text('id')` -> `uuid('id')`, `text('created_at')` -> `timestamptz('created_at')`, `text('entities')` -> `jsonb('entities')`, `integer('pinned')` -> `boolean('pinned')`.
- Before migration, validate all existing data against target types: Are all IDs valid UUIDs? Are all timestamps valid ISO 8601? Is all JSON valid? Fix invalid data in SQLite BEFORE attempting the PostgreSQL import.
- Common failures: SQLite allows `NULL` in `NOT NULL` columns if the column was added with `ALTER TABLE` after rows existed. PostgreSQL does not. Scan for NULL values in supposedly NOT NULL columns.
- SQLite stores booleans as 0/1 integers. PostgreSQL `boolean` expects `true`/`false`. The migration must transform these.

### 4.2 NULL Handling Differences

**What goes wrong:** SQLite treats `NULL` loosely in comparisons and aggregates. `NULL = NULL` is still false in both, but SQLite's type affinity means some comparisons that work in SQLite fail silently in PostgreSQL. More critically, SQLite's `GROUP BY` treats NULLs as equal (groups them together), which PostgreSQL also does -- but SQLite's loose typing means values that are empty strings in SQLite might need to be NULL in PostgreSQL, changing query results.

**Severity:** MEDIUM

**Mitigation:**
- Audit all columns for empty string vs NULL semantics. In the current schema, `authContext` is nullable (`text('auth_context')`), but some code may set it to `''` instead of `null`. PostgreSQL queries with `WHERE auth_context IS NOT NULL` will return empty strings, which SQLite queries may have filtered out.
- Standardize: empty string = no value should be NULL. Run a cleanup pass before migration.

### 4.3 Date Format Inconsistencies

**What goes wrong:** Botmem stores timestamps as ISO 8601 text strings. Some connectors may produce timestamps with different formats (e.g., `2024-01-15T10:30:00.000Z` vs `2024-01-15 10:30:00` vs Unix epoch milliseconds as strings). SQLite does not care -- it is all just text. PostgreSQL `timestamptz` will reject malformed dates during insertion.

**Severity:** HIGH

**Mitigation:**
- Before migration, run a validation query on all timestamp columns: parse every value and identify non-conforming formats.
- Normalize all timestamps to ISO 8601 with timezone (`Z` suffix) in SQLite before exporting.
- In the new Drizzle PostgreSQL schema, use `timestamptz` (with timezone) everywhere. Store and query in UTC.
- Pay special attention to `eventTime` in memories -- this comes from connectors and may have inconsistent formats across connector types.

### 4.4 Dual-Driver Period: Data Drift

**What goes wrong:** During migration, you may run both SQLite and PostgreSQL simultaneously (SQLite for existing data, PostgreSQL for new data, with a migration worker moving data over). Any writes to SQLite during this period must also be replicated to PostgreSQL. If a sync job writes to SQLite while the migration worker is running, those records may be missed.

**Severity:** HIGH

**Mitigation:**
- Use a clear cutover strategy: stop all writes (pause sync queues, put API in read-only mode), migrate all data, switch the DB driver, resume writes. Downtime is acceptable for a personal tool.
- If zero-downtime is required: add a `migrated_at` column to SQLite. The migration worker processes rows where `migrated_at IS NULL`. After migration, any new writes go to BOTH databases. Once migration is complete, switch reads to PostgreSQL and stop writing to SQLite.
- Never run Drizzle migrations against both databases simultaneously. Pick one source of truth.

---

## 5. Encryption at Rest Pitfalls

### 5.1 Where to Store APP_SECRET

**What goes wrong:** The encryption key (`APP_SECRET`) must be stored somewhere. If it is in the `.env` file next to the database, an attacker who compromises the file system gets both the encrypted data and the key -- encryption provides zero benefit. If it is in an environment variable, it is visible in process listings, Docker inspect output, and CI logs.

**Severity:** CRITICAL

**Current risk in Botmem:** The schema comments say fields are "encrypted JSON" but no encryption is implemented. The `APP_SECRET` key management decision must be made before implementing encryption.

**Mitigation:**
- **Self-hosted (current Botmem):** Accept that the operator has access to the key. Store `APP_SECRET` in an environment variable, NOT in the `.env` file committed to git. On the VPS, use systemd credentials or Docker secrets.
- **Cloud deployment:** Use a secrets manager (AWS Secrets Manager, GCP Secret Manager, Vault). Never store the key in the application's file system.
- **Docker:** Use Docker secrets (`docker secret create`), not environment variables in `docker-compose.yml`. The secret is mounted as a file at `/run/secrets/app_secret` and is not visible in `docker inspect`.
- On the current Vultr VPS deployment: store the secret in `/etc/botmem/secret` with `chmod 600`, read it in the entrypoint script, and pass it as an environment variable to the container.

### 5.2 IV Reuse in AES-GCM: Catastrophic Failure

**What goes wrong:** AES-GCM requires a unique IV (nonce) for every encryption operation with the same key. If you reuse an IV, an attacker can XOR two ciphertexts to recover plaintext and forge authentication tags. This is not a theoretical attack -- it completely breaks AES-GCM's confidentiality and integrity guarantees.

**Severity:** CRITICAL

**Why this is easy to get wrong:** A developer might use a deterministic IV (e.g., hash of the record ID) thinking "same record, same IV is fine." But if the record is updated (re-encrypted with the same IV and key), the attacker gets two ciphertexts with the same IV and can recover both plaintexts.

**Mitigation:**
- Always generate a random 12-byte IV using `crypto.randomBytes(12)` for every encryption call.
- Prepend the IV to the ciphertext (IV is not secret, just unique). Store as `iv:ciphertext:authTag` or concatenate them.
- Never derive IVs from record IDs, timestamps, or counters unless you use a proper counter-based scheme with a separate counter per key.
- AES-GCM with a 96-bit random IV is safe for up to ~2^32 encryptions with the same key (birthday bound). For Botmem's scale (hundreds of thousands of records with updates), this is fine. If you exceed millions of encryption operations with the same key, rotate the key.
- Use `crypto.createCipheriv('aes-256-gcm', key, iv)` in Node.js. Always retrieve and verify the auth tag.

### 5.3 Authenticated Encryption vs Just Encryption

**What goes wrong:** Using AES-CBC (or AES-CTR) without authentication means an attacker can modify the ciphertext and the decryption will succeed with corrupted plaintext. The application may then process corrupted data without knowing it was tampered with. A padding oracle attack on AES-CBC can recover the entire plaintext.

**Severity:** HIGH

**Mitigation:**
- Always use authenticated encryption: AES-GCM (preferred) or ChaCha20-Poly1305.
- Never use AES-CBC or AES-CTR without an HMAC (encrypt-then-MAC). If you must use CBC, apply HMAC-SHA256 over the ciphertext and verify it BEFORE decrypting.
- In Node.js, `aes-256-gcm` is the correct choice. It provides both confidentiality and integrity.
- Verify the auth tag on decryption. If verification fails, throw an error -- do not return partially decrypted data.

### 5.4 Migrating from Plaintext to Encrypted: Zero-Downtime

**What goes wrong:** The current `authContext` and `credentials` columns are plaintext. Adding encryption requires: (1) deploying code that can write encrypted data, (2) migrating existing plaintext to encrypted, (3) deploying code that only reads encrypted data. If steps are done out of order, the app crashes trying to decrypt plaintext or encrypt already-encrypted data.

**Severity:** HIGH

**Mitigation:**
- Use a three-phase deployment:
  1. **Phase 1:** Deploy code that writes encrypted but reads both plaintext and encrypted. Add a `_encrypted` boolean column or use a prefix marker (e.g., `enc:` prefix on encrypted values).
  2. **Phase 2:** Run a migration job that encrypts all plaintext rows and sets the marker.
  3. **Phase 3:** Deploy code that only reads encrypted. Remove the plaintext fallback.
- Between Phase 1 and Phase 3, the system handles mixed states gracefully.
- Test the migration on a copy of the production database before running it live.
- For Botmem specifically: since it is a personal tool with a single instance, a maintenance window (stop server, migrate, restart) is simpler and less error-prone than zero-downtime migration.

---

## 6. API Key Security

### 6.1 Key Generation: Insufficient Randomness

**What goes wrong:** Using `Math.random()`, `uuid()`, or short random strings for API keys produces guessable or brute-forceable keys. `Math.random()` is not cryptographically secure. UUIDs (v4) have only 122 bits of randomness but are commonly mistaken for secrets.

**Severity:** HIGH

**Mitigation:**
- Use `crypto.randomBytes(32).toString('base64url')` for 256 bits of cryptographic randomness (43 characters, URL-safe).
- Prefix keys with a type identifier for easy rotation and identification: `bmem_live_` for production, `bmem_test_` for test keys. This also lets you grep logs for leaked keys.
- Show the key exactly once (on creation). Never store or display the full key after creation.

### 6.2 Key Storage: Hash, Do Not Encrypt

**What goes wrong:** Storing API keys in plaintext means a database breach exposes all keys. Storing them encrypted (AES) means the encryption key can decrypt all of them -- a single point of failure. The correct approach is hashing, but `bcrypt` is too slow for API key verification on every request (50-100ms per hash check).

**Severity:** HIGH

**Mitigation:**
- Hash API keys with SHA-256, not bcrypt. API keys have high entropy (256 bits from `crypto.randomBytes`), so they do not need bcrypt's slow hashing to resist brute force. SHA-256 is fast enough for per-request verification.
- Store: `sha256(key)` in the database. On each request, compute `sha256(provided_key)` and look it up.
- Store a non-secret key prefix (first 8 characters) in a separate column for display purposes ("Key ending in ...a3f2") and for indexed lookup to avoid scanning all keys.
- Never use bcrypt for API keys -- it is designed for low-entropy passwords, not high-entropy keys. The 50-100ms verification time would add unacceptable latency to every API request.

### 6.3 Key Rotation and Leaked Key Detection

**What goes wrong:** API keys are long-lived by nature. If a key leaks (committed to git, logged, shared in Slack), it remains valid until manually revoked. Most developers do not monitor for leaked keys.

**Severity:** MEDIUM

**Mitigation:**
- Support multiple active keys per user so they can rotate without downtime: create new key, update all clients, revoke old key.
- Add key expiration (optional, user-configurable). Default to no expiration for personal use, but support it.
- Log all API key usage (key prefix, endpoint, timestamp) so users can audit activity.
- For the `bmem_` prefix convention: GitHub's secret scanning can be configured to detect custom patterns. Register the `bmem_live_` pattern so GitHub alerts if a key is committed to any public repository.

### 6.4 Rate Limiting: API Keys Without Rate Limits Are DDoS Vectors

**What goes wrong:** An API key with no rate limit can be used to flood the Ollama inference endpoint (via search queries that trigger embeddings), exhaust Redis connections (via BullMQ job creation), or fill the SQLite/PostgreSQL database with malicious data.

**Severity:** MEDIUM

**Mitigation:**
- Implement per-key rate limiting using Redis (already in the stack). Use a sliding window counter: `INCR bmem:ratelimit:{keyPrefix}:{minute}` with `EXPIRE`.
- Default limits: 60 requests/minute for search, 10 requests/minute for sync triggers, 1000 requests/minute for read-only endpoints.
- Return `429 Too Many Requests` with `Retry-After` header.
- For the CLI tool (`botmem`), rate limits should be generous since it is the primary programmatic interface.

---

## 7. Firebase Integration Risks

### 7.1 Clock Synchronization for Token Verification

**What goes wrong:** Firebase ID tokens have `iat` (issued at) and `exp` (expiration) timestamps set by Google's servers. If the Botmem server's clock is ahead or behind by more than 5 minutes, token verification fails silently (token appears expired or not-yet-valid). On VPS instances, clock drift is common if NTP is not configured.

**Severity:** HIGH

**Current risk:** The Vultr VPS at `65.20.85.57` may not have NTP configured. Clock drift of even 30 seconds can cause intermittent auth failures that are extremely hard to debug -- tokens work for some users but not others depending on exact issuance time.

**Mitigation:**
- Enable NTP on the VPS: `timedatectl set-ntp true` or install `chrony`.
- In the Firebase Admin SDK, set a `clockTolerance` if available (the Node.js SDK does not officially support this, but you can work around it).
- Add server clock monitoring: log `Date.now()` vs the token's `iat` claim. If they differ by more than 30 seconds, alert.
- In Docker, the container inherits the host's clock. Ensure the HOST has NTP, not just the container.

### 7.2 Firebase Outages: Graceful Degradation

**What goes wrong:** Firebase Auth depends on Google's infrastructure. If Firebase is down (has happened multiple times historically), token verification fails because the public key set cannot be refreshed, or the Admin SDK cannot reach Firebase's servers. All users are locked out.

**Severity:** HIGH

**Mitigation:**
- Cache Firebase's public keys locally with a long TTL (the `firebase-admin` SDK does this by default, but verify the cache duration).
- If Firebase verification fails with a network error (not a signature error), fall back to cached verification using the last-known-good public keys.
- Consider supporting dual auth: Firebase for the web frontend + API keys for the CLI and agents. If Firebase is down, API key auth still works.
- For a personal tool, consider whether Firebase is even necessary. A simpler local auth (bcrypt password + JWT) avoids the external dependency entirely. Firebase adds value for social login (Google, Apple) but adds a point of failure.

### 7.3 Firebase Free Tier Limits

**What goes wrong:** Firebase Auth's free tier allows 10,000 monthly active users (MAU) and has limits on SMS verification. For a personal tool this is fine, but if Botmem is ever open to others (even friends/family), hitting the limit causes hard failures with no graceful degradation.

**Severity:** LOW (for personal use)

**Mitigation:**
- Monitor MAU usage via Firebase console.
- For personal use: irrelevant, but worth noting if the project grows.
- If self-hosting for multiple users, use the Firebase emulator suite for testing to avoid consuming production quota.

### 7.4 Token Refresh Edge Cases

**What goes wrong:** Firebase ID tokens expire after 1 hour. The client must refresh them using `getIdToken(true)`. If the user's device is offline when the token expires, they cannot refresh until they come back online. If the refresh token is revoked server-side (e.g., password change in Firebase console), the client gets an `auth/user-token-expired` error that many developers do not handle, resulting in infinite refresh loops.

**Severity:** MEDIUM

**Mitigation:**
- Handle `auth/user-token-expired` and `auth/user-disabled` errors explicitly in the frontend. Redirect to login, do not retry.
- Set up an `onIdTokenChanged` listener in the frontend that proactively refreshes tokens before expiration.
- On the backend, if token verification fails with "token expired," return 401 with a `code: "TOKEN_EXPIRED"` body so the frontend can distinguish between "refresh needed" and "account revoked."

---

## 8. CORS Misconfiguration

### 8.1 Wildcard Origins with Credentials

**What goes wrong:** Calling `app.enableCors()` without options (as the current `main.ts` does on line 43) enables CORS with default options: all origins (`*`), no credentials. If you later add `credentials: true` without restricting origins, browsers will reject the response -- the CORS spec forbids `Access-Control-Allow-Origin: *` with `Access-Control-Allow-Credentials: true`. But if you "fix" this by reflecting the `Origin` header back as `Access-Control-Allow-Origin`, any website can make authenticated requests to your API.

**Severity:** CRITICAL

**Current risk in Botmem:** `app.enableCors()` on line 43 of `main.ts` is a wildcard CORS. This is fine for development and for a single-user self-hosted tool, but becomes dangerous when you add cookie-based JWT auth.

**Mitigation:**
- Replace `app.enableCors()` with explicit configuration:
  ```typescript
  app.enableCors({
    origin: [config.frontendUrl], // e.g., 'http://localhost:12412', 'https://botmem.xyz'
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
  ```
- Never reflect the `Origin` header back without validation. Use an allowlist.
- For development, you can add `'http://localhost:*'` patterns, but use exact origins in production.

### 8.2 WebSocket CORS: Different Rules

**What goes wrong:** The `/events` WebSocket endpoint uses `@nestjs/platform-ws` (WsAdapter). WebSockets do NOT follow CORS -- the browser sends an `Origin` header on the WebSocket handshake, but there is no preflight request, and the server must validate the `Origin` manually. If the WebSocket server does not check the `Origin` header, any website can connect to it.

**Severity:** HIGH

**Current risk:** The `WsAdapter` in NestJS does not enforce origin checks by default. Any website can open a WebSocket to `ws://localhost:12412/events` and receive real-time job updates, auth status events, and search results.

**Mitigation:**
- Add origin validation in the WebSocket gateway's `handleConnection` method:
  ```typescript
  handleConnection(client: WebSocket, req: IncomingMessage) {
    const origin = req.headers.origin;
    if (!allowedOrigins.includes(origin)) {
      client.close(4003, 'Origin not allowed');
      return;
    }
  }
  ```
- When switching to `socket.io` (which supports CORS configuration natively), configure allowed origins in the gateway decorator.

### 8.3 Preflight Caching: Performance vs Security

**What goes wrong:** Browsers send a preflight `OPTIONS` request before each cross-origin request with custom headers. Without caching, every API call triggers two HTTP requests (preflight + actual). This doubles perceived latency. But caching preflight responses too aggressively means CORS policy changes take time to propagate.

**Severity:** LOW

**Mitigation:**
- Set `Access-Control-Max-Age: 3600` (1 hour) for production. This caches preflight responses, reducing request overhead.
- During development, use `Access-Control-Max-Age: 0` so CORS changes take effect immediately.
- Configure this in the NestJS CORS options: `maxAge: process.env.NODE_ENV === 'production' ? 3600 : 0`.

---

## Cross-Cutting Concerns

### 9.1 Drizzle ORM Schema Split: SQLite and PostgreSQL Simultaneously

**What goes wrong:** Drizzle has separate imports for SQLite (`drizzle-orm/sqlite-core`) and PostgreSQL (`drizzle-orm/pg-core`). You cannot use the same schema file for both. During migration, you need two schema files, two Drizzle instances, and a translation layer. This is tedious and error-prone -- a column added to the PostgreSQL schema but forgotten in the SQLite schema (or vice versa) causes silent data loss.

**Severity:** HIGH

**Mitigation:**
- Generate the PostgreSQL schema programmatically from the SQLite schema (write a script that maps types).
- Or define the schema abstractly (in a shared types package) and generate both Drizzle schemas from it.
- Use database-level tests that verify both schemas have the same tables and columns.
- Plan to drop SQLite support entirely after migration. Do not maintain two schemas long-term.

### 9.2 Secrets in Docker Logs and Compose Files

**What goes wrong:** Environment variables in `docker-compose.yml` or `.env.prod` are visible in `docker inspect`, `docker compose config`, and sometimes in container logs. If `APP_SECRET`, JWT signing keys, or Firebase credentials are in these files, any user with Docker access can read them.

**Severity:** HIGH

**Mitigation:**
- Use Docker secrets for sensitive values. Reference them as files (`/run/secrets/app_secret`) rather than environment variables.
- Never log environment variables at startup (a common NestJS debugging pattern). If you must log configuration, redact sensitive values.
- On the Vultr VPS, ensure `.env.prod` is not world-readable: `chmod 600 .env.prod`.

### 9.3 SQLite WAL Mode and Encryption Compatibility

**What goes wrong:** Botmem uses SQLite in WAL mode for concurrent read performance. If you add SQLite-level encryption (SQLCipher or similar), WAL mode may not be supported or may have different performance characteristics. Some SQLite encryption extensions do not support WAL mode at all.

**Severity:** MEDIUM (only relevant if encrypting SQLite before PostgreSQL migration)

**Mitigation:**
- If encrypting at the SQLite level, verify WAL mode compatibility with your chosen encryption extension.
- Prefer application-level field encryption (encrypt specific columns, not the whole database) to avoid SQLite engine compatibility issues.
- Since the plan is to migrate to PostgreSQL, investing in SQLite-level encryption is probably not worth it. Encrypt at the application layer and carry that encryption to PostgreSQL.

---

## Priority Matrix

| Pitfall | Severity | Effort to Fix | Priority |
|---------|----------|---------------|----------|
| 5.2 IV reuse in AES-GCM | CRITICAL | Low (code pattern) | P0 |
| 1.1 JWT in localStorage | CRITICAL | Medium (refactor auth) | P0 |
| 8.1 Wildcard CORS + credentials | CRITICAL | Low (config change) | P0 |
| 3.1 RLS superuser bypass | CRITICAL | Medium (role setup) | P0 |
| 1.4 Algorithm confusion | CRITICAL | Low (config) | P0 |
| 5.1 APP_SECRET storage | CRITICAL | Medium (ops) | P1 |
| 2.1 Password-derived key loss | CRITICAL | High (architecture) | P1 |
| 3.2 Connection pooling RLS bypass | CRITICAL | High (middleware) | P1 |
| 1.2 Refresh token race condition | HIGH | Medium (frontend) | P1 |
| 1.3 Token revocation | HIGH | Medium (Redis blocklist) | P1 |
| 4.1 Type differences SQLite→PG | HIGH | High (migration script) | P1 |
| 4.4 Dual-driver data drift | HIGH | High (cutover plan) | P1 |
| 5.4 Plaintext-to-encrypted migration | HIGH | Medium (3-phase deploy) | P1 |
| 6.2 API key storage (hash not encrypt) | HIGH | Low (code pattern) | P2 |
| 7.1 Clock sync for Firebase | HIGH | Low (NTP config) | P2 |
| 7.2 Firebase outage degradation | HIGH | Medium (fallback logic) | P2 |
| 8.2 WebSocket origin validation | HIGH | Low (code change) | P2 |
| 3.3 Forgotten RLS on new tables | HIGH | Medium (CI check) | P2 |
| 6.1 Key generation randomness | HIGH | Low (code pattern) | P2 |
| 9.1 Dual Drizzle schema split | HIGH | High (tooling) | P2 |
| 4.3 Date format inconsistencies | HIGH | Medium (validation) | P2 |
| 4.2 NULL handling differences | MEDIUM | Medium (audit) | P3 |
| 6.3 Key rotation | MEDIUM | Medium (feature) | P3 |
| 6.4 Rate limiting | MEDIUM | Medium (Redis) | P3 |
| 7.4 Token refresh edge cases | MEDIUM | Low (error handling) | P3 |
| 3.4 RLS migration locking | MEDIUM | Low (lock timeout) | P3 |
| 2.2 Re-encryption race conditions | HIGH | Medium | P3* |
| 2.3 Re-encryption performance | MEDIUM | Medium | P3* |
| 5.3 Unauthenticated encryption | HIGH | Low (use AES-GCM) | P2 |
| 8.3 Preflight caching | LOW | Low (config) | P4 |
| 7.3 Firebase free tier | LOW | N/A | P4 |
| 1.5 Clock skew | LOW-MEDIUM | Low (NTP) | P4 |

*P3 for items 2.2/2.3 assumes server-managed keys (Option A), which avoids re-encryption on password change entirely.

## Sources

- Direct codebase analysis: `main.ts` (CORS config line 43), `schema.ts` (all table definitions, "encrypted JSON" comments without implementation), `auth.service.ts` (connector OAuth flow, no user auth), `config.service.ts` (environment variables), `db.service.ts` (SQLite WAL mode)
- Current encryption state: `authContext` and `credentials` columns are annotated as "encrypted JSON" in schema comments but stored as plaintext JSON strings. No encryption implementation exists.
- Current auth state: No user authentication exists. The `auth/` module handles connector OAuth flows (Gmail, Slack), not user login/logout.
- Deployment: VPS at `65.20.85.57`, Docker Compose with Redis + Qdrant + API + Caddy, `.env.prod` file with secrets.
- PostgreSQL RLS documentation and known bypass patterns from PostgreSQL 15/16 release notes.
- OWASP JWT security cheat sheet and known `jsonwebtoken` library CVEs.
- AES-GCM nonce reuse attacks (Joux 2006, practical demonstrations in TLS 1.2 implementations).

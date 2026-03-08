# Botmem v2.0 — Security, Auth & Encryption: Feature Implementation Patterns

Research date: 2026-03-08

## Current State Summary

The codebase currently has **no real authentication**. The `AuthService` at `apps/api/src/auth/` handles only **connector OAuth flows** (Gmail, Slack, etc.) — not user login. The frontend `authStore` stores users in `localStorage` with plaintext password comparison. All API endpoints are fully open with no guards. CORS is set to `app.enableCors()` with no origin restrictions. There is no concept of per-user data isolation — the system is single-tenant.

---

## 1. User Registration + Login Flow

### User Flow

1. User visits `/signup` — enters name, email, password
2. Backend hashes password with bcrypt, creates user row, returns JWT access token + sets httpOnly refresh cookie
3. User visits `/login` — enters email, password
4. Backend verifies bcrypt hash, returns access token + sets refresh cookie
5. All subsequent API requests include `Authorization: Bearer <access_token>`
6. When access token expires (15min), frontend receives 401, calls `POST /api/user-auth/refresh` (cookie sent automatically), gets new access token
7. Refresh token rotation: each refresh issues a new refresh token and invalidates the old one

### API Endpoints

```
POST /api/user-auth/register    { email, password, name } -> { accessToken, user }
POST /api/user-auth/login       { email, password }       -> { accessToken, user }
POST /api/user-auth/refresh     (httpOnly cookie)         -> { accessToken }
POST /api/user-auth/logout      (httpOnly cookie)         -> { ok: true }
GET  /api/user-auth/me          (Bearer token)            -> { user }
```

Use `/api/user-auth/` prefix to avoid conflict with the existing `/api/auth/` connector-auth routes.

### Data Model Changes

New table in `apps/api/src/db/schema.ts`:

```typescript
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),                    // UUID
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),   // bcrypt output
  name: text('name').notNull(),
  onboarded: integer('onboarded').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const refreshTokens = sqliteTable('refresh_tokens', {
  id: text('id').primaryKey(),                    // UUID
  userId: text('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull(),         // SHA-256 of the token
  family: text('family').notNull(),                // rotation family ID
  expiresAt: text('expires_at').notNull(),
  revokedAt: text('revoked_at'),                   // set on rotation or logout
  createdAt: text('created_at').notNull(),
});
```

### NestJS Implementation Pattern

**New module**: `apps/api/src/user-auth/`

```
user-auth/
  user-auth.module.ts
  user-auth.controller.ts
  user-auth.service.ts
  jwt.strategy.ts          # Passport JWT strategy (from Bearer header)
  jwt-auth.guard.ts        # CanActivate guard
  decorators/
    current-user.ts        # @CurrentUser() param decorator
```

**Dependencies**: `bcrypt`, `@nestjs/jwt`, `@nestjs/passport`, `passport-jwt`

**JWT payload**: `{ sub: userId, email }` — keep it minimal.

**Access token**: Sign with `JWT_SECRET` env var, 15min expiry. Return in response body (not cookie — frontend stores in memory/Zustand, never localStorage).

**Refresh token**: Generate with `crypto.randomBytes(32).toString('hex')`. Store SHA-256 hash in DB. Set as `httpOnly`, `Secure` (in prod), `SameSite=Strict`, `Path=/api/user-auth/refresh`, 7-day max-age.

**Refresh token rotation**: On refresh, look up the token hash. If found and not revoked/expired, issue new access + refresh tokens, revoke the old refresh row, create new row with same `family`. If the presented token is already revoked (replay attack), revoke ALL tokens in that family — force full re-login.

**Guard application**: Apply `JwtAuthGuard` globally in `AppModule` via `APP_GUARD`, then use `@Public()` decorator to exempt specific routes (register, login, refresh, connector OAuth callbacks, version endpoint).

```typescript
// jwt-auth.guard.ts
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) { super(); }
  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]
    );
    if (isPublic) return true;
    return super.canActivate(context);
  }
}
```

### Frontend Changes

Replace the current `authStore.ts` localStorage-based auth with:

```typescript
interface AuthState {
  user: User | null;
  accessToken: string | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshToken: () => Promise<boolean>;
}
```

- Store `accessToken` in Zustand (memory only, NOT persisted) — Zustand's `persist` middleware must exclude `accessToken`
- Persist only `user` object for UI display
- Create an Axios/fetch interceptor: on 401, call `refreshToken()`, retry original request. If refresh fails, redirect to `/login`
- On app boot, call `GET /api/user-auth/me` — if refresh cookie is valid, this restores the session

### Gotchas

- **bcrypt cost factor**: Use 12 rounds. Going higher makes login noticeably slow on the 2GB VPS. `bcrypt.hash(password, 12)`.
- **Timing attacks on login**: Always hash the input even if user not found (`await bcrypt.hash(password, 12)` before returning "invalid credentials") to prevent email enumeration via timing.
- **SQLite and unique constraints**: `email` unique index means concurrent register requests could race. Drizzle's `.onConflictDoNothing()` or catch the constraint error and return 409.
- **Refresh cookie on localhost**: `Secure` flag prevents cookie sending over HTTP. In dev, omit `Secure` or use `__Host-` prefix only in prod.
- **Access token in memory**: Page refresh loses the token. The frontend must call `/refresh` on every page load to get a new access token. This is the correct pattern — it prevents XSS from stealing long-lived tokens.
- **User ID on existing data**: All existing tables (accounts, memories, etc.) lack a `userId` column. Phase 1 can work single-tenant (ignore userId filtering), then add `userId` FK columns in the Memory Banks feature.

---

## 2. Password Reset Flow

### User Flow

1. User clicks "Forgot password" on login page
2. Enters email address, submits
3. Backend generates reset token, stores hash in DB, sends email with link `{FRONTEND_URL}/reset-password?token=<token>`
4. Always returns 200 "If that email exists, we sent a link" (no enumeration)
5. User clicks link, enters new password
6. Backend verifies token hash, checks expiry (1hr), updates password hash, revokes all refresh tokens for that user
7. User is redirected to login

### API Endpoints

```
POST /api/user-auth/forgot-password   { email }                    -> { ok: true }
POST /api/user-auth/reset-password    { token, newPassword }       -> { ok: true }
```

### Data Model

```typescript
export const passwordResets = sqliteTable('password_resets', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull(),         // SHA-256 of the token
  expiresAt: text('expires_at').notNull(),          // ISO string, now + 1hr
  usedAt: text('used_at'),                          // set when consumed
  createdAt: text('created_at').notNull(),
});
```

### Token Generation

```typescript
const token = crypto.randomBytes(32).toString('base64url'); // URL-safe, 43 chars
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
```

Store `tokenHash` in DB, send `token` in the email link. On reset, hash the submitted token and look up the row.

### Email Sending

For v2.0 MVP, use **nodemailer** with SMTP credentials from env vars:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=noreply@botmem.xyz
SMTP_PASS=<app-password>
```

Create a lightweight `MailService` in `apps/api/src/mail/mail.service.ts`. Do not over-engineer — a single `sendResetEmail(to, token)` method is sufficient. Template the URL with `FRONTEND_URL`.

### Gotchas

- **One active token per user**: On new reset request, invalidate (set `usedAt`) any existing unexpired tokens for that user before creating a new one.
- **Rate limiting**: Without a rate limiter, an attacker can spam reset emails. Add a simple check: if the most recent reset for this email was created < 60 seconds ago, return 200 but skip sending. NestJS `@nestjs/throttler` can also help globally.
- **Token in URL**: The token appears in browser history and possibly server access logs. The reset page should immediately `POST` the token to the API and clear it from the URL. Use `window.history.replaceState` after extracting the token from the query string.
- **Password validation**: Enforce minimum 8 characters server-side. No maximum (bcrypt truncates at 72 bytes, but that covers 72+ characters in practice).

---

## 3. Firebase Auth Integration (Switchable Provider)

### Design: Strategy Pattern via Env Var

```
AUTH_PROVIDER=local    # default — bcrypt + JWT (described in section 1)
AUTH_PROVIDER=firebase # Firebase Admin SDK validates ID tokens
```

### Architecture

```
user-auth/
  providers/
    auth-provider.interface.ts    # abstract interface
    local-auth.provider.ts        # bcrypt + JWT implementation
    firebase-auth.provider.ts     # Firebase Admin SDK
  user-auth.module.ts             # dynamic provider registration
```

**Interface**:

```typescript
export interface AuthProvider {
  register(email: string, password: string, name: string): Promise<{ user: UserRecord; accessToken: string }>;
  login(email: string, password: string): Promise<{ user: UserRecord; accessToken: string }>;
  validateToken(token: string): Promise<{ userId: string; email: string }>;
  revokeSession(userId: string): Promise<void>;
}
```

**Dynamic module registration**:

```typescript
@Module({})
export class UserAuthModule {
  static register(): DynamicModule {
    const provider = process.env.AUTH_PROVIDER || 'local';
    const authProvider = provider === 'firebase'
      ? { provide: 'AUTH_PROVIDER', useClass: FirebaseAuthProvider }
      : { provide: 'AUTH_PROVIDER', useClass: LocalAuthProvider };

    return {
      module: UserAuthModule,
      providers: [authProvider, UserAuthService],
      controllers: [UserAuthController],
      exports: ['AUTH_PROVIDER'],
    };
  }
}
```

### Firebase Provider Implementation

**Dependencies**: `firebase-admin`

**Env vars**:
```
AUTH_PROVIDER=firebase
FIREBASE_PROJECT_ID=botmem-prod
FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-sa.json   # or inline JSON via FIREBASE_SA_JSON
```

**Token validation**: The `JwtAuthGuard` calls `authProvider.validateToken(token)`. For Firebase, this calls `admin.auth().verifyIdToken(token)`. For local, this calls `jwt.verify(token, JWT_SECRET)`.

**Registration with Firebase**: The backend does NOT create Firebase users. The React frontend uses `firebase/auth` client SDK to `createUserWithEmailAndPassword()`, gets an ID token, sends it to `POST /api/user-auth/register-firebase { idToken, name }`. The backend verifies the ID token, creates the `users` row (using Firebase UID as `id`), returns the user object. No refresh cookie needed — Firebase SDK manages token refresh client-side.

### Frontend Pattern

```typescript
// authStore.ts
const authProvider = import.meta.env.VITE_AUTH_PROVIDER || 'local';

if (authProvider === 'firebase') {
  // Use firebase/auth for signInWithEmailAndPassword
  // Get idToken from Firebase, send to backend for user record creation
  // Firebase SDK auto-refreshes tokens via onIdTokenChanged()
} else {
  // Use local login/signup/refresh as described in section 1
}
```

Expose `VITE_AUTH_PROVIDER` as a build-time env var so the frontend tree-shakes the unused path.

### Gotchas

- **Firebase free tier**: 10K MAU on Spark plan. Sufficient for personal use.
- **User ID mismatch**: Firebase generates its own UIDs (28-char strings). The `users.id` column must accept both UUIDs (local) and Firebase UIDs. Using `text` type handles both.
- **Dual-mode guard**: The `JwtAuthGuard` must handle both token formats. Simplest approach: inject `AUTH_PROVIDER` and delegate. Do NOT try to auto-detect token format — that creates security issues.
- **Firebase Admin SDK size**: ~5MB. It's a heavy dependency for something that may not be used. Consider making it a lazy `import()` in `firebase-auth.provider.ts` so it's only loaded when `AUTH_PROVIDER=firebase`.
- **No password reset for Firebase**: Firebase handles its own reset flow. The `/forgot-password` endpoint should return a different response or redirect to Firebase's `sendPasswordResetEmail()` client-side.
- **Refresh tokens**: With Firebase, the server is stateless — no refresh token table needed. The client SDK handles everything. This means the `refreshTokens` table is only used by the local provider.

---

## 4. API Key System

### User Flow

1. Authenticated user navigates to Settings > API Keys
2. Clicks "Create API Key", enters a name and selects scopes (e.g., which memory banks)
3. Backend generates key, returns it ONCE in the response. Stores only the hash.
4. User copies the key. It is never shown again.
5. External tools (CLI, agents) use `Authorization: Bearer bm_<key>` to call API
6. User can list keys (name, prefix, created, last used), revoke them

### Key Format

```
bm_live_<32 random bytes as base64url>
```

Prefix `bm_live_` makes keys greppable in logs/code (like Stripe's `sk_live_`). Total length: ~51 chars.

```typescript
function generateApiKey(): { key: string; hash: string; prefix: string } {
  const bytes = crypto.randomBytes(32);
  const random = bytes.toString('base64url'); // 43 chars
  const key = `bm_live_${random}`;
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  const prefix = key.slice(0, 14); // "bm_live_XXXXX" — enough to identify
  return { key, hash, prefix };
}
```

### API Endpoints

```
POST   /api/api-keys          { name, scopes? }   -> { key, id, name, prefix, createdAt }
GET    /api/api-keys                               -> [{ id, name, prefix, lastUsedAt, createdAt }]
DELETE /api/api-keys/:id                           -> { ok: true }
```

### Data Model

```typescript
export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull().unique(),     // SHA-256
  keyPrefix: text('key_prefix').notNull(),           // first 14 chars, for display
  scopes: text('scopes').notNull().default('[]'),    // JSON array of bank IDs or ["*"]
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
  createdAt: text('created_at').notNull(),
});
```

### Auth Guard Integration

Modify `JwtAuthGuard` to also accept API keys:

```typescript
canActivate(context: ExecutionContext) {
  const request = context.switchToHttp().getRequest();
  const authHeader = request.headers.authorization;

  if (authHeader?.startsWith('Bearer bm_')) {
    // API key path
    const key = authHeader.slice(7);
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    const row = this.apiKeyService.findByHash(hash);
    if (!row || row.revokedAt) throw new UnauthorizedException();
    // Attach user to request
    request.user = { id: row.userId, viaApiKey: true, scopes: JSON.parse(row.scopes) };
    // Update lastUsedAt (fire-and-forget, don't await)
    this.apiKeyService.touchLastUsed(row.id);
    return true;
  }

  // JWT path (existing logic)
  return super.canActivate(context);
}
```

### Gotchas

- **Key shown once**: The plaintext key is returned ONLY in the `POST` response. If the user loses it, they must revoke and create a new one. The frontend should show a modal with copy-to-clipboard and a warning.
- **Hash lookup performance**: SHA-256 hash lookup on `key_hash` unique index is O(1) in SQLite. No performance concern even with thousands of keys.
- **Rate limiting per key**: Track usage per key hash. Consider a separate `api_key_usage` table or Redis counter if abuse is a concern.
- **Scope enforcement**: Scopes are checked at the service layer, not the guard. The guard authenticates; the service checks `request.user.scopes` against the requested resource. Start simple: `["*"]` means all access, `["bank:<id>"]` means scoped to specific memory banks.
- **CLI integration**: The `packages/cli` already supports `--api-url`. Add `--api-key` flag or `BOTMEM_API_KEY` env var. The CLI sends it as `Authorization: Bearer <key>`.

---

## 5. Memory Banks

### Concept

A memory bank is a logical partition of data. Think of it like a folder or workspace. Each bank has its own memories, and search is scoped to the active bank(s). Use cases: "Personal", "Work", "Project X", or one bank per AI agent.

### User Flow

1. New users get a "Default" bank auto-created
2. User can create additional banks from the UI
3. When setting up a connector sync, user selects which bank to sync into
4. Memory search is scoped to the currently selected bank (or "All Banks")
5. Users can rename or delete banks (delete moves memories to Default or deletes them)
6. API keys can be scoped to specific banks

### API Endpoints

```
POST   /api/banks              { name }             -> { id, name, createdAt }
GET    /api/banks                                    -> [{ id, name, memoryCount, createdAt }]
PATCH  /api/banks/:id          { name }             -> { id, name }
DELETE /api/banks/:id          { moveTo?: bankId }  -> { ok, movedCount }
POST   /api/banks/:id/migrate  { memoryIds }        -> { movedCount }
```

### Data Model

```typescript
export const memoryBanks = sqliteTable('memory_banks', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  isDefault: integer('is_default').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
```

**Add `bankId` to existing tables**:

```typescript
// memories table — add column
bankId: text('bank_id').references(() => memoryBanks.id),

// accounts table — add column (which bank does this connector sync into?)
bankId: text('bank_id').references(() => memoryBanks.id),

// rawEvents table — add column
bankId: text('bank_id').references(() => memoryBanks.id),
```

### Qdrant Integration

Add `bank_id` to the Qdrant point payload:

```typescript
await this.qdrant.upsert(memoryId, vector, {
  source_type: sourceType,
  connector_type: connectorType,
  event_time: eventTime,
  account_id: accountId,
  bank_id: bankId,        // NEW
});
```

Search filters include `bank_id`:

```typescript
const qdrantFilter = {
  must: [
    { key: 'bank_id', match: { value: activeBankId } }
  ]
};
```

Create a keyword payload index on `bank_id` for efficient filtering:

```typescript
await this.client.createPayloadIndex('memories', {
  field_name: 'bank_id',
  field_schema: 'keyword',
});
```

### Migration Strategy for Existing Data

1. Create the `memory_banks` table
2. Create a "Default" bank for the existing user (or a system-level default if no users table yet)
3. Run: `UPDATE memories SET bank_id = '<default-bank-id>' WHERE bank_id IS NULL`
4. Run: `UPDATE accounts SET bank_id = '<default-bank-id>' WHERE bank_id IS NULL`
5. Batch-update Qdrant payloads to include `bank_id` (use the scroll + set_payload API)
6. Make `bank_id` NOT NULL after migration

### Frontend Changes

- Add a bank selector dropdown in the header/sidebar
- Store `activeBankId` in Zustand (persisted)
- All memory search/list API calls include `bankId` filter
- Connector setup flow includes bank selection step
- Settings page shows bank management (create, rename, delete)

### Gotchas

- **Default bank**: Always ensure exactly one default bank exists per user. Prevent deletion of the default bank — rename is OK.
- **Qdrant filter performance**: Qdrant payload filters are applied post-HNSW-search by default, which can miss results. For bank scoping to work correctly, use `bank_id` as a keyword index and rely on Qdrant's pre-filtering when the filter cardinality is low.
- **Cross-bank search**: "All Banks" search should pass no `bank_id` filter, but the auth layer must ensure the user only sees their own data (filter by `user_id` at minimum).
- **Contact sharing across banks**: Contacts should NOT be bank-scoped — a person is a person regardless of which bank the memory is in. Only memories and raw events are bank-scoped.
- **Delete bank cascade**: Decide on behavior: (a) move all memories to Default bank, (b) delete all memories. Option (a) is safer. Also need to remove vectors from Qdrant if deleting memories.

---

## 6. E2EE Client-Side Encryption

### Design Overview

Client-side encryption means the server never sees plaintext memory text or metadata. The encryption key is derived from the user's password in the browser. Vectors remain plaintext (they are derived from text, but you cannot reconstruct text from an embedding — they are lossy projections).

**What gets encrypted**: `memories.text`, `memories.entities`, `memories.claims`, `memories.metadata`, `rawEvents.payload`, `rawEvents.cleanedText`

**What stays plaintext**: Vectors in Qdrant (cosine similarity still works), `memories.eventTime`, `memories.sourceType`, `memories.connectorType`, `memories.embeddingStatus`, all structural/relational columns

### Key Derivation

```typescript
// In browser using WebCrypto API
async function deriveEncryptionKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}
```

Note: The original spec mentions Argon2id, but WebCrypto does not natively support it. Options:
- **PBKDF2** (shown above): Native WebCrypto, 600K iterations, widely supported. Slightly weaker than Argon2id against GPU attacks but perfectly adequate for this use case.
- **Argon2id via WASM**: Use `argon2-browser` or `hash-wasm` package. Adds ~150KB WASM bundle. Better resistance to GPU/ASIC attacks. Recommended if bundle size is acceptable.

### Encryption Flow

```typescript
// Encrypt
async function encrypt(plaintext: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for GCM
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key, encoded
  );
  // Concatenate IV + ciphertext, base64 encode
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

// Decrypt
async function decrypt(encoded: string, key: CryptoKey): Promise<string> {
  const combined = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key, ciphertext
  );
  return new TextDecoder().decode(plaintext);
}
```

### Architecture: Where Encryption Happens

**Problem**: Connectors run server-side. They produce plaintext memories. The server must embed the text (via Ollama) before encrypting. So the pipeline is:

```
Connector.sync()  ->  raw event (plaintext on server)
  -> clean -> embed (needs plaintext for embedding) -> enrich (needs plaintext)
  -> AFTER enrichment: encrypt text fields -> store encrypted in SQLite
```

This means E2EE is **not true zero-knowledge** for the ingestion pipeline. The server sees plaintext during processing. The encryption protects **data at rest** — if the SQLite database is stolen, the text is encrypted.

**True E2EE alternative** (more complex): The client sends a pre-encrypted payload and a plaintext embedding. The server never sees text. But then enrichment (entity extraction, claim extraction) cannot happen server-side. This is a fundamental tradeoff.

**Recommended approach for Botmem**: Server-side encryption at rest, key derived from a server-side secret. This protects the database file and backups. It is not E2EE in the Signal sense, but it is practical for the threat model (VPS compromise, database leak).

### Server-Side Encryption at Rest Pattern

```typescript
// apps/api/src/crypto/crypto.service.ts
@Injectable()
export class CryptoService {
  private key: Buffer;

  constructor(config: ConfigService) {
    // Derive a 256-bit key from ENCRYPTION_SECRET env var
    const secret = config.encryptionSecret; // required env var
    this.key = crypto.scryptSync(secret, 'botmem-salt', 32);
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
  }

  decrypt(encoded: string): string {
    const buf = Buffer.from(encoded, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext) + decipher.final('utf8');
  }
}
```

### Data Model

Add `encrypted` marker to memories:

```typescript
// No schema change needed — encrypted text is stored in the same `text` column.
// Add a flag so the system knows whether data is encrypted:
encrypted: integer('encrypted').notNull().default(0),
```

### Password Change Re-encryption

When the user changes their password (or the `ENCRYPTION_SECRET` rotates):

1. Derive old key, derive new key
2. Batch-process all encrypted memories: decrypt with old key, re-encrypt with new key
3. This is a background job (BullMQ queue `re-encrypt`)
4. During re-encryption, set a `re_encrypting` flag to prevent concurrent reads from using the wrong key

### Gotchas

- **Embedding from encrypted text is impossible**: The pipeline must embed BEFORE encrypting. If you encrypt text and then try to search, you cannot generate a query embedding that matches — the embedding was made from plaintext, not ciphertext. So the flow is: embed plaintext, store embedding in Qdrant (plaintext vector), encrypt text, store encrypted text in SQLite.
- **Search result display**: On search, Qdrant returns memory IDs + scores. The API fetches encrypted text from SQLite, decrypts it server-side, returns plaintext to the authenticated user. The decryption happens per-request.
- **Performance**: AES-256-GCM is fast — ~1GB/s on modern hardware. Decrypting 50 search results is sub-millisecond.
- **Key management**: `ENCRYPTION_SECRET` must NEVER be stored in the database. It goes in `.env` or a secrets manager. Losing this key means all encrypted data is irrecoverable.
- **Backup implications**: Database backups contain encrypted data. This is the whole point — a stolen backup is useless without the key.
- **Selective encryption**: Not all fields need encryption. `eventTime`, `sourceType`, `connectorType` are useful for filtering and do not contain sensitive content. Only encrypt `text`, `entities`, `claims`, `metadata`, `payload`.
- **IV uniqueness**: AES-GCM requires unique IVs per encryption. Using `crypto.randomBytes(12)` guarantees this probabilistically (collision probability negligible for < 2^32 encryptions with same key).

---

## 7. CORS Configuration

### Current State

`main.ts` calls `app.enableCors()` with no options — this allows ALL origins. Insecure for production.

### Implementation

**Env var**:
```
CORS_ORIGINS=https://botmem.xyz,http://localhost:12412
```

**In `config.service.ts`**:
```typescript
get corsOrigins(): string[] {
  const origins = process.env.CORS_ORIGINS || this.frontendUrl;
  return origins.split(',').map(o => o.trim()).filter(Boolean);
}
```

**In `main.ts`**:
```typescript
const config = app.get(ConfigService);
app.enableCors({
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, curl, mobile apps)
    if (!origin) return callback(null, true);
    if (config.corsOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error('CORS: origin not allowed'));
  },
  credentials: true,     // Required for httpOnly cookies (refresh token)
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['X-Request-Id'],
  maxAge: 86400,          // Preflight cache: 24 hours
});
```

### Gotchas

- **`credentials: true` is required**: Without this, the browser will not send the httpOnly refresh cookie on cross-origin requests. This is critical for the refresh token flow.
- **`origin: true` vs callback**: Using `origin: true` reflects back any origin — equivalent to `*` with credentials, which browsers reject. Always use the callback or an array.
- **Vite dev proxy**: In dev mode, Vite proxies API calls to the same origin (`localhost:12412`), so CORS headers are technically not needed. But the WebSocket connection (`/events`) may still trigger CORS. Include `http://localhost:12412` in allowed origins for dev.
- **WebSocket CORS**: NestJS WebSocket adapter (WsAdapter) does NOT use the Express CORS middleware. WS connections use the `Origin` header but are not subject to CORS preflight. However, validate the origin in the WebSocket gateway's `handleConnection` if needed.
- **Multiple origins**: The `Access-Control-Allow-Origin` header can only contain ONE origin (not a comma-separated list). The callback pattern above dynamically sets the correct origin per request.
- **Production Caddy**: If Caddy reverse-proxies to the NestJS app, and the frontend is served from the same domain, CORS may not be needed at all (same-origin). But keep it configured for API key users calling from other domains.
- **No trailing slashes**: `https://botmem.xyz/` !== `https://botmem.xyz`. Strip trailing slashes when comparing origins.

---

## Implementation Order (Recommended)

| Phase | Feature | Depends On |
|-------|---------|------------|
| 1 | CORS Configuration | Nothing |
| 2 | User Registration + Login | CORS |
| 3 | Password Reset | User Auth |
| 4 | API Key System | User Auth |
| 5 | Memory Banks | User Auth, existing data migration |
| 6 | Firebase Auth Integration | User Auth (refactor to strategy pattern) |
| 7 | E2EE / Encryption at Rest | Memory Banks (encrypt per-bank), User Auth |

Phases 1-4 can be shipped as a single release. Phase 5 is the biggest migration effort (adding `bank_id` to every query path). Phase 6 is optional and can be deferred. Phase 7 should only be attempted after all other features are stable.

---

## New Environment Variables Summary

```bash
# Auth
JWT_SECRET=<random-64-bytes-hex>          # Required for local auth
JWT_ACCESS_EXPIRY=15m
JWT_REFRESH_EXPIRY=7d
AUTH_PROVIDER=local                        # local | firebase

# Firebase (only if AUTH_PROVIDER=firebase)
FIREBASE_PROJECT_ID=
FIREBASE_SERVICE_ACCOUNT_PATH=

# Email (password reset)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=

# Encryption
ENCRYPTION_SECRET=<random-64-bytes-hex>    # Required for encryption at rest

# CORS
CORS_ORIGINS=https://botmem.xyz,http://localhost:12412
```

## New Dependencies

```bash
# Backend
pnpm add -F @botmem/api bcrypt @types/bcrypt @nestjs/jwt @nestjs/passport passport passport-jwt @types/passport-jwt nodemailer @types/nodemailer

# Optional (Firebase)
pnpm add -F @botmem/api firebase-admin

# Optional (Argon2 WASM for client-side)
pnpm add -F @botmem/web hash-wasm
```

## Files That Need Changes (Existing)

| File | Change |
|------|--------|
| `apps/api/src/db/schema.ts` | Add `users`, `refreshTokens`, `passwordResets`, `apiKeys`, `memoryBanks` tables; add `bankId` and `userId` columns to `memories`, `accounts`, `rawEvents` |
| `apps/api/src/config/config.service.ts` | Add getters for `jwtSecret`, `authProvider`, `corsOrigins`, `encryptionSecret`, SMTP config |
| `apps/api/src/main.ts` | Replace `app.enableCors()` with configured CORS; move guard registration after bootstrap |
| `apps/api/src/app.module.ts` | Import `UserAuthModule`, `CryptoModule`, `MailModule`, `BanksModule`, `ApiKeysModule` |
| `apps/api/src/memory/memory.service.ts` | Add `bankId` filter to all queries; decrypt text on read |
| `apps/api/src/memory/memory.controller.ts` | Pass `bankId` from request context to service |
| `apps/api/src/memory/qdrant.service.ts` | Add `bank_id` payload index; include in upsert/search |
| `apps/web/src/store/authStore.ts` | Full rewrite: real API calls, JWT management, refresh flow |
| `packages/shared/src/types/index.ts` | Update `User` type with auth fields; add `MemoryBank`, `ApiKey` types |
| `packages/cli/` | Add `--api-key` flag, send Authorization header |

## New Files to Create

```
apps/api/src/user-auth/
  user-auth.module.ts
  user-auth.controller.ts
  user-auth.service.ts
  providers/
    auth-provider.interface.ts
    local-auth.provider.ts
    firebase-auth.provider.ts
  jwt.strategy.ts
  jwt-auth.guard.ts
  decorators/current-user.ts
  decorators/public.ts

apps/api/src/api-keys/
  api-keys.module.ts
  api-keys.controller.ts
  api-keys.service.ts

apps/api/src/banks/
  banks.module.ts
  banks.controller.ts
  banks.service.ts

apps/api/src/crypto/
  crypto.module.ts
  crypto.service.ts

apps/api/src/mail/
  mail.module.ts
  mail.service.ts

apps/web/src/components/auth/
  LoginPage.tsx
  SignupPage.tsx
  ForgotPasswordPage.tsx
  ResetPasswordPage.tsx

apps/web/src/components/settings/
  ApiKeysPanel.tsx
  BanksPanel.tsx
```

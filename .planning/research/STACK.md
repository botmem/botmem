# Technology Stack: Security, Auth & Encryption

**Project:** Botmem v2.0 Security Milestone
**Researched:** 2026-03-08
**Scope:** Auth (JWT + Firebase), password hashing, encryption at rest, PostgreSQL migration with RLS

## Current State

The codebase has **zero auth infrastructure**: no guards, no user model, no login flow. Schema comments say "encrypted JSON" for `authContext` and `credentials` columns, but the data is stored as plaintext. All API endpoints are open. The database is SQLite via `better-sqlite3` + `drizzle-orm/sqlite-core`.

---

## 1. NestJS Auth Libraries

### Recommended Stack

| Package | Version | Purpose |
|---------|---------|---------|
| `@nestjs/jwt` | `^11.0.0` | JWT signing/verification as a NestJS module |
| `@nestjs/passport` | `^11.0.0` | Strategy-based auth framework integration |
| `passport` | `^0.7.0` | Core passport (peer dep) |
| `passport-jwt` | `^4.0.1` | JWT strategy for bearer token validation |
| `passport-local` | `^1.0.0` | Username/password strategy (email+password login) |
| `@types/passport-jwt` | `^4.0.1` | TypeScript types |
| `@types/passport-local` | `^1.0.38` | TypeScript types |

### Why This Combo

- `@nestjs/passport` + `@nestjs/jwt` are the official NestJS auth packages, maintained by the NestJS team, and match the v11 release cycle.
- `passport-local` handles the email+password login (validates credentials, returns user).
- `passport-jwt` handles all subsequent requests (extracts + validates JWT from `Authorization: Bearer` header).
- This is the standard NestJS auth pattern documented in the official NestJS docs. No reason to deviate.

### Integration Pattern

```typescript
// auth.module.ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      useFactory: (config: ConfigService) => ({
        secret: config.jwtAccessSecret,
        signOptions: { expiresIn: '15m' },
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [AuthService, LocalStrategy, JwtStrategy, JwtRefreshStrategy],
  controllers: [AuthController],
})
export class AuthModule {}
```

```typescript
// jwt.strategy.ts
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';

export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.jwtAccessSecret,
    });
  }

  validate(payload: { sub: string; email: string }) {
    return { id: payload.sub, email: payload.email };
  }
}
```

```typescript
// jwt-auth.guard.ts
import { AuthGuard } from '@nestjs/passport';

export class JwtAuthGuard extends AuthGuard('jwt') {}

// Usage on any controller:
@UseGuards(JwtAuthGuard)
@Get('memories')
findAll(@Req() req) {
  return this.memoryService.findAll(req.user.id);
}
```

---

## 2. Password Hashing

### Recommendation: `argon2`

| Package | Version | Purpose |
|---------|---------|---------|
| `argon2` | `^0.43.0` | Argon2id password hashing (winner of PHC) |

### Why argon2 over bcrypt

| Criterion | argon2 | bcrypt |
|-----------|--------|--------|
| Algorithm | Argon2id (memory-hard + CPU-hard) | bcrypt (CPU-hard only) |
| GPU resistance | Strong (memory-hard defeats GPU parallelism) | Weak (GPU-crackable at scale) |
| OWASP recommendation | Primary recommendation (2024+) | Acceptable but second choice |
| Node.js native bindings | Yes, via node-gyp | Yes, via node-gyp |
| npm weekly downloads | ~1.5M | ~2.5M (legacy inertia) |
| Prebuilt binaries | Yes (prebuild-install) | Yes |
| WASM fallback | Yes (`argon2-browser` for client-side) | No |

The `bcrypt` npm package is fine but it only provides CPU-hardness. Argon2id adds memory-hardness, which is critical for resisting modern GPU/ASIC attacks. OWASP's 2024 password storage cheat sheet lists Argon2id as the primary recommendation.

### Usage Pattern

```typescript
import * as argon2 from 'argon2';

// Hash on registration
const hash = await argon2.hash(password, {
  type: argon2.argon2id,
  memoryCost: 65536,    // 64 MiB
  timeCost: 3,          // 3 iterations
  parallelism: 4,       // 4 threads
});

// Verify on login
const valid = await argon2.verify(storedHash, password);
```

```typescript
// users.service.ts
@Injectable()
export class UsersService {
  async create(email: string, password: string) {
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    return this.db.insert(users).values({
      id: randomUUID(),
      email,
      passwordHash: hash,
      createdAt: new Date().toISOString(),
    });
  }

  async validateCredentials(email: string, password: string) {
    const user = await this.db.query.users.findFirst({
      where: eq(users.email, email),
    });
    if (!user || !await argon2.verify(user.passwordHash, password)) {
      throw new UnauthorizedException();
    }
    return user;
  }
}
```

---

## 3. JWT Implementation

### Recommendation: `@nestjs/jwt` (wraps `jsonwebtoken` internally)

| Option | Verdict |
|--------|---------|
| `jsonwebtoken` | Used internally by `@nestjs/jwt`. No need to use directly. |
| `jose` | Modern, Web Crypto API based, ESM-native. Better for edge runtimes (Cloudflare Workers). Overkill for a NestJS server where `@nestjs/jwt` already handles everything. |

**Use `@nestjs/jwt`** -- it wraps `jsonwebtoken` and provides NestJS DI integration. No reason to use `jose` or raw `jsonwebtoken` when the NestJS module exists.

### Token Architecture: Access + Refresh

```
Access Token (15 min):
  - Sent as: Authorization: Bearer <token>
  - Payload: { sub: userId, email, iat, exp }
  - Storage: In-memory (React state / Zustand)
  - Signed with: JWT_ACCESS_SECRET

Refresh Token (7 days):
  - Sent as: httpOnly secure cookie
  - Payload: { sub: userId, jti: tokenId, iat, exp }
  - Storage: httpOnly cookie (browser) + hashed in DB (server)
  - Signed with: JWT_REFRESH_SECRET (different from access secret)
```

### Token Rotation Flow

```typescript
// auth.service.ts
@Injectable()
export class AuthService {
  constructor(
    private jwt: JwtService,
    private users: UsersService,
    private config: ConfigService,
  ) {}

  async login(user: { id: string; email: string }) {
    const accessToken = this.jwt.sign(
      { sub: user.id, email: user.email },
      { secret: this.config.jwtAccessSecret, expiresIn: '15m' },
    );

    const refreshTokenId = randomUUID();
    const refreshToken = this.jwt.sign(
      { sub: user.id, jti: refreshTokenId },
      { secret: this.config.jwtRefreshSecret, expiresIn: '7d' },
    );

    // Store hashed refresh token in DB for revocation
    await this.users.saveRefreshToken(user.id, refreshTokenId);

    return { accessToken, refreshToken };
  }

  async refresh(oldRefreshToken: string) {
    const payload = this.jwt.verify(oldRefreshToken, {
      secret: this.config.jwtRefreshSecret,
    });

    // Check token hasn't been revoked
    const valid = await this.users.validateRefreshToken(payload.sub, payload.jti);
    if (!valid) throw new UnauthorizedException('Token revoked');

    // Rotate: invalidate old, issue new pair
    await this.users.revokeRefreshToken(payload.sub, payload.jti);
    return this.login({ id: payload.sub, email: payload.email });
  }
}
```

### Cookie Configuration

```typescript
// auth.controller.ts
@Post('refresh')
async refresh(@Req() req: Request, @Res() res: Response) {
  const oldToken = req.cookies['refresh_token'];
  const { accessToken, refreshToken } = await this.auth.refresh(oldToken);

  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production', // HTTPS only in prod
    sameSite: 'strict',
    path: '/api/auth/refresh',                     // Only sent to refresh endpoint
    maxAge: 7 * 24 * 60 * 60 * 1000,              // 7 days
  });

  return res.json({ accessToken });
}
```

### Required Additional Package

| Package | Version | Purpose |
|---------|---------|---------|
| `cookie-parser` | `^1.4.7` | Parse cookies in Express (needed for refresh token cookie) |
| `@types/cookie-parser` | `^1.4.7` | TypeScript types |

```typescript
// main.ts
import * as cookieParser from 'cookie-parser';
app.use(cookieParser());
```

---

## 4. Firebase Admin SDK (Server-Side)

### Package

| Package | Version | Purpose |
|---------|---------|---------|
| `firebase-admin` | `^13.0.0` | Server-side Firebase token verification in NestJS guards |

### Purpose in Botmem

Firebase Auth provides social login (Google, Apple, GitHub) and phone auth without building OAuth flows from scratch. The server verifies Firebase ID tokens to authenticate users, rather than managing OAuth client secrets for each provider.

### Integration Pattern

```typescript
// firebase-admin.service.ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import * as admin from 'firebase-admin';

@Injectable()
export class FirebaseAdminService implements OnModuleInit {
  private app: admin.app.App;

  onModuleInit() {
    this.app = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  }

  async verifyIdToken(idToken: string): Promise<admin.auth.DecodedIdToken> {
    return admin.auth().verifyIdToken(idToken);
  }

  async getUser(uid: string): Promise<admin.auth.UserRecord> {
    return admin.auth().getUser(uid);
  }
}
```

```typescript
// firebase-auth.guard.ts
@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  constructor(private firebase: FirebaseAdminService, private users: UsersService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const idToken = request.headers.authorization?.replace('Bearer ', '');
    if (!idToken) return false;

    try {
      const decoded = await this.firebase.verifyIdToken(idToken);
      // Find or create local user from Firebase UID
      request.user = await this.users.findOrCreateFromFirebase(decoded);
      return true;
    } catch {
      return false;
    }
  }
}
```

### Dual Auth Strategy

The system should support BOTH native JWT auth (email+password) and Firebase auth (social/phone). The guard checks the token format:

```typescript
// combined-auth.guard.ts — tries JWT first, falls back to Firebase
@Injectable()
export class CombinedAuthGuard implements CanActivate {
  constructor(
    private jwt: JwtService,
    private firebase: FirebaseAdminService,
    private users: UsersService,
    private config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = request.headers.authorization?.replace('Bearer ', '');
    if (!token) return false;

    // Try native JWT first (fast, no network call)
    try {
      const payload = this.jwt.verify(token, { secret: this.config.jwtAccessSecret });
      request.user = { id: payload.sub, email: payload.email };
      return true;
    } catch {}

    // Fall back to Firebase (network call to Google)
    try {
      const decoded = await this.firebase.verifyIdToken(token);
      request.user = await this.users.findOrCreateFromFirebase(decoded);
      return true;
    } catch {}

    return false;
  }
}
```

---

## 5. Firebase Client SDK (React Frontend)

### Package

| Package | Version | Purpose |
|---------|---------|---------|
| `firebase` | `^11.0.0` | Client-side Firebase Auth (login/register UI) |

### Integration with React 19 + Zustand

```typescript
// lib/firebase.ts
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

const app = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
});

export const auth = getAuth(app);
```

```typescript
// store/authStore.ts
import { create } from 'zustand';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  type User,
} from 'firebase/auth';
import { auth } from '../lib/firebase';

interface AuthState {
  user: User | null;
  accessToken: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
  init: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  accessToken: null,
  loading: true,

  init: () => {
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        const token = await user.getIdToken();
        set({ user, accessToken: token, loading: false });
      } else {
        set({ user: null, accessToken: null, loading: false });
      }
    });
  },

  login: async (email, password) => {
    await signInWithEmailAndPassword(auth, email, password);
  },

  register: async (email, password) => {
    await createUserWithEmailAndPassword(auth, email, password);
  },

  loginWithGoogle: async () => {
    await signInWithPopup(auth, new GoogleAuthProvider());
  },

  logout: async () => {
    await auth.signOut();
    set({ user: null, accessToken: null });
  },
}));
```

### Token Auto-Refresh

Firebase SDK handles access token refresh automatically (tokens expire every 1 hour). Use `user.getIdToken(true)` to force refresh. Add an Axios/fetch interceptor:

```typescript
// lib/api.ts
const api = {
  async fetch(path: string, init?: RequestInit) {
    const user = auth.currentUser;
    const token = user ? await user.getIdToken() : null;

    return fetch(`/api${path}`, {
      ...init,
      headers: {
        ...init?.headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  },
};
```

### Bundle Size Consideration

Firebase Auth SDK adds ~40-50 KB gzipped. Use tree-shakeable modular imports (v9+ syntax shown above) to minimize. Do NOT import from `firebase/compat`.

---

## 6. AES-256-GCM Encryption at Rest

### Recommendation: Node.js `crypto` module (built-in)

| Option | Verdict |
|--------|---------|
| `node:crypto` (built-in) | Use this. AES-256-GCM is natively supported, zero dependencies, audited as part of Node.js/OpenSSL. |
| `libsodium-wrappers` | Overkill for server-side symmetric encryption. Adds ~200 KB dependency. Its value is cross-platform + browser support, which is irrelevant for a NestJS backend. |

### Implementation

```typescript
// crypto.service.ts
import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

@Injectable()
export class CryptoService {
  private readonly algorithm = 'aes-256-gcm';
  private readonly key: Buffer;

  constructor(private config: ConfigService) {
    // Derive a 256-bit key from the master secret using scrypt
    const masterSecret = this.config.encryptionMasterKey;
    if (!masterSecret) throw new Error('ENCRYPTION_MASTER_KEY env var is required');
    this.key = scryptSync(masterSecret, 'botmem-salt', 32);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12); // 96-bit IV for GCM
    const cipher = createCipheriv(this.algorithm, this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag(); // 128-bit auth tag

    // Format: base64(iv + tag + ciphertext)
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
  }

  decrypt(ciphertext: string): string {
    const data = Buffer.from(ciphertext, 'base64');
    const iv = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const encrypted = data.subarray(28);

    const decipher = createDecipheriv(this.algorithm, this.key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf8');
  }
}
```

### What to Encrypt

The schema already has comments indicating these should be encrypted:

- `accounts.auth_context` -- OAuth tokens, session credentials
- `connector_credentials.credentials` -- OAuth client secrets, API keys

Both are stored as plaintext JSON today. The `CryptoService` should wrap reads/writes to these columns:

```typescript
// accounts.service.ts (updated)
async create(data: { connectorType: string; identifier: string; authContext?: object }) {
  const encrypted = data.authContext
    ? this.crypto.encrypt(JSON.stringify(data.authContext))
    : null;

  await this.db.insert(accounts).values({
    id: randomUUID(),
    connectorType: data.connectorType,
    identifier: data.identifier,
    authContext: encrypted,
    // ...
  });
}

async getAuthContext(accountId: string): Promise<object | null> {
  const row = await this.db.query.accounts.findFirst({ where: eq(accounts.id, accountId) });
  if (!row?.authContext) return null;
  return JSON.parse(this.crypto.decrypt(row.authContext));
}
```

### Environment Variable

```
ENCRYPTION_MASTER_KEY=<random-64-char-hex-string>
```

Generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

---

## 7. Argon2id Key Derivation for E2EE

### Package (same as password hashing)

| Package | Version | Purpose |
|---------|---------|---------|
| `argon2` | `^0.43.0` | Server-side Argon2id (password hashing + key derivation) |
| `argon2-browser` | `^1.18.0` | Client-side WASM Argon2id (E2EE key derivation from password) |

### Use Case

For end-to-end encryption (E2EE), the user's password is used to derive an encryption key on the **client side**. The server never sees this key. This protects connector credentials so that even a database breach doesn't expose OAuth tokens.

### Client-Side Key Derivation

```typescript
// lib/e2ee.ts (React frontend)
import argon2 from 'argon2-browser';

export async function deriveEncryptionKey(
  password: string,
  salt: Uint8Array, // stored on server, unique per user
): Promise<CryptoKey> {
  const result = await argon2.hash({
    pass: password,
    salt: salt,
    type: argon2.ArgonType.Argon2id,
    time: 3,       // iterations
    mem: 65536,     // 64 MiB
    parallelism: 4,
    hashLen: 32,    // 256 bits for AES-256
  });

  // Import raw key material into Web Crypto API
  return crypto.subtle.importKey(
    'raw',
    result.hash,
    { name: 'AES-GCM' },
    false, // not extractable
    ['encrypt', 'decrypt'],
  );
}

export async function encryptForStorage(
  key: CryptoKey,
  plaintext: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded,
  );
  // Concatenate iv + ciphertext, encode as base64
  const combined = new Uint8Array(iv.length + new Uint8Array(encrypted).length);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  return btoa(String.fromCharCode(...combined));
}
```

### Architecture Note

E2EE is a v2.0+ feature. The initial auth milestone should focus on server-side encryption (section 6) first. E2EE adds significant UX complexity (key recovery, device sync, password change re-encryption). Plan it as a separate phase.

---

## 8. Drizzle ORM + PostgreSQL Migration

### Packages

| Package | Version | Purpose |
|---------|---------|---------|
| `drizzle-orm` | `^0.38.0` | Already installed. Same package, different import path. |
| `postgres` | `^3.4.0` | PostgreSQL driver (postgres.js -- fastest pure-JS PG driver) |
| `drizzle-kit` | `^0.30.0` | Already installed. Schema migrations. |

### Why `postgres` (postgres.js) over `pg`

| Criterion | postgres (postgres.js) | pg (node-postgres) |
|-----------|----------------------|---------------------|
| Performance | 2-5x faster (tagged template queries, no query parsing overhead) | Standard |
| API | Modern tagged templates `sql\`SELECT...\`` | Callback/promise `.query()` |
| Connection pooling | Built-in | Requires `pg-pool` separately |
| TypeScript | Native TypeScript | `@types/pg` needed |
| Drizzle integration | `drizzle-orm/postgres-js` | `drizzle-orm/node-postgres` |
| ESM support | Native ESM | CJS with ESM shims |

### Schema Migration: SQLite to PostgreSQL

The Drizzle schema file (`apps/api/src/db/schema.ts`) needs to change imports from `drizzle-orm/sqlite-core` to `drizzle-orm/pg-core`. Key differences:

```typescript
// BEFORE (SQLite)
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  createdAt: text('created_at').notNull(),
});

// AFTER (PostgreSQL)
import { pgTable, text, integer, real, timestamp, uuid, boolean } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  firebaseUid: text('firebase_uid').unique(),
  encryptionSalt: text('encryption_salt'), // for E2EE key derivation
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
```

### Key Type Differences: SQLite vs PostgreSQL in Drizzle

| SQLite | PostgreSQL | Notes |
|--------|-----------|-------|
| `text('id')` | `uuid('id').defaultRandom()` | Use native UUID type |
| `text('created_at')` storing ISO strings | `timestamp('created_at', { withTimezone: true })` | Native timestamps |
| `integer('count')` | `integer('count')` | Same |
| `real('score')` | `real('score')` or `doublePrecision('score')` | Same or upgrade precision |
| `text('json_col')` storing JSON strings | `jsonb('json_col')` | Native JSONB for indexable JSON |
| No boolean type | `boolean('active')` | Native boolean |

### DbService Migration

```typescript
// db.service.ts (PostgreSQL version)
import { Injectable, OnModuleInit } from '@nestjs/common';
import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import * as schema from './schema';

@Injectable()
export class DbService implements OnModuleInit {
  public db!: PostgresJsDatabase<typeof schema>;
  private sql!: postgres.Sql;

  constructor(private config: ConfigService) {}

  async onModuleInit() {
    this.sql = postgres(this.config.databaseUrl, {
      max: 20,                    // connection pool size
      idle_timeout: 20,
      connect_timeout: 10,
    });
    this.db = drizzle(this.sql, { schema });

    // Run migrations
    await migrate(this.db, { migrationsFolder: './drizzle' });
  }

  async onModuleDestroy() {
    await this.sql.end();
  }
}
```

### Environment Variable

```
DATABASE_URL=postgresql://botmem:password@localhost:5432/botmem
```

### docker-compose Addition

```yaml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: botmem
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-botmem_dev}
      POSTGRES_DB: botmem
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
```

---

## 9. PostgreSQL Row Level Security (RLS) with Drizzle

### How RLS Works

RLS enforces data isolation at the database level. Even if application code has a bug that omits a `WHERE user_id = ?` clause, PostgreSQL will filter rows based on the current session's user context.

### Implementation Pattern

RLS cannot be defined in Drizzle schema files -- it requires raw SQL. Use Drizzle migrations or a setup script:

```sql
-- migrations/0001_enable_rls.sql

-- Enable RLS on all user-scoped tables
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;

-- Create policies: users can only see their own data
-- Assumes a `user_id` column on each table

CREATE POLICY memories_user_isolation ON memories
  USING (user_id = current_setting('app.current_user_id')::uuid);

CREATE POLICY accounts_user_isolation ON accounts
  USING (user_id = current_setting('app.current_user_id')::uuid);

CREATE POLICY contacts_user_isolation ON contacts
  USING (user_id = current_setting('app.current_user_id')::uuid);

CREATE POLICY raw_events_user_isolation ON raw_events
  USING (account_id IN (
    SELECT id FROM accounts WHERE user_id = current_setting('app.current_user_id')::uuid
  ));

CREATE POLICY jobs_user_isolation ON jobs
  USING (account_id IN (
    SELECT id FROM accounts WHERE user_id = current_setting('app.current_user_id')::uuid
  ));
```

### Setting Session Variables per Request

The critical piece: set `app.current_user_id` at the start of every request, so RLS policies know which user is making the query.

```typescript
// rls.middleware.ts
import { Injectable, NestMiddleware } from '@nestjs/common';
import { DbService } from '../db/db.service';

@Injectable()
export class RlsMiddleware implements NestMiddleware {
  constructor(private dbService: DbService) {}

  async use(req: any, res: any, next: () => void) {
    if (req.user?.id) {
      // Set the session variable for this connection
      await this.dbService.sql`SELECT set_config('app.current_user_id', ${req.user.id}, true)`;
      // The `true` parameter means "local to current transaction"
    }
    next();
  }
}
```

### Drizzle + RLS: Important Caveat

Drizzle ORM does not have native RLS support in its schema DSL. You must:

1. Define RLS policies via raw SQL migrations (as shown above)
2. Use `drizzle-kit` custom migration files
3. Set session variables via raw `sql` tagged templates before queries

```typescript
// Alternative: wrap queries in a transaction with session variable
async findMemories(userId: string) {
  return this.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${userId}, true)`);
    return tx.select().from(memories); // RLS automatically filters
  });
}
```

### Connection Pooling Consideration

With `postgres.js`, the `set_config(..., true)` call is transaction-local. This is safe with connection pooling because the setting doesn't leak to other requests. Without the `true` flag, the setting would persist on the connection and could leak between users.

### Schema Changes Required for Multi-Tenancy

Every user-scoped table needs a `user_id` column:

```typescript
// schema.ts additions for multi-tenancy
export const accounts = pgTable('accounts', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id), // NEW
  connectorType: text('connector_type').notNull(),
  // ...
});

export const memories = pgTable('memories', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id), // NEW
  accountId: uuid('account_id').references(() => accounts.id),
  // ...
});

export const contacts = pgTable('contacts', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id), // NEW
  displayName: text('display_name').notNull(),
  // ...
});
```

---

## Complete Package List

### API (`apps/api`)

```bash
# Auth
pnpm --filter @botmem/api add @nestjs/jwt@^11.0.0 @nestjs/passport@^11.0.0 passport@^0.7.0 passport-jwt@^4.0.1 passport-local@^1.0.0 cookie-parser@^1.4.7

# Types
pnpm --filter @botmem/api add -D @types/passport-jwt@^4.0.1 @types/passport-local@^1.0.38 @types/cookie-parser@^1.4.7

# Password hashing
pnpm --filter @botmem/api add argon2@^0.43.0

# Firebase (server)
pnpm --filter @botmem/api add firebase-admin@^13.0.0

# PostgreSQL (replaces better-sqlite3)
pnpm --filter @botmem/api add postgres@^3.4.0
# Remove: pnpm --filter @botmem/api remove better-sqlite3 @types/better-sqlite3
```

### Web (`apps/web`)

```bash
# Firebase (client)
pnpm --filter @botmem/web add firebase@^11.0.0

# E2EE key derivation (optional, v2.0+ phase)
pnpm --filter @botmem/web add argon2-browser@^1.18.0
```

### Environment Variables to Add

```env
# JWT
JWT_ACCESS_SECRET=<random-64-char-hex>
JWT_REFRESH_SECRET=<different-random-64-char-hex>

# Encryption
ENCRYPTION_MASTER_KEY=<random-64-char-hex>

# Firebase
FIREBASE_PROJECT_ID=botmem-xxxxx
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@botmem-xxxxx.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

# Frontend (Vite)
VITE_FIREBASE_API_KEY=AIzaSy...
VITE_FIREBASE_AUTH_DOMAIN=botmem-xxxxx.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=botmem-xxxxx

# PostgreSQL (replaces DB_PATH)
DATABASE_URL=postgresql://botmem:password@localhost:5432/botmem
```

---

## Migration Strategy

### Phase Order

1. **Auth first** (JWT + password hashing + guards) -- works with SQLite, no DB migration needed
2. **Encryption at rest** (AES-256-GCM for authContext/credentials) -- works with SQLite
3. **Firebase integration** (social login) -- works with SQLite
4. **PostgreSQL migration** (schema conversion + data migration) -- requires downtime
5. **RLS policies** (row-level security) -- requires PostgreSQL
6. **E2EE** (client-side key derivation) -- optional future phase

This order minimizes risk: auth and encryption ship on the current SQLite stack. PostgreSQL migration is a separate, well-scoped step.

---

## Alternatives Considered

| Category | Chosen | Alternative | Why Not |
|----------|--------|-------------|---------|
| Auth framework | @nestjs/passport | Custom guards only | Passport ecosystem has battle-tested strategies; reinventing auth is a security risk |
| Password hashing | argon2 (Argon2id) | bcrypt | Argon2id is memory-hard (GPU-resistant), OWASP primary recommendation |
| JWT library | @nestjs/jwt (wraps jsonwebtoken) | jose | jose is better for edge/browser; @nestjs/jwt integrates with DI natively |
| Encryption | Node.js crypto (built-in) | libsodium-wrappers | No dependency needed; AES-256-GCM in Node crypto is identical to libsodium's aead_aes256gcm |
| PG driver | postgres (postgres.js) | pg (node-postgres) | Faster, native TypeScript, built-in pooling, better ESM support |
| ORM | Drizzle (keep) | Prisma / TypeORM | Already using Drizzle; migration would be massive. Drizzle supports PG natively. |
| Auth provider | Firebase Auth | Auth0 / Clerk / Supabase Auth | Firebase has generous free tier (10K MAU), full SDK, phone auth. Auth0 free tier is 7.5K MAU. Clerk is $0.02/MAU after 10K. Firebase is the most cost-effective for a personal tool that may scale. |
| Client E2EE | argon2-browser (WASM) | Web Crypto PBKDF2 | Argon2id is significantly more GPU-resistant than PBKDF2; WASM overhead is acceptable for a one-time key derivation |

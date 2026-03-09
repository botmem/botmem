# Phase 20: Encryption at Rest - Research

**Researched:** 2026-03-09
**Domain:** AES-256-GCM credential encryption, data migration, startup validation
**Confidence:** HIGH

## Summary

Phase 20 is a focused infrastructure phase that closes two remaining gaps in encryption at rest. The CryptoService (AES-256-GCM) already exists and is already wired into accounts.service.ts and auth.service.ts for encrypt-on-write/decrypt-on-read. What remains is: (1) a standalone migration script to encrypt existing plaintext credential rows, and (2) making APP_SECRET required at startup with a fail-fast error.

This is a low-risk, high-confidence phase. All crypto primitives are built and tested. The migration script follows an established pattern (migrate-banks.ts). The startup validation follows an established pattern (DATABASE_URL validation in config.service.ts). No new libraries are needed.

**Primary recommendation:** Follow existing patterns exactly -- migrate-banks.ts for the migration script, OnModuleInit for APP_SECRET validation. The only novel work is the idempotent encryption logic using CryptoService.isEncrypted().

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions

- Idempotent migration: use CryptoService.isEncrypted() to skip already-encrypted rows
- Migrate both `accounts.authContext` and `connectorCredentials.credentials` columns
- Log count of migrated vs skipped rows for auditability
- Follow same pattern as `apps/api/scripts/migrate-banks.ts` (standalone script, uses Drizzle directly)
- Fail fast at startup if APP_SECRET is missing or equals the default dev value in production
- Use OnModuleInit pattern (same as DATABASE_URL validation from Phase 22)
- Dev mode: allow the default secret for local development convenience

### Claude's Discretion

- Migration script naming and exact CLI invocation
- Whether to add a dry-run flag to the migration
- Error handling for rows that fail to encrypt (skip and log, or abort)

### Deferred Ideas (OUT OF SCOPE)

None

</user_constraints>

<phase_requirements>

## Phase Requirements

| ID     | Description                                                                                                                       | Research Support                                                                                                                                                                                                                                  |
| ------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ENC-01 | AES-256-GCM encryption for `authContext` (accounts table) and `connectorCredentials` table, key derived from `APP_SECRET` env var | CryptoService already implements AES-256-GCM with scrypt key derivation from APP_SECRET. Encrypt-on-write/decrypt-on-read already wired in accounts.service.ts and auth.service.ts. Migration script needed only for pre-existing plaintext rows. |
| ENC-02 | Migration script to encrypt existing plaintext credentials with zero downtime                                                     | migrate-banks.ts pattern provides the template. CryptoService.isEncrypted() enables idempotent skip logic. Raw SQL via pg Pool for standalone execution without NestJS DI.                                                                        |

</phase_requirements>

## Standard Stack

### Core

| Library            | Version  | Purpose                                           | Why Standard                  |
| ------------------ | -------- | ------------------------------------------------- | ----------------------------- |
| Node.js crypto     | built-in | AES-256-GCM, scrypt                               | Already used by CryptoService |
| pg (node-postgres) | existing | Direct DB access in migration scripts             | Pattern from migrate-banks.ts |
| drizzle-orm        | existing | Schema reference (not used directly in migration) | Project ORM                   |

### Supporting

No additional libraries needed. Everything is already in the project.

### Alternatives Considered

None -- all infrastructure exists, no new libraries required.

## Architecture Patterns

### Existing CryptoService Pattern

**What:** AES-256-GCM with scrypt key derivation, iv:ciphertext:tag format
**Already implemented:** `apps/api/src/crypto/crypto.service.ts`

Key behaviors already built:

- `encrypt(plaintext)` -- returns `iv:ciphertext:tag` base64 string
- `decrypt(ciphertext)` -- returns plaintext; passes through non-encrypted strings gracefully
- `isEncrypted(value)` -- checks iv:ciphertext:tag format (iv=12 bytes, tag=16 bytes)
- Null-safe: encrypt/decrypt return null for null/undefined input

### Encrypt-on-Write / Decrypt-on-Read Pattern (Already Wired)

**accounts.service.ts:**

- `create()` -- encrypts authContext before INSERT
- `update()` -- encrypts authContext before UPDATE
- `getAll()`, `getById()`, `getByConnectorAndIdentifier()` -- decrypt authContext on read

**auth.service.ts:**

- `getConnectorCredentials()` -- decrypts credentials on read
- `saveConnectorCredentials()` -- encrypts credentials before UPSERT

### Migration Script Pattern (from migrate-banks.ts)

**What:** Standalone TypeScript script using pg Pool directly, run via `npx tsx`
**Pattern:**

1. Read DATABASE_URL from env (fail if missing)
2. Create pg Pool connection
3. Query rows, transform, update
4. Log summary counts
5. Close pool
6. `main().catch()` wrapper for CJS/tsx compatibility

### APP_SECRET Validation Pattern (from config.service.ts)

**What:** OnModuleInit fail-fast for required secrets
**Already partially implemented:** `validateProductionSecrets()` checks APP_SECRET in production mode
**Gap:** No check for missing APP_SECRET entirely (only checks default value in production)

### Recommended Migration Script Structure

```
apps/api/scripts/
  migrate-banks.ts       # existing
  migrate-encryption.ts  # new -- encrypts plaintext credentials
```

## Don't Hand-Roll

| Problem              | Don't Build                | Use Instead                          | Why                                                           |
| -------------------- | -------------------------- | ------------------------------------ | ------------------------------------------------------------- |
| Encryption detection | Custom regex/heuristic     | CryptoService.isEncrypted()          | Already handles edge cases (base64 validation, length checks) |
| Key derivation       | Custom PBKDF               | scrypt via CryptoService constructor | Already derives 256-bit key from APP_SECRET                   |
| Standalone DB access | NestJS bootstrap in script | pg Pool (raw SQL)                    | Simpler, faster, no DI overhead -- same as migrate-banks.ts   |

## Common Pitfalls

### Pitfall 1: Encrypting Already-Encrypted Data

**What goes wrong:** Double-encrypting a row produces gibberish that can never be decrypted
**Why it happens:** Running migration twice without idempotency check
**How to avoid:** Use `isEncrypted()` to skip rows that are already encrypted
**Warning signs:** Decrypted values look like base64 gibberish instead of JSON

### Pitfall 2: NULL vs Empty String in authContext

**What goes wrong:** Some accounts may have NULL authContext (e.g., disconnected accounts). Encrypting NULL should stay NULL.
**How to avoid:** CryptoService.encrypt() already returns null for null input. Migration script must skip NULL rows.

### Pitfall 3: Different APP_SECRET Between Script and Running App

**What goes wrong:** Migration encrypts with one key, running app tries to decrypt with another
**Why it happens:** Script run without proper .env loading
**How to avoid:** Script should read APP_SECRET from env or .env file consistently

### Pitfall 4: Colons in Plaintext Triggering False isEncrypted()

**What goes wrong:** A plaintext value like `client_id:client_secret:something` could match the 3-part colon format
**How to avoid:** isEncrypted() already validates that parts[0] decodes to exactly 12 bytes (IV) and parts[2] to exactly 16 bytes (tag). This makes false positives extremely unlikely for typical credential JSON.

### Pitfall 5: APP_SECRET Validation Too Strict for Dev

**What goes wrong:** Requiring APP_SECRET in dev mode breaks `pnpm dev` for new developers
**How to avoid:** Only enforce in production (NODE_ENV=production). Dev keeps the default value. This is already the pattern in validateProductionSecrets().

## Code Examples

### Existing: CryptoService isEncrypted check

```typescript
// Source: apps/api/src/crypto/crypto.service.ts
isEncrypted(value: string | null | undefined): boolean {
  if (value == null) return false;
  const parts = value.split(':');
  if (parts.length !== 3) return false;
  try {
    const iv = Buffer.from(parts[0], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    return iv.length === IV_LENGTH && tag.length === TAG_LENGTH;
  } catch {
    return false;
  }
}
```

### Existing: migrate-banks.ts pattern

```typescript
// Source: apps/api/scripts/migrate-banks.ts
import pg from 'pg';
const { Pool } = pg;

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('ERROR: DATABASE_URL required.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString });
  try {
    // ... migration logic ...
  } finally {
    await pool.end();
  }
}
main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
```

### Existing: APP_SECRET validation (production only)

```typescript
// Source: apps/api/src/config/config.service.ts
validateProductionSecrets(): void {
  if (process.env.NODE_ENV !== 'production') return;
  const defaults = [
    { name: 'APP_SECRET', value: this.appSecret, default: 'dev-app-secret-change-in-production' },
    // ... other secrets ...
  ];
  for (const { name, value, default: def } of defaults) {
    if (value === def) {
      throw new Error(`FATAL: ${name} is using default value in production.`);
    }
  }
}
```

### Migration: Key derivation without NestJS DI

```typescript
// For standalone script -- derive key same way as CryptoService
import { createCipheriv, randomBytes, scryptSync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT = 'botmem-enc-v1';

function deriveKey(appSecret: string): Buffer {
  return scryptSync(appSecret, SALT, 32);
}

function isEncrypted(value: string): boolean {
  const parts = value.split(':');
  if (parts.length !== 3) return false;
  try {
    const iv = Buffer.from(parts[0], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    return iv.length === IV_LENGTH && tag.length === TAG_LENGTH;
  } catch {
    return false;
  }
}

function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${encrypted.toString('base64')}:${tag.toString('base64')}`;
}
```

## State of the Art

| Old Approach                | Current Approach             | When Changed | Impact                                               |
| --------------------------- | ---------------------------- | ------------ | ---------------------------------------------------- |
| Plaintext credentials in DB | AES-256-GCM encrypt-on-write | Phase 16/22  | New writes are encrypted; old data remains plaintext |
| No APP_SECRET validation    | Production-only validation   | Phase 22     | Default secret blocked in production, allowed in dev |

**What this phase completes:**

- Backfills encryption for pre-existing plaintext rows (migration script)
- Ensures APP_SECRET is always present (not just non-default in production)

## Open Questions

1. **Should APP_SECRET be required even in dev, or only in production?**
   - What we know: CONTEXT.md says "allow the default secret for local development convenience"
   - Current behavior: validateProductionSecrets() already allows default in dev
   - Recommendation: Add a check that APP_SECRET env var EXISTS (even if default), but only throw on default VALUE in production. This matches existing behavior -- may already be sufficient. The main gap is: what if APP_SECRET is entirely unset? Currently it falls back to the default string, which works fine for dev. For production, the existing check catches it. **No change needed beyond current validation.**

2. **Dry-run flag for migration?**
   - Recommendation: Yes, add `--dry-run` flag. Low effort, high value for confidence before running in production. Script queries and counts but does not UPDATE.

## Validation Architecture

### Test Framework

| Property           | Value                           |
| ------------------ | ------------------------------- |
| Framework          | Vitest 3                        |
| Config file        | `apps/api/vitest.config.ts`     |
| Quick run command  | `pnpm vitest run --project api` |
| Full suite command | `pnpm test`                     |

### Phase Requirements to Test Map

| Req ID | Behavior                                      | Test Type | Automated Command                                                       | File Exists? |
| ------ | --------------------------------------------- | --------- | ----------------------------------------------------------------------- | ------------ |
| ENC-01 | CryptoService encrypt/decrypt/isEncrypted     | unit      | `pnpm vitest run apps/api/src/crypto/__tests__/crypto.service.test.ts`  | Yes          |
| ENC-01 | APP_SECRET missing causes startup error       | unit      | `pnpm vitest run apps/api/src/config/__tests__/config.service.test.ts`  | No -- Wave 0 |
| ENC-02 | Migration encrypts plaintext, skips encrypted | unit      | `pnpm vitest run apps/api/scripts/__tests__/migrate-encryption.test.ts` | No -- Wave 0 |

### Sampling Rate

- **Per task commit:** `pnpm vitest run apps/api/src/crypto/__tests__/`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `apps/api/scripts/__tests__/migrate-encryption.test.ts` -- covers ENC-02 migration idempotency
- [ ] Migration script test can mock pg Pool or test encryption logic in isolation

_(Existing crypto.service.test.ts covers core ENC-01 encrypt/decrypt/isEncrypted logic)_

## Sources

### Primary (HIGH confidence)

- Codebase analysis: `apps/api/src/crypto/crypto.service.ts` -- full AES-256-GCM implementation
- Codebase analysis: `apps/api/src/config/config.service.ts` -- existing APP_SECRET validation
- Codebase analysis: `apps/api/src/accounts/accounts.service.ts` -- encrypt-on-write pattern
- Codebase analysis: `apps/api/src/auth/auth.service.ts` -- encrypt-on-write pattern
- Codebase analysis: `apps/api/scripts/migrate-banks.ts` -- standalone migration pattern
- Codebase analysis: `apps/api/src/db/schema.ts` -- table definitions for accounts and connectorCredentials

### Secondary (MEDIUM confidence)

- Node.js crypto module documentation -- AES-256-GCM is well-documented and stable

### Tertiary (LOW confidence)

None -- all findings are from direct codebase analysis.

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH -- no new libraries, everything exists
- Architecture: HIGH -- follows two established patterns (migration script + OnModuleInit)
- Pitfalls: HIGH -- well-understood domain, CryptoService already handles edge cases

**Research date:** 2026-03-09
**Valid until:** 2026-04-09 (stable domain, no external dependencies)

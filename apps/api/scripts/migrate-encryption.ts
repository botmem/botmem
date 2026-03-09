/**
 * Encryption migration script: Encrypt existing plaintext credentials at rest.
 *
 * Migrates:
 *  - accounts.auth_context: plaintext JSON -> encrypted (iv:ciphertext:tag)
 *  - connector_credentials.credentials: plaintext JSON -> encrypted
 *
 * Idempotent: already-encrypted rows are skipped.
 * Supports --dry-run to preview changes without modifying data.
 *
 * Usage: npx tsx apps/api/scripts/migrate-encryption.ts [--dry-run]
 */

import { createCipheriv, randomBytes, scryptSync } from 'crypto';
import pg from 'pg';

const { Pool } = pg;

// Match CryptoService constants exactly
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT = 'botmem-enc-v1';

/**
 * Derive AES-256 key from secret using scrypt (matches CryptoService).
 */
export function deriveKey(secret: string): Buffer {
  return scryptSync(secret, SALT, 32);
}

/**
 * Encrypt plaintext -> base64 string in format: iv:ciphertext:tag
 * Returns null if input is null/undefined.
 */
export function encrypt(plaintext: string | null | undefined, key: Buffer): string | null {
  if (plaintext == null) return null;
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${encrypted.toString('base64')}:${tag.toString('base64')}`;
}

/**
 * Check if a string appears to be encrypted (iv:ciphertext:tag format with correct lengths).
 */
export function isEncrypted(value: string | null | undefined): boolean {
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

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('ERROR: DATABASE_URL environment variable is required.');
    process.exit(1);
  }

  const appSecret = process.env.APP_SECRET;
  if (!appSecret) {
    console.error('ERROR: APP_SECRET environment variable is required.');
    process.exit(1);
  }

  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) {
    console.log('=== DRY RUN MODE (no changes will be made) ===\n');
  }

  const key = deriveKey(appSecret);
  const pool = new Pool({ connectionString });

  try {
    // --- Migrate accounts.auth_context ---
    const accountRows = await pool.query(
      'SELECT id, auth_context FROM accounts WHERE auth_context IS NOT NULL',
    );

    let accountsMigrated = 0;
    let accountsSkipped = 0;

    for (const row of accountRows.rows) {
      try {
        if (isEncrypted(row.auth_context)) {
          accountsSkipped++;
          continue;
        }
        const encrypted = encrypt(row.auth_context, key);
        if (!dryRun) {
          await pool.query('UPDATE accounts SET auth_context = $1 WHERE id = $2', [
            encrypted,
            row.id,
          ]);
        }
        accountsMigrated++;
      } catch (err) {
        console.error(
          `Error encrypting accounts row ${row.id}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    console.log(`accounts.auth_context:`);
    console.log(`  Total rows:  ${accountRows.rows.length}`);
    console.log(`  Migrated:    ${accountsMigrated}${dryRun ? ' (would be)' : ''}`);
    console.log(`  Skipped:     ${accountsSkipped} (already encrypted)`);

    // --- Migrate connector_credentials.credentials ---
    const credRows = await pool.query(
      'SELECT connector_type, credentials FROM connector_credentials',
    );

    let credsMigrated = 0;
    let credsSkipped = 0;

    for (const row of credRows.rows) {
      try {
        if (isEncrypted(row.credentials)) {
          credsSkipped++;
          continue;
        }
        const encrypted = encrypt(row.credentials, key);
        if (!dryRun) {
          await pool.query(
            'UPDATE connector_credentials SET credentials = $1 WHERE connector_type = $2',
            [encrypted, row.connector_type],
          );
        }
        credsMigrated++;
      } catch (err) {
        console.error(
          `Error encrypting connector_credentials row ${row.connector_type}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    console.log(`\nconnector_credentials.credentials:`);
    console.log(`  Total rows:  ${credRows.rows.length}`);
    console.log(`  Migrated:    ${credsMigrated}${dryRun ? ' (would be)' : ''}`);
    console.log(`  Skipped:     ${credsSkipped} (already encrypted)`);

    // Summary
    console.log('\n--- Migration Summary ---');
    console.log(
      `Total migrated: ${accountsMigrated + credsMigrated}${dryRun ? ' (would be)' : ''}`,
    );
    console.log(`Total skipped:  ${accountsSkipped + credsSkipped}`);
    console.log('Done.');
  } finally {
    await pool.end();
  }
}

// Only run main when executed directly (not imported in tests)
if (process.argv[1]?.includes('migrate-encryption')) {
  main().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

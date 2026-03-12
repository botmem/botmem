/**
 * Data migration: encrypt existing plaintext PII fields and backfill HMAC blind indexes.
 *
 * Usage: npx tsx apps/api/src/db/migrations/0012_encrypt_pii_data.ts
 *
 * Requires DATABASE_URL and APP_SECRET environment variables.
 * Safe to run multiple times — CryptoService.decrypt() has plaintext passthrough,
 * and CryptoService.isEncrypted() is used to skip already-encrypted rows.
 */

import { createHmac, createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import {
  accounts,
  contacts,
  contactIdentifiers,
  memoryBanks,
  memories,
  rawEvents,
  jobs,
} from '../schema';

// --- Crypto helpers (standalone, no NestJS DI) ---

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT = 'botmem-enc-v1';
const HMAC_SALT = 'botmem-hmac-v1';

const APP_SECRET = process.env.APP_SECRET || 'dev-app-secret-change-in-production';
const key = scryptSync(APP_SECRET, SALT, 32);
const hmacKey = scryptSync(APP_SECRET, HMAC_SALT, 32);

function encrypt(plaintext: string | null | undefined): string | null {
  if (plaintext == null) return null;
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${encrypted.toString('base64')}:${tag.toString('base64')}`;
}

function decrypt(ciphertext: string | null | undefined): string | null {
  if (ciphertext == null) return null;
  const parts = ciphertext.split(':');
  if (parts.length !== 3) return ciphertext;
  try {
    const iv = Buffer.from(parts[0], 'base64');
    const encrypted = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) return ciphertext;
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf8');
  } catch {
    return ciphertext;
  }
}

function isEncrypted(value: string | null | undefined): boolean {
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

function hmac(plaintext: string): string {
  return createHmac('sha256', hmacKey).update(plaintext).digest('hex');
}

const BATCH_SIZE = 500;

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);

  console.log('Starting PII encryption migration...\n');

  // --- 1. Accounts: encrypt identifier, backfill identifier_hash ---
  {
    const rows = await db.select().from(accounts);
    let encrypted = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      for (const row of batch) {
        const plainIdentifier = decrypt(row.identifier) ?? row.identifier;
        const needsEncrypt = !isEncrypted(row.identifier);
        const needsHash = !row.identifierHash;
        if (needsEncrypt || needsHash) {
          await db
            .update(accounts)
            .set({
              identifier: needsEncrypt ? encrypt(plainIdentifier)! : row.identifier,
              identifierHash: hmac(plainIdentifier),
            })
            .where(eq(accounts.id, row.id));
          encrypted++;
        }
      }
    }
    console.log(`accounts: ${encrypted}/${rows.length} rows updated`);
  }

  // --- 2. Contacts: encrypt displayName, backfill display_name_hash ---
  {
    const rows = await db.select().from(contacts);
    let encrypted = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      for (const row of batch) {
        const plainName = decrypt(row.displayName) ?? row.displayName;
        const needsEncrypt = !isEncrypted(row.displayName);
        const needsHash = !row.displayNameHash;
        if (needsEncrypt || needsHash) {
          await db
            .update(contacts)
            .set({
              displayName: needsEncrypt ? encrypt(plainName)! : row.displayName,
              displayNameHash: hmac(plainName.toLowerCase()),
            })
            .where(eq(contacts.id, row.id));
          encrypted++;
        }
      }
    }
    console.log(`contacts: ${encrypted}/${rows.length} rows updated`);
  }

  // --- 3. Contact identifiers: encrypt identifierValue, backfill identifier_value_hash ---
  {
    const rows = await db.select().from(contactIdentifiers);
    let encrypted = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      for (const row of batch) {
        const plainValue = decrypt(row.identifierValue) ?? row.identifierValue;
        const needsEncrypt = !isEncrypted(row.identifierValue);
        const needsHash = !row.identifierValueHash;
        if (needsEncrypt || needsHash) {
          await db
            .update(contactIdentifiers)
            .set({
              identifierValue: needsEncrypt ? encrypt(plainValue)! : row.identifierValue,
              identifierValueHash: hmac(plainValue),
            })
            .where(eq(contactIdentifiers.id, row.id));
          encrypted++;
        }
      }
    }
    console.log(`contact_identifiers: ${encrypted}/${rows.length} rows updated`);
  }

  // --- 4. Memory banks: encrypt name, backfill name_hash ---
  {
    const rows = await db.select().from(memoryBanks);
    let encrypted = 0;
    for (const row of rows) {
      const plainName = decrypt(row.name) ?? row.name;
      const needsEncrypt = !isEncrypted(row.name);
      const needsHash = !row.nameHash;
      if (needsEncrypt || needsHash) {
        await db
          .update(memoryBanks)
          .set({
            name: needsEncrypt ? encrypt(plainName)! : row.name,
            nameHash: hmac(plainName.toLowerCase()),
          })
          .where(eq(memoryBanks.id, row.id));
        encrypted++;
      }
    }
    console.log(`memory_banks: ${encrypted}/${rows.length} rows updated`);
  }

  // --- 5. Memories: encrypt factuality, backfill factuality_label ---
  {
    const rows = await db
      .select({
        id: memories.id,
        factuality: memories.factuality,
        factualityLabel: memories.factualityLabel,
      })
      .from(memories);
    let encrypted = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      for (const row of batch) {
        const needsLabel = !row.factualityLabel;
        const factStr = row.factuality as string;
        const needsEncrypt = factStr && !isEncrypted(factStr);
        if (needsEncrypt || needsLabel) {
          // Parse factuality to extract label
          let label = 'UNVERIFIED';
          const plainFact = factStr;
          try {
            const parsed = JSON.parse(plainFact);
            label = parsed?.label || 'UNVERIFIED';
          } catch {
            /* keep default */
          }
          await db
            .update(memories)
            .set({
              factuality: needsEncrypt ? encrypt(plainFact)! : factStr,
              factualityLabel: label,
            })
            .where(eq(memories.id, row.id));
          encrypted++;
        }
      }
    }
    console.log(`memories (factuality): ${encrypted}/${rows.length} rows updated`);
  }

  // --- 6. Jobs: encrypt accountIdentifier ---
  {
    const rows = await db.select().from(jobs);
    let encrypted = 0;
    for (const row of rows) {
      if (row.accountIdentifier && !isEncrypted(row.accountIdentifier)) {
        await db
          .update(jobs)
          .set({ accountIdentifier: encrypt(row.accountIdentifier) })
          .where(eq(jobs.id, row.id));
        encrypted++;
      }
    }
    console.log(`jobs: ${encrypted}/${rows.length} rows updated`);
  }

  // --- 7. Raw events: encrypt payload and cleanedText ---
  {
    const rows = await db
      .select({ id: rawEvents.id, payload: rawEvents.payload, cleanedText: rawEvents.cleanedText })
      .from(rawEvents);
    let encrypted = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      for (const row of batch) {
        const needsPayload = !isEncrypted(row.payload);
        const needsClean = row.cleanedText && !isEncrypted(row.cleanedText);
        if (needsPayload || needsClean) {
          const updates: Record<string, unknown> = {};
          if (needsPayload) updates.payload = encrypt(row.payload)!;
          if (needsClean) updates.cleanedText = encrypt(row.cleanedText!);
          await db.update(rawEvents).set(updates).where(eq(rawEvents.id, row.id));
          encrypted++;
        }
      }
    }
    console.log(`raw_events: ${encrypted}/${rows.length} rows updated`);
  }

  console.log('\nMigration complete.');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});

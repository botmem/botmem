/**
 * Data migration script: Assign existing data to default memory bank.
 *
 * Migrates:
 *  - accounts with null userId -> first user
 *  - contacts with null userId -> first user
 *  - memories with null memoryBankId -> default bank
 *  - Qdrant vectors with null memory_bank_id -> default bank ID
 *
 * Idempotent: safe to run multiple times (only targets NULL values).
 *
 * Usage: npx tsx apps/api/scripts/migrate-banks.ts
 */

import pg from 'pg';

const { Pool } = pg;

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('ERROR: DATABASE_URL environment variable is required.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString });

  try {
    // 1. Find the first user
    const userResult = await pool.query('SELECT id FROM users LIMIT 1');
    if (userResult.rows.length === 0) {
      console.log('No users found, nothing to migrate.');
      return;
    }
    const userId = userResult.rows[0].id;
    console.log(`Found user: ${userId}`);

    // 2. Ensure default bank exists
    let bankId: string;
    const bankResult = await pool.query(
      'SELECT id FROM memory_banks WHERE user_id = $1 AND is_default = true LIMIT 1',
      [userId],
    );
    if (bankResult.rows.length > 0) {
      bankId = bankResult.rows[0].id;
      console.log(`Found existing default bank: ${bankId}`);
    } else {
      const insertResult = await pool.query(
        `INSERT INTO memory_banks (id, user_id, name, is_default, created_at, updated_at)
         VALUES (gen_random_uuid()::text, $1, 'Default', true, NOW(), NOW())
         RETURNING id`,
        [userId],
      );
      bankId = insertResult.rows[0].id;
      console.log(`Created default bank: ${bankId}`);
    }

    // 3. Migrate accounts with null userId
    const accountsResult = await pool.query(
      'UPDATE accounts SET user_id = $1 WHERE user_id IS NULL',
      [userId],
    );
    console.log(`Migrated accounts: ${accountsResult.rowCount}`);

    // 4. Migrate contacts with null userId
    const contactsResult = await pool.query(
      'UPDATE contacts SET user_id = $1 WHERE user_id IS NULL',
      [userId],
    );
    console.log(`Migrated contacts: ${contactsResult.rowCount}`);

    // 5. Migrate memories with null memoryBankId
    const memoriesResult = await pool.query(
      'UPDATE memories SET memory_bank_id = $1 WHERE memory_bank_id IS NULL',
      [bankId],
    );
    console.log(`Migrated memories: ${memoriesResult.rowCount}`);

    // 6. Migrate Qdrant vectors with null memory_bank_id
    const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';
    try {
      const response = await fetch(
        `${qdrantUrl}/collections/memories/points/payload`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            payload: { memory_bank_id: bankId },
            filter: {
              must: [
                {
                  is_null: {
                    key: 'memory_bank_id',
                  },
                },
              ],
            },
          }),
        },
      );

      if (response.ok) {
        const data = await response.json();
        console.log(`Qdrant update result:`, JSON.stringify(data));
      } else {
        const text = await response.text();
        console.warn(`Qdrant update returned ${response.status}: ${text}`);
      }
    } catch (err) {
      console.warn(
        `Qdrant update failed (service may not be running): ${err instanceof Error ? err.message : err}`,
      );
    }

    // Summary
    console.log('\n--- Migration Summary ---');
    console.log(`User: ${userId}`);
    console.log(`Default bank: ${bankId}`);
    console.log(`Accounts migrated: ${accountsResult.rowCount}`);
    console.log(`Contacts migrated: ${contactsResult.rowCount}`);
    console.log(`Memories migrated: ${memoriesResult.rowCount}`);
    console.log('Done.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});

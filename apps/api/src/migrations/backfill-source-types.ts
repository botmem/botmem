/**
 * One-time migration: Fix photo memories source_type from 'file' to 'photo'.
 *
 * Run with: npx tsx apps/api/src/migrations/backfill-source-types.ts
 *
 * Updates:
 * 1. SQLite memories table: source_type 'file' -> 'photo' WHERE connector_type = 'photos'
 * 2. SQLite raw_events table: source_type 'file' -> 'photo' WHERE connector_type = 'photos'
 * 3. Qdrant memories collection: source_type payload 'file' -> 'photo' WHERE connector_type = 'photos'
 *
 * CRITICAL: Always filters by BOTH source_type='file' AND connector_type='photos'
 * to avoid affecting Slack file attachments.
 */

import Database from 'better-sqlite3';
import { QdrantClient } from '@qdrant/js-client-rest';
import { resolve } from 'path';

const dbPath = resolve(process.env.DB_PATH || './data/botmem.db');
const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';

console.log(`SQLite: ${dbPath}`);
console.log(`Qdrant: ${qdrantUrl}`);

// --- SQLite ---
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Before counts
console.log('\n--- Before (memories) ---');
const beforeMemories = db.prepare(
  `SELECT source_type, COUNT(*) as count FROM memories WHERE connector_type = 'photos' GROUP BY source_type`,
).all() as Array<{ source_type: string; count: number }>;
if (beforeMemories.length === 0) {
  console.log('  No photo memories found');
} else {
  for (const row of beforeMemories) {
    console.log(`  source_type='${row.source_type}': ${row.count}`);
  }
}

console.log('\n--- Before (raw_events) ---');
const beforeRaw = db.prepare(
  `SELECT source_type, COUNT(*) as count FROM raw_events WHERE connector_type = 'photos' GROUP BY source_type`,
).all() as Array<{ source_type: string; count: number }>;
if (beforeRaw.length === 0) {
  console.log('  No photo raw_events found');
} else {
  for (const row of beforeRaw) {
    console.log(`  source_type='${row.source_type}': ${row.count}`);
  }
}

// Update in transaction
const tx = db.transaction(() => {
  const memResult = db.prepare(
    `UPDATE memories SET source_type = 'photo' WHERE connector_type = 'photos' AND source_type = 'file'`,
  ).run();
  console.log(`\nUpdated ${memResult.changes} memories`);

  const rawResult = db.prepare(
    `UPDATE raw_events SET source_type = 'photo' WHERE connector_type = 'photos' AND source_type = 'file'`,
  ).run();
  console.log(`Updated ${rawResult.changes} raw_events`);
});

tx();

// After counts
console.log('\n--- After (memories) ---');
const afterMemories = db.prepare(
  `SELECT source_type, COUNT(*) as count FROM memories WHERE connector_type = 'photos' GROUP BY source_type`,
).all() as Array<{ source_type: string; count: number }>;
if (afterMemories.length === 0) {
  console.log('  No photo memories found');
} else {
  for (const row of afterMemories) {
    console.log(`  source_type='${row.source_type}': ${row.count}`);
  }
}

// --- Qdrant ---
const qdrant = new QdrantClient({ url: qdrantUrl });

async function updateQdrant() {
  try {
    await qdrant.setPayload('memories', {
      payload: { source_type: 'photo' },
      filter: {
        must: [
          { key: 'source_type', match: { value: 'file' } },
          { key: 'connector_type', match: { value: 'photos' } },
        ],
      },
      wait: true,
    });
    console.log('\nQdrant payload updated successfully');
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (msg.includes('Not Found') || msg.includes("doesn't exist")) {
      console.log('\nQdrant collection not found -- skipping (no vectors to update)');
    } else {
      console.error('\nQdrant update failed:', err);
      process.exit(1);
    }
  }
}

async function main() {
  await updateQdrant();
  db.close();
  console.log('\nMigration complete');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

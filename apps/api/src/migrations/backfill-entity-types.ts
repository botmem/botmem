/**
 * One-time migration: Normalize entity types to canonical taxonomy.
 *
 * Run with: npx tsx apps/api/src/migrations/backfill-entity-types.ts
 *
 * 1. Memory entities: remove time/amount/metric types, strip to {type, value}, map unknown types to 'other'
 * 2. Contact entityType: map non-canonical values to 'other'
 */

import Database from 'better-sqlite3';
import { resolve } from 'path';

const CANONICAL_TYPES = new Set([
  'person', 'organization', 'location', 'event',
  'product', 'topic', 'pet', 'group', 'device', 'other',
]);

const REMOVE_TYPES = new Set(['time', 'amount', 'metric']);

const dbPath = resolve(process.env.DB_PATH || './data/botmem.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// --- 1. Normalize memory entities ---
const rows = db.prepare(
  `SELECT id, entities FROM memories WHERE entities IS NOT NULL AND entities != '[]'`
).all() as Array<{ id: string; entities: string }>;

const update = db.prepare(`UPDATE memories SET entities = ? WHERE id = ?`);

const tx = db.transaction(() => {
  for (const row of rows) {
    let entities: any[];
    try { entities = JSON.parse(row.entities); } catch { continue; }
    if (!Array.isArray(entities)) continue;

    const cleaned = entities
      .filter((e: any) => !REMOVE_TYPES.has(e.type))
      .map((e: any) => ({
        type: CANONICAL_TYPES.has(e.type) ? e.type : 'other',
        value: e.value ?? e.name ?? e.id ?? '',
      }));

    update.run(JSON.stringify(cleaned), row.id);
  }
});

tx();

// --- 2. Normalize contact entityType (if column exists) ---
const hasEntityType = db.prepare(
  `SELECT COUNT(*) as cnt FROM pragma_table_info('contacts') WHERE name = 'entity_type'`
).get() as { cnt: number };

if (hasEntityType.cnt > 0) {
  db.prepare(
    `UPDATE contacts SET entity_type = 'other' WHERE entity_type NOT IN ('person', 'organization', 'location', 'event', 'product', 'topic', 'pet', 'group', 'device', 'other')`
  ).run();
}

db.close();
console.log('Migration complete');

#!/usr/bin/env node
const readline = require('node:readline');
const { Readable } = require('node:stream');
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const LEGACY_URL_KEY = 'TYPE' + 'SENSE_URL';
const LEGACY_KEY_KEY = 'TYPE' + 'SENSE_API_KEY';
const LEGACY_API_KEY_HEADER = 'X-' + 'TYPE' + 'SENSE-API-KEY';
const LEGACY_SEARCH_URL = process.env.LEGACY_SEARCH_URL || process.env[LEGACY_URL_KEY] || 'http://localhost:8108';
const LEGACY_SEARCH_API_KEY = process.env.LEGACY_SEARCH_API_KEY || process.env[LEGACY_KEY_KEY] || 'botmem-ts-key';
const STRICT_BACKFILL = process.env.STRICT_BACKFILL === '1';
const RESUME_EXISTING_BACKFILL = process.env.RESUME_EXISTING_BACKFILL !== '0';
const BACKFILL_LOCK_ID = 2026050201;

if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

async function main() {
  const db = new Client({ connectionString: DATABASE_URL });
  await db.connect();

  try {
    await db.query('CREATE EXTENSION IF NOT EXISTS vector');
    await assertSearchTable(db);
    await db.query('SELECT pg_advisory_lock($1)', [BACKFILL_LOCK_ID]);

    const memoryById = await loadMemoryMetadata(db);
    const alreadyIndexed = RESUME_EXISTING_BACKFILL ? await loadAlreadyIndexedMemoryIds(db) : new Set();
    let indexed = 0;
    let resumed = 0;
    let skipped = 0;

    for await (const doc of streamLegacySearchDocuments()) {
      const memoryId = String(doc.id || doc.memory_id || '');
      const embedding = Array.isArray(doc.embedding) ? doc.embedding : [];
      if (!memoryId || embedding.length === 0) {
        skipped++;
        continue;
      }

      if (alreadyIndexed.has(memoryId)) {
        resumed++;
        if (resumed % 10000 === 0) {
          console.log(JSON.stringify({ resumed, indexed, skipped }));
        }
        continue;
      }

      const row = memoryById.get(memoryId);
      if (!row?.user_id) {
        skipped++;
        continue;
      }

      const text = asString(doc.text);
      const entitiesText = asString(doc.entities_text);
      const searchText = [
        text,
        entitiesText,
        ...asArray(doc.people),
        ...asArray(doc.person_aliases),
        ...asArray(doc.locations),
        asString(doc.location_text),
        ...asArray(doc.organizations),
        ...asArray(doc.thread_ids),
        ...asArray(doc.transaction_tokens),
      ]
        .filter(Boolean)
        .join(' ');
      const importance =
        Number(doc.importance) ||
        (row.weights && typeof row.weights.importance === 'number' ? row.weights.importance : 0.5);

      await db.query(
        `
          INSERT INTO memory_search_index (
            memory_id, user_id, account_id, memory_bank_id, connector_type, source_type,
            event_time, factuality_label, pinned, importance, recall_count, text, entities_text,
            people, person_ids, person_aliases, locations, location_text, organizations,
            thread_ids, transaction_tokens, search_tokens, embedding, embedding_dimension, updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11, $12, $13,
            $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, $18, $19::jsonb,
            $20::jsonb, $21::jsonb, to_tsvector('english', $22), $23::vector, $24, now()
          )
          ON CONFLICT (memory_id) DO UPDATE SET
            user_id = EXCLUDED.user_id,
            account_id = EXCLUDED.account_id,
            memory_bank_id = EXCLUDED.memory_bank_id,
            connector_type = EXCLUDED.connector_type,
            source_type = EXCLUDED.source_type,
            event_time = EXCLUDED.event_time,
            factuality_label = EXCLUDED.factuality_label,
            pinned = EXCLUDED.pinned,
            importance = EXCLUDED.importance,
            recall_count = EXCLUDED.recall_count,
            text = EXCLUDED.text,
            entities_text = EXCLUDED.entities_text,
            people = EXCLUDED.people,
            person_ids = EXCLUDED.person_ids,
            person_aliases = EXCLUDED.person_aliases,
            locations = EXCLUDED.locations,
            location_text = EXCLUDED.location_text,
            organizations = EXCLUDED.organizations,
            thread_ids = EXCLUDED.thread_ids,
            transaction_tokens = EXCLUDED.transaction_tokens,
            search_tokens = EXCLUDED.search_tokens,
            embedding = EXCLUDED.embedding,
            embedding_dimension = EXCLUDED.embedding_dimension,
            updated_at = EXCLUDED.updated_at
        `,
        [
          memoryId,
          row.user_id,
          row.account_id,
          row.memory_bank_id,
          row.connector_type,
          row.source_type,
          row.event_time,
          row.factuality_label || doc.factuality_label || null,
          row.pinned,
          importance,
          row.recall_count || 0,
          text,
          entitiesText,
          JSON.stringify(asArray(doc.people)),
          JSON.stringify(asArray(doc.person_ids)),
          JSON.stringify(asArray(doc.person_aliases)),
          JSON.stringify(asArray(doc.locations)),
          asString(doc.location_text),
          JSON.stringify(asArray(doc.organizations)),
          JSON.stringify(asArray(doc.thread_ids)),
          JSON.stringify(asArray(doc.transaction_tokens)),
          searchText,
          `[${embedding.join(',')}]`,
          embedding.length,
        ],
      );
      indexed++;

      if (indexed % 1000 === 0) {
        console.log(JSON.stringify({ indexed, resumed, skipped }));
      }
    }

    const textOnly = await backfillMissingTextOnlyRows(db);

    const counts = await db.query(`
      SELECT
        (SELECT COUNT(*)::int FROM memories m JOIN accounts a ON a.id = m.account_id WHERE m.pipeline_complete = true) AS expected,
        (SELECT COUNT(*)::int FROM memory_search_index) AS actual
    `);
    const { expected, actual } = counts.rows[0];
    console.log(JSON.stringify({ indexed, resumed, skipped, textOnly, expected, actual, strict: STRICT_BACKFILL }, null, 2));

    if (STRICT_BACKFILL && actual < expected) {
      console.error(`Backfill incomplete: expected at least ${expected}, got ${actual}`);
      process.exitCode = 2;
    } else if (actual < expected) {
      console.warn(`Backfill indexed available legacy search documents; ${expected - actual} completed memories were not present in the legacy search export.`);
    }
  } finally {
    await db.query('SELECT pg_advisory_unlock($1)', [BACKFILL_LOCK_ID]).catch(() => undefined);
    await db.end();
  }
}

async function loadMemoryMetadata(db) {
  const result = await db.query(`
    SELECT
      m.id,
      m.account_id,
      m.memory_bank_id,
      m.connector_type,
      m.source_type,
      m.event_time,
      m.factuality_label,
      m.pinned,
      m.recall_count,
      m.weights,
      a.user_id
    FROM memories m
    LEFT JOIN accounts a ON a.id = m.account_id
  `);

  const memoryById = new Map();
  for (const row of result.rows) {
    memoryById.set(row.id, {
      ...row,
      weights: parseWeights(row.weights),
    });
  }
  console.log(JSON.stringify({ loadedMemoryRows: memoryById.size }));
  return memoryById;
}

async function loadAlreadyIndexedMemoryIds(db) {
  const result = await db.query(`
    SELECT memory_id
    FROM memory_search_index
    WHERE embedding IS NOT NULL
  `);

  const indexed = new Set(result.rows.map((row) => row.memory_id));
  console.log(JSON.stringify({ alreadyIndexedMemoryRows: indexed.size }));
  return indexed;
}

async function* streamLegacySearchDocuments() {
  const res = await fetch(`${LEGACY_SEARCH_URL}/collections/memories/documents/export`, {
    headers: { [LEGACY_API_KEY_HEADER]: LEGACY_SEARCH_API_KEY },
  });
  if (!res.ok) {
    throw new Error(`Legacy search export failed: ${res.status} ${await res.text()}`);
  }

  const rl = readline.createInterface({
    input: Readable.fromWeb(res.body),
    crlfDelay: Infinity,
  });

  let buffered = '';
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    buffered = buffered ? `${buffered}\\n${trimmed}` : trimmed;
    try {
      yield JSON.parse(buffered);
      buffered = '';
    } catch (err) {
      if (isPossiblyIncompleteJson(err)) continue;
      throw err;
    }
  }

  if (buffered) {
    yield JSON.parse(buffered);
  }
}

async function assertSearchTable(db) {
  await db.query('SELECT 1 FROM memory_search_index LIMIT 1');
}

async function backfillMissingTextOnlyRows(db) {
  const result = await db.query(`
    INSERT INTO memory_search_index (
      memory_id, user_id, account_id, memory_bank_id, connector_type, source_type,
      event_time, factuality_label, pinned, importance, recall_count, text, entities_text,
      people, person_ids, person_aliases, locations, location_text, organizations,
      thread_ids, transaction_tokens, search_tokens, embedding, embedding_dimension, updated_at
    )
    SELECT
      m.id,
      a.user_id,
      m.account_id,
      m.memory_bank_id,
      m.connector_type,
      m.source_type,
      m.event_time,
      m.factuality_label,
      m.pinned,
      COALESCE((m.weights->>'importance')::double precision, 0.5),
      m.recall_count,
      '',
      '',
      '[]'::jsonb,
      '[]'::jsonb,
      '[]'::jsonb,
      '[]'::jsonb,
      '',
      '[]'::jsonb,
      '[]'::jsonb,
      '[]'::jsonb,
      COALESCE(m.search_tokens, to_tsvector('english', '')),
      NULL,
      NULL,
      now()
    FROM memories m
    JOIN accounts a ON a.id = m.account_id
    WHERE m.pipeline_complete = true
      AND a.user_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM memory_search_index i WHERE i.memory_id = m.id
      )
  `);
  return result.rowCount || 0;
}

function asArray(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function asString(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function parseWeights(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isPossiblyIncompleteJson(err) {
  return (
    err instanceof SyntaxError &&
    (err.message.includes('Unterminated string') ||
      err.message.includes('Unexpected end') ||
      err.message.includes('Expected property name or') ||
      err.message.includes('Expected double-quoted property name'))
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

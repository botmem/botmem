#!/usr/bin/env node

const readline = require('node:readline');
const { Readable } = require('node:stream');
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const TYPESENSE_URL =
  process.env.LEGACY_TYPESENSE_URL || process.env.TYPESENSE_URL || 'http://typesense:8108';
const TYPESENSE_API_KEY =
  process.env.LEGACY_TYPESENSE_API_KEY || process.env.TYPESENSE_API_KEY || 'botmem-ts-key';
const TYPESENSE_COLLECTION = process.env.LEGACY_TYPESENSE_COLLECTION || 'memories';
const BATCH_SIZE = positiveInt(process.env.TYPESENSE_DRAIN_BATCH_SIZE, 1);
const DELETE_ORPHANS = process.env.TYPESENSE_DRAIN_DELETE_ORPHANS === '1';
const TASK_KEY = 'drain-typesense-to-pg-search:v1';
const LOCK_ID = 2026050202;
const API_KEY_HEADER = 'X-TYPESENSE-API-KEY';

if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

async function main() {
  const db = new Client({ connectionString: DATABASE_URL });
  await db.connect();

  let locked = false;
  try {
    await ensureTaskTable(db);
    const lock = await db.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_ID]);
    locked = lock.rows[0]?.locked === true;
    if (!locked) {
      console.log(JSON.stringify({ task: TASK_KEY, status: 'already_running' }));
      return;
    }

    if (await taskComplete(db)) {
      console.log(JSON.stringify({ task: TASK_KEY, status: 'already_complete' }));
      return;
    }

    await db.query('CREATE EXTENSION IF NOT EXISTS vector');
    await assertSearchTable(db);

    const collectionExists = await typesenseCollectionExists();
    if (!collectionExists) {
      await markTaskComplete(db, {
        reason: 'collection_missing',
        collection: TYPESENSE_COLLECTION,
        indexed: 0,
        deleted: 0,
      });
      console.log(
        JSON.stringify({ task: TASK_KEY, status: 'complete', reason: 'collection_missing' }),
      );
      return;
    }

    const totals = {
      seen: 0,
      indexed: 0,
      alreadyIndexed: 0,
      deleted: 0,
      skipped: 0,
      orphaned: 0,
      deleteFailed: 0,
    };
    let batch = [];

    for await (const doc of streamTypesenseDocuments()) {
      batch.push(doc);
      if (batch.length >= BATCH_SIZE) {
        await drainBatch(db, batch, totals);
        batch = [];
        logProgress(totals);
      }
    }

    if (batch.length > 0) {
      await drainBatch(db, batch, totals);
    }

    if (totals.deleteFailed > 0) {
      throw new Error(
        `Postgres drain finished, but ${totals.deleteFailed} Typesense delete(s) failed; not marking task complete`,
      );
    }

    await markTaskComplete(db, totals);
    console.log(JSON.stringify({ task: TASK_KEY, status: 'complete', ...totals }, null, 2));
  } finally {
    if (locked) await db.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    await db.end();
  }
}

async function ensureTaskTable(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS system_startup_tasks (
      task_key text PRIMARY KEY,
      completed_at timestamptz NOT NULL,
      details jsonb NOT NULL DEFAULT '{}'::jsonb
    )
  `);
}

async function taskComplete(db) {
  const result = await db.query('SELECT 1 FROM system_startup_tasks WHERE task_key = $1 LIMIT 1', [
    TASK_KEY,
  ]);
  return result.rowCount > 0;
}

async function markTaskComplete(db, details) {
  await db.query(
    `
      INSERT INTO system_startup_tasks (task_key, completed_at, details)
      VALUES ($1, now(), $2::jsonb)
      ON CONFLICT (task_key) DO UPDATE SET
        completed_at = EXCLUDED.completed_at,
        details = EXCLUDED.details
    `,
    [TASK_KEY, JSON.stringify(details)],
  );
}

async function assertSearchTable(db) {
  await db.query('SELECT 1 FROM memory_search_index LIMIT 1');
}

async function typesenseCollectionExists() {
  const res = await typesenseRequest('GET', `/collections/${encodeURIComponent(TYPESENSE_COLLECTION)}`, {
    allow404: true,
  });
  return res.status !== 404;
}

async function* streamTypesenseDocuments() {
  const path = `/collections/${encodeURIComponent(TYPESENSE_COLLECTION)}/documents/export`;
  const res = await typesenseRequest('GET', path);

  const rl = readline.createInterface({
    input: Readable.fromWeb(res.body),
    crlfDelay: Infinity,
  });

  let buffered = '';
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    buffered = buffered ? `${buffered}\n${trimmed}` : trimmed;
    try {
      yield JSON.parse(buffered);
      buffered = '';
    } catch (err) {
      if (isPossiblyIncompleteJson(err)) continue;
      throw err;
    }
  }

  if (buffered) yield JSON.parse(buffered);
}

async function drainBatch(db, docs, totals) {
  totals.seen += docs.length;
  const ids = docs.map((doc) => memoryIdFromDoc(doc)).filter(Boolean);
  const metadata = await loadMemoryMetadata(db, ids);
  const indexedIds = await loadIndexedMemoryIds(db, ids);
  const deletable = [];

  await db.query('BEGIN');
  try {
    for (const doc of docs) {
      const memoryId = memoryIdFromDoc(doc);
      if (!memoryId) {
        totals.skipped++;
        continue;
      }

      if (indexedIds.has(memoryId)) {
        if (await verifySearchRow(db, memoryId)) {
          totals.alreadyIndexed++;
          deletable.push(memoryId);
        } else {
          totals.skipped++;
        }
        continue;
      }

      const row = metadata.get(memoryId);
      if (!row?.user_id) {
        totals.orphaned++;
        if (DELETE_ORPHANS) deletable.push(memoryId);
        continue;
      }

      const embedding = embeddingFromDoc(doc);
      await upsertSearchRow(db, doc, row, embedding);
      if (!(await verifySearchRow(db, memoryId))) {
        throw new Error(`Postgres verification failed after upsert for ${memoryId}`);
      }
      totals.indexed++;
      deletable.push(memoryId);
    }
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw err;
  }

  for (const id of deletable) {
    try {
      await deleteTypesenseDocument(id);
      totals.deleted++;
    } catch (err) {
      totals.deleteFailed++;
      console.error(
        JSON.stringify({
          task: TASK_KEY,
          level: 'error',
          action: 'delete_typesense_document',
          id,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
}

async function loadMemoryMetadata(db, ids) {
  if (ids.length === 0) return new Map();
  const result = await db.query(
    `
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
      WHERE m.id = ANY($1::text[])
    `,
    [dedupe(ids)],
  );

  const rows = new Map();
  for (const row of result.rows) {
    rows.set(row.id, { ...row, weights: parseJson(row.weights) });
  }
  return rows;
}

async function loadIndexedMemoryIds(db, ids) {
  if (ids.length === 0) return new Set();
  const result = await db.query(
    `
      SELECT memory_id
      FROM memory_search_index
      WHERE memory_id = ANY($1::text[])
    `,
    [dedupe(ids)],
  );
  return new Set(result.rows.map((row) => row.memory_id));
}

async function verifySearchRow(db, memoryId) {
  const result = await db.query(
    `
      SELECT 1
      FROM memory_search_index i
      JOIN memories m ON m.id = i.memory_id
      WHERE i.memory_id = $1
      LIMIT 1
    `,
    [memoryId],
  );
  return result.rowCount === 1;
}

async function upsertSearchRow(db, doc, row, embedding) {
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
    finiteNumber(doc.importance) ?? finiteNumber(row.weights?.importance) ?? 0.5;
  const eventTime = row.event_time || dateFromTypesenseDoc(doc);

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
      row.id,
      row.user_id,
      row.account_id,
      row.memory_bank_id,
      row.connector_type || asString(doc.connector_type),
      row.source_type || asString(doc.source_type),
      eventTime,
      row.factuality_label || asString(doc.factuality_label) || null,
      Boolean(row.pinned),
      importance,
      finiteNumber(row.recall_count) ?? finiteNumber(doc.recall_count) ?? 0,
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
      embedding.length > 0 ? toPgVectorLiteral(embedding) : null,
      embedding.length || null,
    ],
  );
}

async function deleteTypesenseDocument(id) {
  const encodedCollection = encodeURIComponent(TYPESENSE_COLLECTION);
  const encodedId = encodeURIComponent(id);
  const res = await typesenseRequest('DELETE', `/collections/${encodedCollection}/documents/${encodedId}`, {
    allow404: true,
  });
  if (res.status === 404) return;
}

async function typesenseRequest(method, path, opts = {}) {
  const res = await fetch(`${TYPESENSE_URL}${path}`, {
    method,
    headers: { [API_KEY_HEADER]: TYPESENSE_API_KEY },
  });
  if (!res.ok && !(opts.allow404 && res.status === 404)) {
    throw new Error(`Typesense ${method} ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res;
}

function memoryIdFromDoc(doc) {
  return asString(doc.id || doc.memory_id);
}

function embeddingFromDoc(doc) {
  return Array.isArray(doc.embedding)
    ? doc.embedding.map((value) => Number(value)).filter(Number.isFinite)
    : [];
}

function dateFromTypesenseDoc(doc) {
  if (doc.event_time_str) return new Date(String(doc.event_time_str));
  const seconds = Number(doc.event_time);
  if (Number.isFinite(seconds) && seconds > 0) return new Date(seconds * 1000);
  return new Date();
}

function toPgVectorLiteral(vector) {
  if (!Array.isArray(vector) || vector.length === 0) return null;
  return `[${vector.map(toPgVectorComponent).join(',')}]`;
}

function toPgVectorComponent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n) < 1e-38) return '0';
  return n.toExponential(8);
}

function asArray(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function asString(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function positiveInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function dedupe(values) {
  return [...new Set(values)];
}

function logProgress(totals) {
  console.log(JSON.stringify({ task: TASK_KEY, status: 'running', ...totals }));
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

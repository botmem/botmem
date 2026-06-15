/**
 * Bridge-owned FTS5 index. This is OUR file — never a source app's DB.
 *
 * Source DBs are only ever opened read-only by the adapters; this store is the
 * only thing the bridge writes to. Ported from the proven spike (index-store.mjs),
 * adapted to the apple-bridge TypeScript style (better-sqlite3 via createRequire).
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import type { IndexRecord, SearchFilters, SearchItem, SourceName, SourceState } from './types.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Database = require('better-sqlite3') as any;

/** Map an internal source name to the wire connectorType the server expects. */
export function sourceToConnectorType(source: string): SearchItem['connectorType'] {
  if (source === 'imessage') return 'apple';
  if (source === 'whatsapp') return 'whatsapp';
  return 'contacts';
}

/** Map a wire connectorType back to the internal source name for filtering. */
export function connectorTypeToSource(connectorType: string): SourceName | undefined {
  switch (connectorType) {
    case 'apple':
    case 'imessage':
      return 'imessage';
    case 'whatsapp':
      return 'whatsapp';
    case 'contacts':
      return 'contacts';
    default:
      return undefined;
  }
}

interface FtsRow {
  text: string;
  sender_name: string;
  thread_title: string;
  source: string;
  source_id: string;
  thread_id: string;
  sender_id: string;
  is_from_me: number;
  ts: number;
  media_json: string | null;
  rank: number;
}

export class IndexStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private insertStmt: any;

  /** @param path bridge-owned index db path (NEVER inside a source DB dir). */
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    // WAL is safe here: this is OUR index, not a source DB.
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
        text, sender_name, thread_title,
        source UNINDEXED, source_id UNINDEXED, thread_id UNINDEXED,
        sender_id UNINDEXED, is_from_me UNINDEXED, ts UNINDEXED, media_json UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TABLE IF NOT EXISTS source_state (
        source TEXT PRIMARY KEY,
        last_cursor TEXT,
        count INTEGER DEFAULT 0,
        last_indexed_at INTEGER
      );
    `);
    this.insertStmt = this.db.prepare(`
      INSERT INTO records_fts
        (text, sender_name, thread_title, source, source_id, thread_id, sender_id, is_from_me, ts, media_json)
      VALUES
        (@text, @sender_name, @thread_title, @source, @source_id, @thread_id, @sender_id, @is_from_me, @ts, @media_json)
    `);
  }

  /** Bulk-insert normalized records inside one transaction. */
  addRecords(source: SourceName, records: IndexRecord[]): void {
    const tx = this.db.transaction((rows: IndexRecord[]) => {
      for (const r of rows) {
        this.insertStmt.run({
          text: r.text ?? '',
          sender_name: r.senderName ?? '',
          thread_title: r.threadTitle ?? '',
          source,
          source_id: String(r.sourceId ?? ''),
          thread_id: r.threadId ?? '',
          sender_id: r.senderId ?? '',
          is_from_me: r.isFromMe ? 1 : 0,
          ts: r.ts ?? 0,
          media_json: r.media && r.media.length ? JSON.stringify(r.media) : null,
        });
      }
    });
    tx(records);
  }

  setSourceState(source: SourceName, count: number, cursor?: string | null): void {
    this.db
      .prepare(
        `INSERT INTO source_state (source, last_cursor, count, last_indexed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source) DO UPDATE SET
           last_cursor = excluded.last_cursor,
           count = excluded.count,
           last_indexed_at = excluded.last_indexed_at`,
      )
      .run(source, cursor ?? null, count, Date.now());
  }

  /** Clear all indexed data for a full rebuild. */
  reset(): void {
    this.db.exec(`DELETE FROM records_fts; DELETE FROM source_state;`);
  }

  /** Source-state rows for `bridge.status`. */
  status(): SourceState[] {
    const rows = this.db
      .prepare(`SELECT source, count, last_indexed_at FROM source_state`)
      .all() as Array<{ source: SourceName; count: number; last_indexed_at: number | null }>;
    return rows.map((r) => ({
      source: r.source,
      count: r.count,
      lastIndexedAt: r.last_indexed_at ?? null,
    }));
  }

  /**
   * FTS5 search. Returns items in the exact shape the Botmem server expects.
   * `filters.source` selects an internal source; ordering is by bm25 (best first).
   */
  search(query: string, filters: SearchFilters = {}, limit = 25): SearchItem[] {
    // Build an OR-of-phrases MATCH (each term quoted so FTS treats punctuation
    // literally). OR — not AND — so multi-word queries don't require every term;
    // bm25 then ranks docs that match more (and rarer) terms higher.
    const terms = query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replace(/"/g, '""')}"`);
    if (!terms.length) return [];
    // Restrict matching to {text sender_name} so a group's thread_title never
    // floods results with every message in that chat (the old behaviour).
    const match = `{text sender_name} : (${terms.join(' OR ')})`;

    // Resolve the effective internal source from either source or connectorType.
    const source =
      filters.source ??
      (filters.connectorType ? connectorTypeToSource(filters.connectorType) : undefined);

    const conditions: string[] = ['records_fts MATCH ?'];
    const args: unknown[] = [match];
    if (source) {
      conditions.push('source = ?');
      args.push(source);
    }
    // sourceType maps to a source class: 'contact' ↔ contacts, 'message' ↔ the rest.
    if (filters.sourceType === 'contact') {
      conditions.push(`source = 'contacts'`);
    } else if (filters.sourceType === 'message') {
      conditions.push(`source <> 'contacts'`);
    }
    args.push(limit);

    const rows = this.db
      .prepare(
        `SELECT text, sender_name, thread_title, source, source_id, thread_id, sender_id,
                is_from_me, ts, media_json, bm25(records_fts) AS rank
         FROM records_fts
         WHERE ${conditions.join(' AND ')}
         ORDER BY rank
         LIMIT ?`,
      )
      .all(...args) as FtsRow[];

    return rows.map((r) => ({
      id: `${r.source}:${r.source_id}`,
      connectorType: sourceToConnectorType(r.source),
      sourceType: r.source === 'contacts' ? 'contact' : 'message',
      text: r.text,
      eventTime: r.ts ? new Date(r.ts * 1000).toISOString() : null,
      people: r.sender_name ? [{ name: r.sender_name, durableId: r.sender_id ?? '' }] : [],
      threadTitle: r.thread_title ?? '',
      isFromMe: !!r.is_from_me,
      media: r.media_json ? (JSON.parse(r.media_json) as unknown[]) : [],
      score: -r.rank, // higher = better
    }));
  }

  close(): void {
    this.db.close();
  }
}

/**
 * iMessage source adapter — READ-ONLY over chat.db (never written).
 *
 * Modern iMessage often stores the body as an NSAttributedString typedstream
 * blob in `attributedBody` (with `text` NULL); we reuse the package's robust
 * decoder (extractAttributedBodyText) rather than the spike's heuristic one.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { extractAttributedBodyText } from '../../db.js';
import type { IndexRecord, SourceAdapter } from '../types.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Database = require('better-sqlite3') as any;

/** Seconds between 2001-01-01 (Core Data epoch) and 1970-01-01 (Unix). */
const COCOA_EPOCH = 978_307_200;

/** chat.db `date` may be in nanoseconds (modern) or seconds (legacy). */
function toUnixSeconds(date: number | null): number {
  if (!date) return 0;
  return date > 1e11 ? Math.round(date / 1e9) + COCOA_EPOCH : date + COCOA_EPOCH;
}

interface MessageRow {
  id: number;
  text: string | null;
  body: Buffer | null;
  date: number | null;
  isFromMe: number;
  handle: string | null;
  chatId: string | null;
  chatTitle: string | null;
}

export const imessage: SourceAdapter = {
  source: 'imessage',

  defaultDbPath(): string {
    return join(homedir(), 'Library/Messages/chat.db');
  },

  detect(dbPath = imessage.defaultDbPath()): boolean {
    if (!existsSync(dbPath)) return false;
    try {
      new Database(dbPath, { readonly: true }).close();
      return true;
    } catch {
      return false;
    }
  },

  *read(dbPath = imessage.defaultDbPath()): Generator<IndexRecord> {
    const db = new Database(dbPath, { readonly: true });
    // Defense-in-depth: never write to a source DB.
    db.pragma('query_only = ON');
    try {
      const stmt = db.prepare(`
        SELECT m.ROWID AS id, m.text AS text, m.attributedBody AS body, m.date AS date,
               m.is_from_me AS isFromMe, h.id AS handle,
               c.chat_identifier AS chatId, c.display_name AS chatTitle
        FROM message m
        LEFT JOIN handle h ON h.ROWID = m.handle_id
        LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        LEFT JOIN chat c ON c.ROWID = cmj.chat_id
        WHERE (m.text IS NOT NULL AND m.text <> '') OR m.attributedBody IS NOT NULL
      `);
      for (const row of stmt.iterate() as Iterable<MessageRow>) {
        const text = row.text && row.text.length ? row.text : extractAttributedBodyText(row.body);
        if (!text) continue;
        yield {
          sourceId: row.id,
          threadId: row.chatId ?? '',
          threadTitle: row.chatTitle ?? '',
          senderName: row.isFromMe ? 'Me' : (row.handle ?? ''),
          senderId: row.handle ?? '',
          isFromMe: !!row.isFromMe,
          ts: toUnixSeconds(row.date),
          text,
          media: [],
        };
      }
    } finally {
      db.close();
    }
  },
};

/**
 * WhatsApp source adapter — READ-ONLY over ChatStorage.sqlite (never written).
 *
 * The WhatsApp desktop app stores its data in a Core Data group container:
 *   ~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite
 * WhatsApp is optional; `detect()` returns false when it isn't installed.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { IndexRecord, SourceAdapter } from '../types.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Database = require('better-sqlite3') as any;

/** Core Data epoch: 2001-01-01 in unix seconds. */
const CORE_DATA_EPOCH = 978_307_200;

interface WaRow {
  id: number;
  text: string | null;
  ts: number | null;
  isFromMe: number;
  pushName: string | null;
  fromJid: string | null;
  chatJid: string | null;
  chatTitle: string | null;
  memberJid: string | null;
  memberName: string | null;
  mediaPath: string | null;
  thumbPath: string | null;
}

export const whatsapp: SourceAdapter = {
  source: 'whatsapp',

  defaultDbPath(): string {
    return join(
      homedir(),
      'Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite',
    );
  },

  detect(dbPath = whatsapp.defaultDbPath()): boolean {
    if (!existsSync(dbPath)) return false;
    try {
      new Database(dbPath, { readonly: true }).close();
      return true;
    } catch {
      return false;
    }
  },

  *read(dbPath = whatsapp.defaultDbPath()): Generator<IndexRecord> {
    const db = new Database(dbPath, { readonly: true });
    db.pragma('query_only = ON');
    try {
      // Session title column name varies across WhatsApp versions; pick what exists.
      const cols = new Set(
        (db.prepare(`PRAGMA table_info(ZWACHATSESSION)`).all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
      const titleCol =
        ['ZPARTNERNAME', 'ZSESSIONNAME', 'ZCONTACTJID'].find((c) => cols.has(c)) ?? 'ZCONTACTJID';

      const stmt = db.prepare(`
        SELECT m.Z_PK AS id, m.ZTEXT AS text, m.ZMESSAGEDATE AS ts,
               m.ZISFROMME AS isFromMe, m.ZPUSHNAME AS pushName, m.ZFROMJID AS fromJid,
               cs.ZCONTACTJID AS chatJid, cs.${titleCol} AS chatTitle,
               gm.ZMEMBERJID AS memberJid, gm.ZCONTACTNAME AS memberName,
               md.ZMEDIALOCALPATH AS mediaPath, md.ZTHUMBNAILLOCALPATH AS thumbPath
        FROM ZWAMESSAGE m
        LEFT JOIN ZWACHATSESSION cs ON cs.Z_PK = m.ZCHATSESSION
        LEFT JOIN ZWAGROUPMEMBER gm ON gm.Z_PK = m.ZGROUPMEMBER
        LEFT JOIN ZWAMEDIAITEM  md ON md.Z_PK = m.ZMEDIAITEM
        WHERE m.ZTEXT IS NOT NULL AND m.ZTEXT <> ''
      `);
      for (const r of stmt.iterate() as Iterable<WaRow>) {
        yield {
          sourceId: r.id,
          threadId: r.chatJid ?? '',
          threadTitle: r.chatTitle ?? '',
          senderName: r.memberName ?? r.pushName ?? '',
          senderId: r.memberJid ?? r.fromJid ?? '',
          isFromMe: !!r.isFromMe,
          ts: r.ts ? Math.round(r.ts + CORE_DATA_EPOCH) : 0,
          text: r.text ?? '',
          media: r.mediaPath || r.thumbPath ? [{ path: r.mediaPath, thumb: r.thumbPath }] : [],
        };
      }
    } finally {
      db.close();
    }
  },
};

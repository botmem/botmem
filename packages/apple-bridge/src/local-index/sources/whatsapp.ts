/**
 * WhatsApp source adapter — READ-ONLY over ChatStorage.sqlite (never written).
 *
 * The WhatsApp desktop app stores its data in a Core Data group container:
 *   ~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite
 * Media (incl. PDFs/DOCX) live as PLAINTEXT files under <container>/Message/Media/…
 * but ONLY once downloaded; ZMEDIALOCALPATH is null for not-yet-downloaded docs.
 *
 * This adapter indexes: text messages, document captions, and the extracted TEXT
 * of downloaded PDF/DOCX/TXT/CSV attachments. Sender names are resolved from
 * ContactsV2.sqlite (ZPUSHNAME is an opaque blob in current WhatsApp builds).
 * WhatsApp is optional; `detect()` returns false when it isn't installed.
 */

import { existsSync, statSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, extname, resolve, relative, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import type { IndexRecord, SourceAdapter } from '../types.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Database = require('better-sqlite3') as any;

/** Core Data epoch: 2001-01-01 in unix seconds. */
const CORE_DATA_EPOCH = 978_307_200;
/** Cap extracted document text per file so one PDF can't bloat the index. */
const MAX_DOC_CHARS = 50_000;
/** Skip parsing attachments larger than this (cost guard). */
const MAX_DOC_BYTES = 25 * 1024 * 1024;

interface WaRow {
  id: number;
  text: string | null;
  ts: number | null;
  isFromMe: number;
  fromJid: string | null;
  chatJid: string | null;
  chatTitle: string | null;
  memberJid: string | null;
  mediaPath: string | null;
  mediaTitle: string | null;
}

const onlyDigits = (s: string | null | undefined): string => (s ?? '').replace(/[^0-9]/g, '');
/** Extract the digits/lid from a JID like '971…@s.whatsapp.net' or '…@lid'. */
const jidDigits = (jid: string | null | undefined): string => onlyDigits((jid ?? '').split('@')[0]);

/** Build a phone/waid/lid → contact name map from the sibling ContactsV2.sqlite. */
function loadContactNames(containerDir: string): Map<string, string> {
  const map = new Map<string, string>();
  const p = join(containerDir, 'ContactsV2.sqlite');
  if (!existsSync(p)) return map;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  try {
    db = new Database(p, { readonly: true });
    db.pragma('query_only = ON');
  } catch {
    return map;
  }
  try {
    const rows = db
      .prepare(
        `SELECT ZFULLNAME f, ZGIVENNAME g, ZLASTNAME l, ZPHONENUMBER p, ZWHATSAPPID w, ZLID lid
         FROM ZWAADDRESSBOOKCONTACT`,
      )
      .all() as Array<{
      f: string | null;
      g: string | null;
      l: string | null;
      p: string | null;
      w: string | null;
      lid: string | null;
    }>;
    for (const r of rows) {
      const name = (r.f && r.f.trim()) || [r.g, r.l].filter(Boolean).join(' ').trim();
      if (!name) continue;
      for (const key of [onlyDigits(r.p), jidDigits(r.w), onlyDigits(r.lid)]) {
        if (key) map.set(key, name);
      }
    }
  } catch {
    /* ignore — name resolution is best-effort */
  } finally {
    db.close();
  }
  return map;
}

/** Extract text from a downloaded attachment. Returns '' on any failure. */
async function extractDocText(absPath: string): Promise<string> {
  try {
    if (!existsSync(absPath)) return '';
    if (statSync(absPath).size > MAX_DOC_BYTES) return '';
    const ext = extname(absPath).toLowerCase();
    if (ext === '.pdf') {
      // pdf-parse v2: new PDFParse({ data }).getText(). Async read avoids blocking
      // the event loop (and the tunnel heartbeat) while indexing many documents.
      const { PDFParse } = require('pdf-parse');
      const parser = new PDFParse({ data: new Uint8Array(await readFile(absPath)) });
      const res = await parser.getText();
      return (res?.text ?? '').slice(0, MAX_DOC_CHARS);
    }
    if (ext === '.docx') {
      const mammoth = require('mammoth');
      const res = await mammoth.extractRawText({ buffer: await readFile(absPath) });
      return (res?.value ?? '').slice(0, MAX_DOC_CHARS);
    }
    if (ext === '.txt' || ext === '.csv' || ext === '.md') {
      return (await readFile(absPath, 'utf8')).slice(0, MAX_DOC_CHARS);
    }
  } catch {
    /* unparseable / corrupt — skip silently (no user content in logs) */
  }
  return '';
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

  async *read(dbPath = whatsapp.defaultDbPath()): AsyncGenerator<IndexRecord> {
    const db = new Database(dbPath, { readonly: true });
    db.pragma('query_only = ON');
    const containerDir = dirname(dbPath);
    // Canonical container path for symlink-proof containment of attachment reads.
    const realContainer = await realpath(containerDir).catch(() => containerDir);
    const names = loadContactNames(containerDir);
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
               m.ZISFROMME AS isFromMe, m.ZFROMJID AS fromJid,
               cs.ZCONTACTJID AS chatJid, cs.${titleCol} AS chatTitle,
               gm.ZMEMBERJID AS memberJid,
               md.ZMEDIALOCALPATH AS mediaPath, md.ZTITLE AS mediaTitle
        FROM ZWAMESSAGE m
        LEFT JOIN ZWACHATSESSION cs ON cs.Z_PK = m.ZCHATSESSION
        LEFT JOIN ZWAGROUPMEMBER gm ON gm.Z_PK = m.ZGROUPMEMBER
        LEFT JOIN ZWAMEDIAITEM  md ON md.Z_PK = m.ZMEDIAITEM
        WHERE (m.ZTEXT IS NOT NULL AND m.ZTEXT <> '')
           OR (md.ZTITLE IS NOT NULL AND md.ZTITLE <> '')
           OR (md.ZMEDIALOCALPATH IS NOT NULL)
      `);

      for (const r of stmt.iterate() as Iterable<WaRow>) {
        // Sender: prefer the group-member JID; for 1:1 use ZFROMJID (not the group jid).
        const senderJid =
          r.memberJid || (r.fromJid && !r.fromJid.endsWith('@g.us') ? r.fromJid : '');
        const digits = jidDigits(senderJid);
        const senderName = (digits && names.get(digits)) || (digits ? `+${digits}` : '');

        const caption = r.mediaTitle && r.mediaTitle.trim() ? r.mediaTitle.trim() : '';
        let text = r.text && r.text.length ? r.text : '';
        const media: unknown[] = r.mediaPath ? [{ path: r.mediaPath }] : [];

        // Extract text from downloaded document attachments (PDF/DOCX/TXT/CSV).
        // Confine reads to the WhatsApp container: ZMEDIALOCALPATH is data from the
        // source DB. Resolve to the REAL path (realpath follows symlinks, which
        // readFile would too) and reject anything that escapes the container.
        if (r.mediaPath) {
          const abs = resolve(containerDir, r.mediaPath);
          const real = await realpath(abs).catch(() => null);
          const rel = real ? relative(realContainer, real) : '..';
          const contained = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
          if (real && contained) {
            const docText = await extractDocText(real);
            if (docText) {
              text = [text, caption, docText].filter(Boolean).join('\n');
            }
          }
        }
        if (!text && caption) text = caption;
        if (!text) continue; // pure image/audio with no caption — nothing to index

        yield {
          sourceId: r.id,
          threadId: r.chatJid ?? '',
          threadTitle: r.chatTitle ?? '',
          senderName,
          senderId: senderJid,
          isFromMe: !!r.isFromMe,
          ts: r.ts ? Math.round(r.ts + CORE_DATA_EPOCH) : 0,
          text,
          media,
        };
      }
    } finally {
      db.close();
    }
  },
};

/**
 * Contacts source adapter — READ-ONLY over ALL local AddressBook account DBs.
 *
 * Each iCloud/Exchange/local account stores its own AddressBook-v22.abcddb under
 * ~/Library/Application Support/AddressBook (top-level + Sources/<uuid>/). We
 * enumerate and read every readable one. Unreadable accounts are skipped.
 */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { IndexRecord, SourceAdapter } from '../types.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Database = require('better-sqlite3') as any;

const AB_BASE = join(homedir(), 'Library/Application Support/AddressBook');

/** Collect every account's AddressBook DB (top-level + Sources/<uuid>/…). */
function listContactDbs(base: string): string[] {
  const dbs: string[] = [];
  const top = join(base, 'AddressBook-v22.abcddb');
  if (existsSync(top)) dbs.push(top);
  const srcDir = join(base, 'Sources');
  if (existsSync(srcDir)) {
    for (const s of readdirSync(srcDir)) {
      const p = join(srcDir, s, 'AddressBook-v22.abcddb');
      if (existsSync(p)) dbs.push(p);
    }
  }
  return dbs;
}

function canRead(p: string): boolean {
  try {
    new Database(p, { readonly: true }).close();
    return true;
  } catch {
    return false;
  }
}

interface ContactRow {
  id: number;
  first: string | null;
  last: string | null;
  org: string | null;
}

export const contacts: SourceAdapter = {
  source: 'contacts',

  /** A directory; read() enumerates account DBs under it. */
  defaultDbPath(): string {
    return AB_BASE;
  },

  detect(base = contacts.defaultDbPath()): boolean {
    return listContactDbs(base).some(canRead);
  },

  *read(base = contacts.defaultDbPath()): Generator<IndexRecord> {
    // `base` may be a directory (enumerate) or a single .abcddb (use directly).
    const dbs = base.endsWith('.abcddb') ? [base] : listContactDbs(base);
    for (const dbPath of dbs) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let db: any;
      try {
        db = new Database(dbPath, { readonly: true });
        db.pragma('query_only = ON');
      } catch {
        continue; // unreadable account DB — skip
      }
      try {
        const stmt = db.prepare(`
          SELECT r.Z_PK AS id, r.ZFIRSTNAME AS first, r.ZLASTNAME AS last, r.ZORGANIZATION AS org
          FROM ZABCDRECORD r
          WHERE r.ZFIRSTNAME IS NOT NULL OR r.ZLASTNAME IS NOT NULL OR r.ZORGANIZATION IS NOT NULL
        `);
        const tag = dbPath.includes('/Sources/')
          ? dbPath.split('/Sources/')[1].slice(0, 8)
          : 'default';
        for (const r of stmt.iterate() as Iterable<ContactRow>) {
          const name = [r.first, r.last].filter(Boolean).join(' ').trim() || r.org || '';
          if (!name) continue;
          yield {
            sourceId: `${tag}:${r.id}`,
            threadId: '',
            threadTitle: 'Contacts',
            senderName: name,
            senderId: '',
            isFromMe: false,
            ts: 0,
            text: [name, r.org].filter(Boolean).join(' — '),
            media: [],
          };
        }
      } finally {
        db.close();
      }
    }
  },
};

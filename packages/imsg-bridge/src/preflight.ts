/**
 * Pre-flight checks for the iMessage bridge.
 * Verifies: macOS, chat.db readable, SQLite works.
 */

import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const DEFAULT_DB_PATH = join(homedir(), 'Library/Messages/chat.db');

export interface PreflightResult {
  ok: boolean;
  dbPath: string;
  chatCount?: number;
  errors: string[];
}

export function runPreflight(dbPath: string = DEFAULT_DB_PATH): PreflightResult {
  const errors: string[] = [];

  // 1. macOS check
  if (process.platform !== 'darwin') {
    errors.push(
      `This tool only runs on macOS (detected: ${process.platform}).` +
        '\niMessage data is only available on Apple devices.',
    );
    return { ok: false, dbPath, errors };
  }

  // 2. File exists and readable
  try {
    accessSync(dbPath, constants.R_OK);
  } catch {
    errors.push(
      `Cannot read ${dbPath}` +
        '\n\nTo fix this, grant Full Disk Access to your terminal:' +
        '\n  1. Open System Settings → Privacy & Security → Full Disk Access' +
        '\n  2. Click the + button and add your terminal app (Terminal, iTerm2, etc.)' +
        '\n  3. Restart your terminal and try again',
    );
    return { ok: false, dbPath, errors };
  }

  // 3. SQLite can open and query the DB
  try {
    // Dynamic import to avoid requiring better-sqlite3 at module level

    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare('SELECT count(*) as cnt FROM chat').get() as {
        cnt: number;
      };
      db.close();
      return { ok: true, dbPath, chatCount: row.cnt, errors: [] };
    } finally {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('SQLITE_CANTOPEN') || msg.includes('unable to open')) {
      errors.push(
        `Cannot open ${dbPath} as SQLite database.` +
          '\nThe file may be locked or corrupted. Try closing Messages.app and retrying.',
      );
    } else {
      errors.push(`SQLite error: ${msg}`);
    }
    return { ok: false, dbPath, errors };
  }
}

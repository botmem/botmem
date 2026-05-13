/**
 * Pre-flight checks for the Apple bridge.
 * Verifies: macOS, chat.db readable, SQLite works.
 */

import { accessSync, constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const DEFAULT_DB_PATH = join(homedir(), 'Library/Messages/chat.db');

export interface PreflightResult {
  ok: boolean;
  dbPath: string;
  chatCount?: number;
  errors: string[];
}

export interface PreflightOptions {
  requireMessages?: boolean;
  runnerName?: string;
}

function sidecarPaths(dbPath: string): string[] {
  return [`${dbPath}-wal`, `${dbPath}-shm`];
}

export function detectRunnerName(): string {
  if (process.env.BOTMEM_BRIDGE_RUNNER_NAME) {
    return process.env.BOTMEM_BRIDGE_RUNNER_NAME;
  }
  const argv0 = process.argv[1] || process.argv[0] || 'this app';
  const name = basename(argv0);
  if (name === 'cli.js' || name === 'apple-bridge') return 'your terminal app';
  return name || 'this app';
}

function fullDiskAccessMessage(dbPath: string, runnerName: string): string {
  return (
    `Cannot read ${dbPath}` +
    '\n\nmacOS blocked Messages access.' +
    `\nOpen System Settings > Privacy & Security > Full Disk Access and enable ${runnerName}.` +
    '\nRestart the bridge after enabling access.' +
    '\n\nShortcut:' +
    '\n  open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"'
  );
}

export function runPreflight(
  dbPath: string = DEFAULT_DB_PATH,
  options: PreflightOptions = {},
): PreflightResult {
  const errors: string[] = [];
  const requireMessages = options.requireMessages !== false;
  const runnerName = options.runnerName || detectRunnerName();

  // 1. macOS check
  if (process.platform !== 'darwin') {
    errors.push(
      `This tool only runs on macOS (detected: ${process.platform}).` +
        '\niMessage data is only available on Apple devices.',
    );
    return { ok: false, dbPath, errors };
  }

  if (!requireMessages) {
    return { ok: true, dbPath, errors };
  }

  // 2. File exists and readable
  try {
    accessSync(dbPath, constants.R_OK);
  } catch {
    errors.push(fullDiskAccessMessage(dbPath, runnerName));
    return { ok: false, dbPath, errors };
  }

  for (const path of sidecarPaths(dbPath)) {
    if (!existsSync(path)) continue;
    try {
      accessSync(path, constants.R_OK);
    } catch {
      errors.push(fullDiskAccessMessage(path, runnerName));
      return { ok: false, dbPath, errors };
    }
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

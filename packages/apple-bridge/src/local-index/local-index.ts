/**
 * LocalIndex — builds and serves the bridge-owned FTS5 search index.
 *
 * Responsibilities:
 *  - Own the index db at a bridge-controlled app-data path (NEVER inside any
 *    source DB directory).
 *  - Read all available local sources READ-ONLY (Contacts + iMessage + optional
 *    WhatsApp) and index them.
 *  - Serve `search.query` and `bridge.status` from the index.
 *
 * Privacy: logs emit ONLY counts/durations/source names — never message text,
 * names, phone numbers, or chat ids.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { IndexStore } from './index-store.js';
import { imessage } from './sources/imessage.js';
import { whatsapp } from './sources/whatsapp.js';
import { contacts } from './sources/contacts.js';
import type { SearchFilters, SearchItem, SourceAdapter, SourceState } from './types.js';

const BATCH_SIZE = 2000;

export interface LocalIndexOptions {
  /** Override the index db path (default: app-support/bridge/index.db). */
  indexPath?: string;
  /** Override source adapters (tests inject synthetic adapters). */
  adapters?: SourceAdapter[];
  /** Optional structured logger; receives privacy-safe messages only. */
  log?: (message: string) => void;
}

/** Default bridge-owned index path. Lives under Botmem's app-support dir. */
export function defaultIndexPath(): string {
  return join(homedir(), 'Library/Application Support/botmem/bridge/index.db');
}

export class LocalIndex {
  private store: IndexStore;
  private adapters: SourceAdapter[];
  private log: (message: string) => void;
  private building: Promise<void> | null = null;

  constructor(opts: LocalIndexOptions = {}) {
    this.store = new IndexStore(opts.indexPath ?? defaultIndexPath());
    this.adapters = opts.adapters ?? [contacts, imessage, whatsapp];
    this.log = opts.log ?? (() => {});
  }

  /**
   * Full rebuild from all present sources. Coalesces concurrent calls so a
   * refresh triggered while another is running reuses the in-flight build.
   */
  refresh(): Promise<void> {
    if (this.building) return this.building;
    this.building = this.runBuild().finally(() => {
      this.building = null;
    });
    return this.building;
  }

  private async runBuild(): Promise<void> {
    this.store.reset();
    for (const adapter of this.adapters) {
      const dbPath = adapter.defaultDbPath();
      if (!adapter.detect(dbPath)) {
        this.log(`source ${adapter.source}: not present — skipped`);
        continue;
      }
      const t0 = Date.now();
      let count = 0;
      try {
        let batch: Parameters<IndexStore['addRecords']>[1] = [];
        for (const rec of adapter.read(dbPath)) {
          batch.push(rec);
          if (batch.length >= BATCH_SIZE) {
            this.store.addRecords(adapter.source, batch);
            count += batch.length;
            batch = [];
          }
        }
        if (batch.length) {
          this.store.addRecords(adapter.source, batch);
          count += batch.length;
        }
        this.store.setSourceState(adapter.source, count, String(Date.now()));
        this.log(`source ${adapter.source}: indexed ${count} records in ${Date.now() - t0}ms`);
      } catch (err) {
        // Per-source isolation: one failing source never aborts the others.
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`source ${adapter.source}: FAILED after ${count} records — ${msg}`);
      }
    }
  }

  /** Run a search against the index. */
  search(query: string, filters: SearchFilters = {}, limit = 25): SearchItem[] {
    return this.store.search(query, filters, limit);
  }

  /** Per-source counts and last-indexed timestamps. */
  status(): SourceState[] {
    return this.store.status();
  }

  close(): void {
    this.store.close();
  }
}

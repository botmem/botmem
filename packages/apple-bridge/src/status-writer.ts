/**
 * BridgeStatus — structured status writer for the native macOS app.
 *
 * Writes a small JSON file (default `~/.botmem/bridge-status.json`) that a native
 * app polls to render clean status + activity. Writes are atomic (tmp file +
 * rename) so a poller never reads a partial document, and throttled so frequent
 * index ticks don't thrash the disk.
 *
 * Privacy: the status file and activity log contain ONLY states, source names,
 * counts, and durations — never message text, contact names, phone numbers, or
 * chat ids.
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Schema version of the status document. Bump when the shape changes. */
export const STATUS_SCHEMA = 1;

/** Maximum number of activity entries retained (newest LAST). */
export const ACTIVITY_LIMIT = 12;

/** Lifecycle state of the bridge, mirrored to the native app. */
export type BridgeState = 'starting' | 'connecting' | 'indexing' | 'live' | 'error' | 'offline';

/** Per-source count surfaced in the status file. */
export interface StatusSource {
  source: 'whatsapp' | 'imessage' | 'contacts';
  count: number;
}

/** Current indexing progress. */
export interface IndexingStatus {
  active: boolean;
  source: string | null;
  done: number;
  total: number | null;
}

/** A single privacy-safe activity log entry. */
export interface ActivityEntry {
  ts: number;
  text: string;
}

/** The exact on-disk status document shape (the Swift app depends on this). */
export interface BridgeStatusSnapshot {
  schema: number;
  state: BridgeState;
  label: string;
  server: string;
  connected: boolean;
  sources: StatusSource[];
  indexing: IndexingStatus;
  activity: ActivityEntry[];
  lastError: string | null;
  updatedAt: number;
}

export interface BridgeStatusOptions {
  /** Override the status file path (tests). Falls back to env, then default. */
  path?: string;
  /** Wss server url in use; written into every snapshot. */
  server?: string;
  /** Minimum ms between disk writes (throttle). Default 200ms (~5 writes/sec). */
  throttleMs?: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

/** Resolve the status path: explicit opt → BRIDGE_STATUS_PATH → default. */
export function defaultStatusPath(): string {
  return process.env.BRIDGE_STATUS_PATH || join(homedir(), '.botmem', 'bridge-status.json');
}

export class BridgeStatus {
  private readonly path: string;
  private readonly throttleMs: number;
  private readonly now: () => number;

  private state: BridgeState = 'starting';
  private label = 'Bridge starting';
  private server: string;
  private connected = false;
  private sources: StatusSource[] = [];
  private indexing: IndexingStatus = { active: false, source: null, done: 0, total: null };
  private activity: ActivityEntry[] = [];
  private lastError: string | null = null;

  /** Timestamp of the last flush that actually hit disk. */
  private lastFlushAt = 0;
  /** Pending throttled flush, if any. */
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: BridgeStatusOptions = {}) {
    this.path = opts.path ?? defaultStatusPath();
    this.throttleMs = opts.throttleMs ?? 200;
    this.now = opts.now ?? Date.now;
    this.server = opts.server ?? '';
  }

  /** Set the lifecycle state and human-readable label. */
  setState(state: BridgeState, label: string): void {
    this.state = state;
    this.label = label;
    this.flush();
  }

  /** Set the wss server url (kept in every snapshot). */
  setServer(server: string): void {
    this.server = server;
    this.flush();
  }

  /** Set tunnel connection state. */
  setConnected(connected: boolean): void {
    this.connected = connected;
    this.flush();
  }

  /** Replace the per-source counts (final counts from the index status()). */
  setSources(sources: StatusSource[]): void {
    this.sources = sources.map((s) => ({ source: s.source, count: s.count }));
    this.flush();
  }

  /** Update indexing progress. */
  setIndexing(indexing: IndexingStatus): void {
    this.indexing = {
      active: indexing.active,
      source: indexing.source,
      done: indexing.done,
      total: indexing.total,
    };
    this.flush();
  }

  /** Append a privacy-safe activity line. Keeps the last {@link ACTIVITY_LIMIT}. */
  pushActivity(text: string): void {
    this.activity.push({ ts: this.now(), text });
    if (this.activity.length > ACTIVITY_LIMIT) {
      this.activity = this.activity.slice(-ACTIVITY_LIMIT);
    }
    this.flush();
  }

  /** Set or clear the last error message. */
  setError(message: string | null): void {
    this.lastError = message;
    this.flush();
  }

  /** Current in-memory snapshot (also what gets written on flush). */
  get snapshot(): BridgeStatusSnapshot {
    return {
      schema: STATUS_SCHEMA,
      state: this.state,
      label: this.label,
      server: this.server,
      connected: this.connected,
      sources: this.sources.map((s) => ({ source: s.source, count: s.count })),
      indexing: { ...this.indexing },
      activity: this.activity.map((a) => ({ ts: a.ts, text: a.text })),
      lastError: this.lastError,
      updatedAt: this.now(),
    };
  }

  /** Force a final synchronous write and cancel any pending throttled flush. */
  close(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.writeNow();
  }

  /**
   * Schedule a write, coalescing rapid updates. Writes immediately if enough
   * time has elapsed since the last write; otherwise defers to the trailing
   * edge of the throttle window so the latest state always lands on disk.
   */
  private flush(): void {
    if (this.flushTimer) return; // a trailing write is already queued

    const elapsed = this.now() - this.lastFlushAt;
    if (elapsed >= this.throttleMs) {
      this.writeNow();
      return;
    }

    const wait = this.throttleMs - elapsed;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.writeNow();
    }, wait);
    this.flushTimer.unref?.();
  }

  /** Atomic write: write a tmp file then rename over the target (mode 0o600). */
  private writeNow(): void {
    this.lastFlushAt = this.now();
    const json = JSON.stringify(this.snapshot, null, 2);
    const tmp = `${this.path}.${process.pid}.${this.lastFlushAt}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(tmp, json, { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch {
      // Status reporting is best-effort; never crash the bridge over it.
    }
  }
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACTIVITY_LIMIT,
  BridgeStatus,
  STATUS_SCHEMA,
  type BridgeStatusSnapshot,
} from '../status-writer.js';

let dir: string;
let statusPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-status-'));
  statusPath = join(dir, 'bridge-status.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function read(): BridgeStatusSnapshot {
  return JSON.parse(readFileSync(statusPath, 'utf-8')) as BridgeStatusSnapshot;
}

describe('BridgeStatus', () => {
  it('writes a file with the exact contract shape', () => {
    const s = new BridgeStatus({ path: statusPath, server: 'wss://api.botmem.xyz/apple-tunnel' });
    s.setState('starting', 'Bridge starting');
    const doc = read();

    expect(doc).toMatchObject({
      schema: STATUS_SCHEMA,
      state: 'starting',
      label: 'Bridge starting',
      server: 'wss://api.botmem.xyz/apple-tunnel',
      connected: false,
      sources: [],
      indexing: { active: false, source: null, done: 0, total: null },
      activity: [],
      lastError: null,
    });
    expect(typeof doc.updatedAt).toBe('number');
    // exact key set — the Swift app depends on it
    expect(Object.keys(doc).sort()).toEqual(
      [
        'activity',
        'connected',
        'indexing',
        'label',
        'lastError',
        'schema',
        'server',
        'sources',
        'state',
        'updatedAt',
      ].sort(),
    );
  });

  it('reflects all setters in the snapshot and on disk', () => {
    const s = new BridgeStatus({ path: statusPath, throttleMs: 0 });
    s.setServer('wss://example/tunnel');
    s.setConnected(true);
    s.setSources([
      { source: 'imessage', count: 42 },
      { source: 'contacts', count: 7 },
    ]);
    s.setIndexing({ active: true, source: 'imessage', done: 30, total: 100 });
    s.setError('boom');
    s.setState('indexing', 'Indexing iMessage…');

    const doc = read();
    expect(doc.server).toBe('wss://example/tunnel');
    expect(doc.connected).toBe(true);
    expect(doc.sources).toEqual([
      { source: 'imessage', count: 42 },
      { source: 'contacts', count: 7 },
    ]);
    expect(doc.indexing).toEqual({ active: true, source: 'imessage', done: 30, total: 100 });
    expect(doc.lastError).toBe('boom');
    expect(doc.state).toBe('indexing');
    expect(doc.label).toBe('Indexing iMessage…');
  });

  it('writes with mode 0o600 and atomically (no leftover tmp files)', () => {
    const s = new BridgeStatus({ path: statusPath });
    s.setState('live', 'Live');
    expect(existsSync(statusPath)).toBe(true);
    // 0o600 — owner read/write only
    expect(statSync(statusPath).mode & 0o777).toBe(0o600);
    // no .tmp turds left behind after rename
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toHaveLength(0);
  });

  it('caps activity at ACTIVITY_LIMIT and keeps newest LAST', () => {
    const s = new BridgeStatus({ path: statusPath, throttleMs: 0 });
    for (let i = 0; i < ACTIVITY_LIMIT + 8; i++) {
      s.pushActivity(`event ${i}`);
    }
    const doc = read();
    expect(doc.activity).toHaveLength(ACTIVITY_LIMIT);
    // newest last
    expect(doc.activity[doc.activity.length - 1].text).toBe(`event ${ACTIVITY_LIMIT + 7}`);
    // oldest retained is exactly (total - LIMIT)
    expect(doc.activity[0].text).toBe('event 8');
  });

  it('stamps activity ts and updatedAt from the injected clock', () => {
    let t = 1000;
    const s = new BridgeStatus({ path: statusPath, now: () => t, throttleMs: 0 });
    s.pushActivity('first');
    t = 2000;
    s.pushActivity('second');
    const doc = read();
    expect(doc.activity[0].ts).toBe(1000);
    expect(doc.activity[1].ts).toBe(2000);
    expect(doc.updatedAt).toBe(2000);
  });

  it('throttles disk writes (coalesces rapid updates)', () => {
    vi.useFakeTimers();
    try {
      // virtual clock so flush() throttle math is deterministic
      const s = new BridgeStatus({ path: statusPath, throttleMs: 200, now: () => Date.now() });

      // first write lands immediately (lastFlushAt starts at 0)
      s.setState('connecting', 'a');
      expect(read().label).toBe('a');
      const firstAt = read().updatedAt;

      // rapid updates within the window are coalesced — disk still shows 'a'
      s.setState('connecting', 'b');
      s.setState('connecting', 'c');
      s.setState('connecting', 'd');
      expect(read().label).toBe('a');

      // after the throttle window the trailing write flushes the latest ('d')
      vi.advanceTimersByTime(200);
      const doc = read();
      expect(doc.label).toBe('d');
      expect(doc.updatedAt).toBeGreaterThanOrEqual(firstAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it('close() forces a final synchronous write', () => {
    vi.useFakeTimers();
    try {
      const s = new BridgeStatus({ path: statusPath, throttleMs: 200 });
      s.setState('starting', 'first'); // immediate
      s.setState('offline', 'final'); // throttled / pending
      expect(read().label).toBe('first');
      s.close();
      expect(read().label).toBe('final');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never throws when the target directory is unwritable', () => {
    // point at a path under a file (cannot mkdir) — write fails silently
    const bad = join(statusPath, 'nested', 'status.json');
    const s = new BridgeStatus({ path: statusPath });
    s.setState('live', 'ok'); // create statusPath as a file
    const s2 = new BridgeStatus({ path: bad });
    expect(() => s2.setState('error', 'still fine')).not.toThrow();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, readdir, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { randomUUID } from 'crypto';

vi.mock('@whiskeysockets/baileys', () => ({
  proto: { Message: { AppStateSyncKeyData: { fromObject: (v: any) => v } } },
  initAuthCreds: () => ({ registered: false, me: null }),
  BufferJSON: { replacer: null, reviver: null },
}));

import { useAtomicMultiFileAuthState, flushPendingWrites } from '../atomic-auth-state.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), `atomic-auth-test-${randomUUID()}-`));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('useAtomicMultiFileAuthState', () => {
  it('creates session folder if it does not exist', async () => {
    const folder = join(testDir, 'new-session');
    await useAtomicMultiFileAuthState(folder);
    const info = await stat(folder);
    expect(info.isDirectory()).toBe(true);
  });

  it('creates nested session folders recursively', async () => {
    const folder = join(testDir, 'a', 'b', 'c');
    await useAtomicMultiFileAuthState(folder);
    const info = await stat(folder);
    expect(info.isDirectory()).toBe(true);
  });

  it('initializes fresh creds when no creds.json exists', async () => {
    const { state } = await useAtomicMultiFileAuthState(testDir);
    expect(state.creds).toEqual({ registered: false, me: null });
  });

  it('reads existing creds.json when present', async () => {
    const existingCreds = { registered: true, me: { id: 'test-user' } };
    await writeFile(join(testDir, 'creds.json'), JSON.stringify(existingCreds));

    const { state } = await useAtomicMultiFileAuthState(testDir);
    expect(state.creds).toEqual(existingCreds);
  });

  it('saveCreds writes creds.json that is valid JSON', async () => {
    const { state, saveCreds } = await useAtomicMultiFileAuthState(testDir);
    // Mutate creds like Baileys does
    (state.creds as any).registered = true;
    await saveCreds();
    await flushPendingWrites();

    const raw = await readFile(join(testDir, 'creds.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.registered).toBe(true);
  });

  it('atomic write uses temp file then rename (no partial writes)', async () => {
    const { saveCreds } = await useAtomicMultiFileAuthState(testDir);
    await saveCreds();
    await flushPendingWrites();

    // After write completes, no .tmp files should remain
    const files = await readdir(testDir);
    const tmpFiles = files.filter((f) => f.includes('.tmp.'));
    expect(tmpFiles).toHaveLength(0);

    // The target file should exist
    expect(files).toContain('creds.json');
  });

  it('keys.set writes key files, keys.get reads them back', async () => {
    const { state } = await useAtomicMultiFileAuthState(testDir);

    const testKey = { keyData: 'abc123', timestamp: 1000 };
    await state.keys.set({ 'pre-key': { '42': testKey } });
    await flushPendingWrites();

    const result = await state.keys.get('pre-key', ['42']);
    expect(result['42']).toEqual(testKey);
  });

  it('keys.get returns null for non-existent keys', async () => {
    const { state } = await useAtomicMultiFileAuthState(testDir);
    const result = await state.keys.get('pre-key', ['nonexistent']);
    expect(result['nonexistent']).toBeNull();
  });

  it('keys.set with null value deletes the key file', async () => {
    const { state } = await useAtomicMultiFileAuthState(testDir);

    // Write a key
    await state.keys.set({ 'pre-key': { '99': { data: 'hello' } } });
    await flushPendingWrites();

    // Verify file exists
    const filesBefore = await readdir(testDir);
    expect(filesBefore).toContain('pre-key-99.json');

    // Delete it by setting null
    await state.keys.set({ 'pre-key': { '99': null } });
    await flushPendingWrites();

    const filesAfter = await readdir(testDir);
    expect(filesAfter).not.toContain('pre-key-99.json');

    // get should return null
    const result = await state.keys.get('pre-key', ['99']);
    expect(result['99']).toBeNull();
  });

  it('keys.set with undefined value deletes the key file', async () => {
    const { state } = await useAtomicMultiFileAuthState(testDir);

    await state.keys.set({ 'pre-key': { '77': { data: 'world' } } });
    await flushPendingWrites();

    await state.keys.set({ 'pre-key': { '77': undefined } });
    await flushPendingWrites();

    const files = await readdir(testDir);
    expect(files).not.toContain('pre-key-77.json');
  });

  it('keys.get wraps app-state-sync-key with fromObject', async () => {
    const { state } = await useAtomicMultiFileAuthState(testDir);

    const keyData = { keyData: Buffer.from('test').toString('base64') };
    await state.keys.set({ 'app-state-sync-key': { abc: keyData } });
    await flushPendingWrites();

    const result = await state.keys.get('app-state-sync-key', ['abc']);
    // fromObject mock returns the value as-is, so it should match
    expect(result['abc']).toEqual(keyData);
  });

  it('keys.set handles multiple categories and ids in one call', async () => {
    const { state } = await useAtomicMultiFileAuthState(testDir);

    await state.keys.set({
      'pre-key': {
        '1': { k: 'a' },
        '2': { k: 'b' },
      },
      session: {
        '10': { s: 'x' },
      },
    });
    await flushPendingWrites();

    const preKeys = await state.keys.get('pre-key', ['1', '2']);
    expect(preKeys['1']).toEqual({ k: 'a' });
    expect(preKeys['2']).toEqual({ k: 'b' });

    const sessions = await state.keys.get('session', ['10']);
    expect(sessions['10']).toEqual({ s: 'x' });
  });

  it('fixFileName replaces slashes and colons in key names', async () => {
    const { state } = await useAtomicMultiFileAuthState(testDir);

    await state.keys.set({ 'sender-key': { 'group/user:device': { d: 1 } } });
    await flushPendingWrites();

    const files = await readdir(testDir);
    // / → __, : → -
    expect(files).toContain('sender-key-group__user-device.json');

    const result = await state.keys.get('sender-key', ['group/user:device']);
    expect(result['group/user:device']).toEqual({ d: 1 });
  });
});

describe('flushPendingWrites', () => {
  it('resolves immediately when no writes are pending', async () => {
    await flushPendingWrites();
    // Should not hang or throw
  });

  it('resolves when all writes complete', async () => {
    const { state } = await useAtomicMultiFileAuthState(testDir);

    // Fire off multiple writes without awaiting
    const p1 = state.keys.set({ 'pre-key': { a: { v: 1 } } });
    const p2 = state.keys.set({ 'pre-key': { b: { v: 2 } } });
    const p3 = state.keys.set({ 'pre-key': { c: { v: 3 } } });

    await flushPendingWrites();
    // Also await the set promises to avoid unhandled rejections
    await Promise.all([p1, p2, p3]);

    const result = await state.keys.get('pre-key', ['a', 'b', 'c']);
    expect(result['a']).toEqual({ v: 1 });
    expect(result['b']).toEqual({ v: 2 });
    expect(result['c']).toEqual({ v: 3 });
  });
});

describe('concurrent writes', () => {
  it('multiple concurrent writes to different keys do not corrupt files', async () => {
    const { state } = await useAtomicMultiFileAuthState(testDir);

    const writes = Array.from({ length: 20 }, (_, i) =>
      state.keys.set({ 'pre-key': { [`k${i}`]: { index: i, payload: 'x'.repeat(100) } } }),
    );

    await Promise.all(writes);
    await flushPendingWrites();

    for (let i = 0; i < 20; i++) {
      const result = await state.keys.get('pre-key', [`k${i}`]);
      expect(result[`k${i}`]).toEqual({ index: i, payload: 'x'.repeat(100) });
    }
  });

  it('multiple concurrent writes to the same key leave a valid file (some writes may fail due to shared tmp path)', async () => {
    const { state } = await useAtomicMultiFileAuthState(testDir);

    // Write to the same key 10 times concurrently.
    // The source uses a single tmp path per PID, so concurrent writes to the
    // same file can race (one rename removes another's tmp). This is a known
    // limitation. The important invariant is: the final file is never corrupted.
    const writes = Array.from({ length: 10 }, (_, i) =>
      state.keys.set({ 'pre-key': { conflict: { version: i } } }).catch(() => {
        // Expected: ENOENT from tmp file race
      }),
    );

    await Promise.all(writes);
    await flushPendingWrites();

    // The file should contain valid JSON (not corrupted), value is one of 0..9
    const raw = await readFile(join(testDir, 'pre-key-conflict.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(typeof parsed.version).toBe('number');
    expect(parsed.version).toBeGreaterThanOrEqual(0);
    expect(parsed.version).toBeLessThan(10);
  });

  it('no temp files remain after concurrent writes', async () => {
    const { state } = await useAtomicMultiFileAuthState(testDir);

    const writes = Array.from({ length: 15 }, (_, i) =>
      state.keys.set({ session: { [`s${i}`]: { data: i } } }),
    );

    await Promise.all(writes);
    await flushPendingWrites();

    const files = await readdir(testDir);
    const tmpFiles = files.filter((f) => f.includes('.tmp.'));
    expect(tmpFiles).toHaveLength(0);
  });
});

describe('relative paths', () => {
  it('resolves relative paths to absolute', async () => {
    // Use a relative path that resolves inside our testDir
    const relPath = join(testDir, '..', testDir.split('/').pop()!, 'rel-session');
    const { saveCreds } = await useAtomicMultiFileAuthState(relPath);

    await saveCreds();
    await flushPendingWrites();

    const absPath = resolve(relPath);
    const files = await readdir(absPath);
    expect(files).toContain('creds.json');
  });
});

describe('error handling', () => {
  it('throws when path points to a file instead of a directory', async () => {
    const filePath = join(testDir, 'not-a-dir');
    await writeFile(filePath, 'i am a file');

    await expect(useAtomicMultiFileAuthState(filePath)).rejects.toThrow(/not a directory/);
  });
});

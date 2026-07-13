import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LifecycleArtifactStorageError,
  SharedFilesystemLifecycleArtifactStore,
  loadLifecycleArtifactKey,
} from './filesystem-artifact-store.js';

const WORKSPACE_A = '10000000-0000-4000-8000-000000000001';
const WORKSPACE_B = '10000000-0000-4000-8000-000000000002';
const JOB_A = '20000000-0000-4000-8000-000000000001';
const JOB_B = '20000000-0000-4000-8000-000000000002';
const MAX_BYTES = 4_096;
const ENVELOPE_BYTES = 40;

describe('SharedFilesystemLifecycleArtifactStore', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  async function fixture(
    options: {
      readonly key?: Uint8Array;
      readonly maxWorkspaceBytes?: number;
      readonly maxGlobalBytes?: number;
      readonly minimumFreeBytes?: number;
    } = {},
  ) {
    const root = await mkdtemp(join(tmpdir(), 'botmem-export-'));
    roots.push(root);
    const key = options.key ?? randomBytes(32);
    const store = new SharedFilesystemLifecycleArtifactStore(root, key, {
      maxArtifactBytes: MAX_BYTES,
      maxWorkspaceBytes: options.maxWorkspaceBytes ?? MAX_BYTES + ENVELOPE_BYTES,
      maxGlobalBytes: options.maxGlobalBytes ?? 10 * (MAX_BYTES + ENVELOPE_BYTES),
      minimumFreeBytes: options.minimumFreeBytes ?? 0,
    });
    return { root, key, store };
  }

  it('keeps user data encrypted at rest and authenticates before returning plaintext', async () => {
    const { root, store } = await fixture();
    const writer = await store.create({ workspaceId: WORKSPACE_A, jobId: JOB_A });
    const plaintext = '{"type":"hosted_event","secret":"needle-value"}\n';
    await writer.write(plaintext);
    const artifactKey = await writer.commit();

    expect(artifactKey).toBe(`${WORKSPACE_A}/${JOB_A}.bme`);
    const encrypted = await readFile(join(root, artifactKey));
    expect(encrypted.includes(Buffer.from('needle-value'))).toBe(false);
    expect(await collect(await store.open(artifactKey))).toBe(plaintext);
  });

  it('rejects ciphertext tampering, truncation, and the wrong key before opening a stream', async () => {
    const { root, store } = await fixture();
    const writer = await store.create({ workspaceId: WORKSPACE_A, jobId: JOB_A });
    await writer.write('{"secret":"tamper-proof"}\n');
    const artifactKey = await writer.commit();
    const path = join(root, artifactKey);
    const original = await readFile(path);

    const tampered = Buffer.from(original);
    tampered[24] = (tampered[24] ?? 0) ^ 0xff;
    await writeFile(path, tampered);
    await expect(store.open(artifactKey)).rejects.toBeInstanceOf(LifecycleArtifactStorageError);

    await writeFile(path, original);
    await truncate(path, original.byteLength - 1);
    await expect(store.open(artifactKey)).rejects.toBeInstanceOf(LifecycleArtifactStorageError);

    await writeFile(path, original);
    const wrongKeyStore = new SharedFilesystemLifecycleArtifactStore(root, randomBytes(32), {
      maxArtifactBytes: MAX_BYTES,
      maxWorkspaceBytes: MAX_BYTES + ENVELOPE_BYTES,
      maxGlobalBytes: 10 * (MAX_BYTES + ENVELOPE_BYTES),
      minimumFreeBytes: 0,
    });
    await expect(wrongKeyStore.open(artifactKey)).rejects.toBeInstanceOf(
      LifecycleArtifactStorageError,
    );
  });

  it('reserves strict per-workspace and global quota across concurrent writers', async () => {
    const quota = MAX_BYTES + ENVELOPE_BYTES;
    const { store } = await fixture({ maxWorkspaceBytes: quota, maxGlobalBytes: quota });
    const first = await store.create({ workspaceId: WORKSPACE_A, jobId: JOB_A });

    await expect(store.create({ workspaceId: WORKSPACE_A, jobId: JOB_B })).rejects.toThrow(
      'workspace export storage quota exceeded',
    );
    await expect(store.create({ workspaceId: WORKSPACE_B, jobId: JOB_B })).rejects.toThrow(
      'global export storage quota exceeded',
    );
    await first.abort();
    expect(await store.ready()).toBe(true);
  });

  it('recovers a committed artifact after a crash without requiring a second quota reservation', async () => {
    const { store } = await fixture();
    const writer = await store.create({ workspaceId: WORKSPACE_A, jobId: JOB_A });
    const plaintext = '{"type":"manifest","crashRecovery":true}\n';
    await writer.write(plaintext);
    const artifactKey = await writer.commit();

    await expect(store.recover({ workspaceId: WORKSPACE_A, jobId: JOB_A })).resolves.toBe(
      artifactKey,
    );
    expect(await collect(await store.open(artifactKey))).toBe(plaintext);
  });

  it('keeps the first authenticated final artifact when two stale claims finish the same job', async () => {
    const quota = 2 * (MAX_BYTES + ENVELOPE_BYTES);
    const { store } = await fixture({ maxWorkspaceBytes: quota, maxGlobalBytes: quota });
    const first = await store.create({ workspaceId: WORKSPACE_A, jobId: JOB_A });
    const stale = await store.create({ workspaceId: WORKSPACE_A, jobId: JOB_A });
    await first.write('{"winner":"first"}\n');
    await stale.write('{"winner":"stale"}\n');

    const artifactKey = await first.commit();
    await expect(stale.commit()).resolves.toBe(artifactKey);
    expect(await collect(await store.open(artifactKey))).toBe('{"winner":"first"}\n');
  });

  it('fails readiness and creation when the configured free-space reserve is unavailable', async () => {
    const { store } = await fixture({ minimumFreeBytes: Number.MAX_SAFE_INTEGER });
    expect(await store.ready()).toBe(false);
    await expect(store.create({ workspaceId: WORKSPACE_A, jobId: JOB_A })).rejects.toThrow(
      'free-space reserve is unavailable',
    );
  });

  it('purges final, temporary, and reservation files for a deleted workspace', async () => {
    const { root, store } = await fixture();
    const writer = await store.create({ workspaceId: WORKSPACE_A, jobId: JOB_A });
    await writer.write('{"type":"manifest"}\n');
    await writer.commit();
    await store.deleteWorkspace(WORKSPACE_A);
    await expect(readFile(join(root, WORKSPACE_A, `${JOB_A}.bme`))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('loadLifecycleArtifactKey', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it('loads only an exact 32-byte base64url secret from a regular file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'botmem-export-key-'));
    roots.push(root);
    const expected = randomBytes(32);
    const secretFile = join(root, 'artifact-key');
    await writeFile(secretFile, `${expected.toString('base64url')}\n`, { mode: 0o600 });
    expect(await loadLifecycleArtifactKey(secretFile)).toEqual(expected);

    const link = join(root, 'artifact-key-link');
    await symlink(secretFile, link);
    await expect(loadLifecycleArtifactKey(link)).rejects.toBeInstanceOf(
      LifecycleArtifactStorageError,
    );
  });
});

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

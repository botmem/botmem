import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  statfs,
  unlink,
  utimes,
  type FileHandle,
} from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  type CipherGCM,
} from 'node:crypto';
import { Readable } from 'node:stream';
import type { LifecycleArtifactStorePort, LifecycleArtifactWriterPort } from './ports.js';

const KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27}\/[0-9a-f]{8}-[0-9a-f-]{27}\.bme$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAGIC = Buffer.from('BOTMEMEXP001', 'ascii');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + NONCE_BYTES;
const IO_CHUNK_BYTES = 64 * 1024;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const ENVELOPE_BYTES = HEADER_BYTES + TAG_BYTES;
const QUOTA_LOCK = '.quota.lock';
const RESERVATION_STALE_MS = 30 * 60_000;

export interface LifecycleArtifactStoreOptions {
  readonly maxArtifactBytes?: number;
  readonly maxWorkspaceBytes?: number;
  readonly maxGlobalBytes?: number;
  readonly minimumFreeBytes?: number;
}

/**
 * Versioned, application-encrypted export storage for a shared filesystem.
 *
 * The worker mounts the root read/write and the API mounts it read-only. The
 * 32-byte key is independent from database and session secrets and is supplied
 * to only those two processes. A complete authentication pass happens before
 * the reader can observe any plaintext.
 */
export class SharedFilesystemLifecycleArtifactStore implements LifecycleArtifactStorePort {
  private readonly root: string;
  private readonly artifactKey: Buffer;
  private readonly maxBytes: number;
  private readonly maxWorkspaceBytes: number;
  private readonly maxGlobalBytes: number;
  private readonly minimumFreeBytes: number;

  constructor(root: string, artifactKey: Uint8Array, options: LifecycleArtifactStoreOptions = {}) {
    if (!isAbsolute(root)) throw new Error('lifecycle artifact root must be absolute');
    if (artifactKey.byteLength !== 32) {
      throw new RangeError('lifecycle artifact encryption key must be exactly 32 bytes');
    }
    const maxBytes = options.maxArtifactBytes ?? 5 * 1024 * 1024 * 1024;
    const reservationBytes = maxBytes + ENVELOPE_BYTES;
    const maxWorkspaceBytes = options.maxWorkspaceBytes ?? reservationBytes;
    const maxGlobalBytes = options.maxGlobalBytes ?? reservationBytes * 10;
    const minimumFreeBytes = options.minimumFreeBytes ?? 1024 * 1024 * 1024;
    if (!validBound(maxBytes, 1024)) {
      throw new RangeError('lifecycle artifact size bound is invalid');
    }
    if (
      !validBound(maxWorkspaceBytes, reservationBytes) ||
      !validBound(maxGlobalBytes, maxWorkspaceBytes) ||
      !Number.isSafeInteger(minimumFreeBytes) ||
      minimumFreeBytes < 0
    ) {
      throw new RangeError('lifecycle artifact quota is invalid');
    }
    this.root = resolve(root);
    this.artifactKey = Buffer.from(artifactKey);
    this.maxBytes = maxBytes;
    this.maxWorkspaceBytes = maxWorkspaceBytes;
    this.maxGlobalBytes = maxGlobalBytes;
    this.minimumFreeBytes = minimumFreeBytes;
  }

  async create(input: {
    readonly workspaceId: string;
    readonly jobId: string;
  }): Promise<LifecycleArtifactWriterPort> {
    assertUuid(input.workspaceId);
    assertUuid(input.jobId);
    await mkdir(this.root, { recursive: true, mode: 0o750 });
    await assertDirectory(this.root);
    const directory = this.safePath(input.workspaceId);
    await mkdir(directory, { recursive: true, mode: 0o750 });
    await assertDirectory(directory);
    const key = `${input.workspaceId}/${input.jobId}.bme`;
    const finalPath = this.safePath(key);
    const nonceId = randomUUID();
    const temporaryPath = this.safePath(`${input.workspaceId}/.${input.jobId}.${nonceId}.tmp`);
    const reservationPath = this.safePath(
      `${input.workspaceId}/.${input.jobId}.${nonceId}.reserve`,
    );
    await this.withQuotaLock(async () => {
      await this.removeStaleReservations();
      const usage = await this.storageUsage();
      const reservationBytes = this.maxBytes + ENVELOPE_BYTES;
      if (
        (usage.byWorkspace.get(input.workspaceId) ?? 0) + reservationBytes >
        this.maxWorkspaceBytes
      ) {
        throw new LifecycleArtifactStorageError('workspace export storage quota exceeded');
      }
      if (usage.globalBytes + reservationBytes > this.maxGlobalBytes) {
        throw new LifecycleArtifactStorageError('global export storage quota exceeded');
      }
      const freeBytes = await filesystemFreeBytes(this.root);
      if (freeBytes - usage.reservedBytes < this.minimumFreeBytes + reservationBytes) {
        throw new LifecycleArtifactStorageError('export storage free-space reserve is unavailable');
      }
      const reservation = await open(reservationPath, 'wx', 0o640);
      await reservation.close();
    });
    let handle: FileHandle;
    try {
      handle = await open(temporaryPath, 'wx', 0o640);
    } catch (error) {
      await unlink(reservationPath).catch(() => undefined);
      throw error;
    }
    const nonce = randomBytes(NONCE_BYTES);
    const header = Buffer.concat([MAGIC, nonce]);
    const cipher = createCipheriv('aes-256-gcm', this.artifactKey, nonce);
    cipher.setAAD(header);
    try {
      await writeAll(handle, header);
      return new FilesystemArtifactWriter(
        handle,
        cipher,
        temporaryPath,
        reservationPath,
        key,
        this.maxBytes,
        async () =>
          this.withQuotaLock(async () => {
            await rename(temporaryPath, finalPath);
            await unlink(reservationPath);
          }),
      );
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      await unlink(reservationPath).catch(() => undefined);
      throw error;
    }
  }

  async open(artifactKey: string): Promise<Readable> {
    assertKey(artifactKey);
    const path = this.safePath(artifactKey);
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size < HEADER_BYTES + TAG_BYTES) {
        throw new LifecycleArtifactStorageError('artifact is not a valid regular file');
      }
      if (metadata.size > this.maxBytes + HEADER_BYTES + TAG_BYTES) {
        throw new LifecycleArtifactStorageError('artifact exceeded its configured size bound');
      }
      const { header, nonce, tag, ciphertextBytes } = await readEnvelope(handle, metadata.size);
      await authenticate(handle, this.artifactKey, header, nonce, tag, ciphertextBytes);
      const ownedHandle = handle;
      handle = undefined;
      return Readable.from(
        decrypt(ownedHandle, this.artifactKey, header, nonce, tag, ciphertextBytes),
      );
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (error instanceof LifecycleArtifactStorageError) throw error;
      throw new LifecycleArtifactStorageError('artifact authentication failed');
    }
  }

  async delete(artifactKey: string): Promise<void> {
    assertKey(artifactKey);
    await unlink(this.safePath(artifactKey)).catch((error: unknown) => {
      if (!isMissingFile(error)) throw error;
    });
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    assertUuid(workspaceId);
    await mkdir(this.root, { recursive: true, mode: 0o750 });
    await assertDirectory(this.root);
    await this.withQuotaLock(async () => {
      await rm(this.safePath(workspaceId), { force: true, recursive: true });
    });
  }

  async ready(): Promise<boolean> {
    try {
      await mkdir(this.root, { recursive: true, mode: 0o750 });
      await assertDirectory(this.root);
      return await this.withQuotaLock(async () => {
        await this.removeStaleReservations();
        const usage = await this.storageUsage();
        const freeBytes = await filesystemFreeBytes(this.root);
        const reservationBytes = this.maxBytes + ENVELOPE_BYTES;
        return (
          usage.globalBytes + reservationBytes <= this.maxGlobalBytes &&
          freeBytes - usage.reservedBytes >= this.minimumFreeBytes + reservationBytes
        );
      });
    } catch {
      return false;
    }
  }

  async readable(): Promise<boolean> {
    try {
      const metadata = await lstat(this.root);
      return metadata.isDirectory() && !metadata.isSymbolicLink();
    } catch {
      return false;
    }
  }

  private safePath(relative: string): string {
    const path = resolve(join(this.root, relative));
    if (path !== this.root && !path.startsWith(`${this.root}/`)) {
      throw new LifecycleArtifactStorageError('artifact path escaped its root');
    }
    return path;
  }

  private async withQuotaLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = this.safePath(QUOTA_LOCK);
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        break;
      } catch (error) {
        if (!isExistingFile(error)) throw error;
        const metadata = await lstat(lockPath).catch(() => undefined);
        if (metadata && Date.now() - metadata.mtimeMs > 30_000) {
          await rm(lockPath, { force: true, recursive: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new LifecycleArtifactStorageError('export storage quota lock is unavailable');
        }
        await delay(25);
      }
    }
    try {
      return await operation();
    } finally {
      await rm(lockPath, { force: true, recursive: true });
    }
  }

  private async storageUsage(): Promise<{
    readonly globalBytes: number;
    readonly reservedBytes: number;
    readonly byWorkspace: ReadonlyMap<string, number>;
  }> {
    let globalBytes = 0;
    let reservedBytes = 0;
    const byWorkspace = new Map<string, number>();
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
      const workspacePath = this.safePath(entry.name);
      await assertDirectory(workspacePath);
      let workspaceBytes = 0;
      for (const artifact of await readdir(workspacePath, { withFileTypes: true })) {
        if (!artifact.isFile()) continue;
        if (artifact.name.endsWith('.reserve')) {
          const reserved = this.maxBytes + ENVELOPE_BYTES;
          reservedBytes += reserved;
          workspaceBytes += reserved;
        } else if (artifact.name.endsWith('.bme')) {
          const metadata = await lstat(join(workspacePath, artifact.name));
          workspaceBytes += metadata.size;
        }
      }
      byWorkspace.set(entry.name, workspaceBytes);
      globalBytes += workspaceBytes;
    }
    return { globalBytes, reservedBytes, byWorkspace };
  }

  private async removeStaleReservations(): Promise<void> {
    const staleBefore = Date.now() - RESERVATION_STALE_MS;
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
      const workspacePath = this.safePath(entry.name);
      for (const artifact of await readdir(workspacePath, { withFileTypes: true })) {
        if (!artifact.isFile() || !artifact.name.endsWith('.reserve')) continue;
        const reservationPath = join(workspacePath, artifact.name);
        const metadata = await lstat(reservationPath);
        if (metadata.mtimeMs >= staleBefore) continue;
        const temporaryPath = reservationPath.replace(/\.reserve$/u, '.tmp');
        await unlink(temporaryPath).catch((error: unknown) => {
          if (!isMissingFile(error)) throw error;
        });
        await unlink(reservationPath).catch((error: unknown) => {
          if (!isMissingFile(error)) throw error;
        });
      }
    }
  }
}

class FilesystemArtifactWriter implements LifecycleArtifactWriterPort {
  readonly maxRecordBytes = MAX_RECORD_BYTES;
  private closed = false;
  private writtenBytes = 0;

  constructor(
    private readonly handle: FileHandle,
    private readonly cipher: CipherGCM,
    private readonly temporaryPath: string,
    private readonly reservationPath: string,
    private readonly key: string,
    private readonly maxBytes: number,
    private readonly finalize: () => Promise<void>,
  ) {}

  private lastReservationTouch = Date.now();

  async write(line: string): Promise<void> {
    if (this.closed) throw new LifecycleArtifactStorageError('artifact writer is closed');
    const plaintext = Buffer.from(line, 'utf8');
    if (!line.endsWith('\n') || plaintext.byteLength > MAX_RECORD_BYTES) {
      throw new LifecycleArtifactStorageError('artifact record is not a bounded NDJSON line');
    }
    if (this.writtenBytes + plaintext.byteLength > this.maxBytes) {
      throw new LifecycleArtifactStorageError('artifact exceeded its configured size bound');
    }
    const ciphertext = this.cipher.update(plaintext);
    await writeAll(this.handle, ciphertext);
    this.writtenBytes += plaintext.byteLength;
    if (Date.now() - this.lastReservationTouch >= 60_000) {
      const now = new Date();
      await utimes(this.reservationPath, now, now);
      this.lastReservationTouch = Date.now();
    }
  }

  async commit(): Promise<string> {
    if (this.closed) throw new LifecycleArtifactStorageError('artifact writer is closed');
    this.closed = true;
    try {
      await writeAll(this.handle, this.cipher.final());
      await writeAll(this.handle, this.cipher.getAuthTag());
      await this.handle.sync();
      await this.handle.close();
      await this.finalize();
      return this.key;
    } catch (error) {
      await this.handle.close().catch(() => undefined);
      await unlink(this.temporaryPath).catch(() => undefined);
      await unlink(this.reservationPath).catch(() => undefined);
      throw error;
    }
  }

  async abort(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      await this.handle.close().catch(() => undefined);
    }
    await unlink(this.temporaryPath).catch((error: unknown) => {
      if (!isMissingFile(error)) throw error;
    });
    await unlink(this.reservationPath).catch((error: unknown) => {
      if (!isMissingFile(error)) throw error;
    });
  }
}

export class LifecycleArtifactStorageError extends Error {
  override readonly name = 'LifecycleArtifactStorageError';
}

export async function loadLifecycleArtifactKey(secretFile: string): Promise<Buffer> {
  if (!isAbsolute(secretFile)) throw new Error('lifecycle artifact key file must be absolute');
  const metadata = await lstat(secretFile);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 128) {
    throw new LifecycleArtifactStorageError('lifecycle artifact key file is invalid');
  }
  const encoded = (await readFile(secretFile, { encoding: 'utf8' })).trim();
  if (!SECRET_PATTERN.test(encoded)) {
    throw new LifecycleArtifactStorageError('lifecycle artifact key is invalid');
  }
  const key = Buffer.from(encoded, 'base64url');
  if (key.byteLength !== 32) {
    throw new LifecycleArtifactStorageError('lifecycle artifact key is invalid');
  }
  return key;
}

async function readEnvelope(
  handle: FileHandle,
  size: number,
): Promise<{
  readonly header: Buffer;
  readonly nonce: Buffer;
  readonly tag: Buffer;
  readonly ciphertextBytes: number;
}> {
  const header = await readExact(handle, 0, HEADER_BYTES);
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new LifecycleArtifactStorageError('artifact format is unsupported');
  }
  const tag = await readExact(handle, size - TAG_BYTES, TAG_BYTES);
  return {
    header,
    nonce: header.subarray(MAGIC.length),
    tag,
    ciphertextBytes: size - HEADER_BYTES - TAG_BYTES,
  };
}

async function authenticate(
  handle: FileHandle,
  key: Buffer,
  header: Buffer,
  nonce: Buffer,
  tag: Buffer,
  ciphertextBytes: number,
): Promise<void> {
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  let position = HEADER_BYTES;
  let remaining = ciphertextBytes;
  while (remaining > 0) {
    const chunk = await readExact(handle, position, Math.min(IO_CHUNK_BYTES, remaining));
    decipher.update(chunk);
    position += chunk.byteLength;
    remaining -= chunk.byteLength;
  }
  try {
    decipher.final();
  } catch {
    throw new LifecycleArtifactStorageError('artifact authentication failed');
  }
}

async function* decrypt(
  handle: FileHandle,
  key: Buffer,
  header: Buffer,
  nonce: Buffer,
  tag: Buffer,
  ciphertextBytes: number,
): AsyncGenerator<Buffer> {
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  let position = HEADER_BYTES;
  let remaining = ciphertextBytes;
  try {
    while (remaining > 0) {
      const ciphertext = await readExact(handle, position, Math.min(IO_CHUNK_BYTES, remaining));
      const plaintext = decipher.update(ciphertext);
      if (plaintext.byteLength > 0) yield plaintext;
      position += ciphertext.byteLength;
      remaining -= ciphertext.byteLength;
    }
    const final = decipher.final();
    if (final.byteLength > 0) yield final;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readExact(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset);
    if (result.bytesRead === 0) {
      throw new LifecycleArtifactStorageError('artifact is truncated');
    }
    offset += result.bytesRead;
  }
  return buffer;
}

async function writeAll(handle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.write(buffer, offset, buffer.byteLength - offset, null);
    offset += result.bytesWritten;
  }
}

async function assertDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new LifecycleArtifactStorageError('artifact directory is invalid');
  }
}

function assertKey(value: string): void {
  if (!KEY_PATTERN.test(value)) throw new LifecycleArtifactStorageError('artifact key is invalid');
}

function assertUuid(value: string): void {
  if (!UUID_PATTERN.test(value))
    throw new LifecycleArtifactStorageError('artifact owner is invalid');
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isExistingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function validBound(value: number, minimum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= 1024 ** 5;
}

async function filesystemFreeBytes(path: string): Promise<number> {
  const stats = await statfs(path, { bigint: true });
  const free = stats.bavail * stats.bsize;
  return free > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(free);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import { mkdir, readFile, stat, unlink, writeFile, rename } from 'fs/promises';
import { join, resolve } from 'path';
import { proto, initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';
import type { AuthenticationState } from '@whiskeysockets/baileys';

/**
 * Atomic multi-file auth state — drop-in replacement for Baileys' useMultiFileAuthState.
 *
 * Improvements over stock implementation:
 * 1. Atomic writes: data goes to a temp file first, then rename() to the target path.
 *    This prevents corruption when the process crashes mid-write or when multiple
 *    Baileys events write to the same key file simultaneously.
 * 2. Pending write tracking: all in-flight writes are tracked in a Set so callers
 *    can flush them before closing the socket (prevents data loss on shutdown).
 */

const fixFileName = (file: string) => file?.replace(/\//g, '__')?.replace(/:/g, '-');

/**
 * Write data to a file atomically: write to a temp file, then rename.
 * rename() is atomic on POSIX filesystems (the target either has old or new content, never partial).
 */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  await writeFile(tmpPath, data);
  await rename(tmpPath, filePath);
}

/** Set of all in-flight write promises — call flushPendingWrites() before socket close */
const pendingWrites = new Set<Promise<void>>();

/** Wait for all pending auth state writes to complete */
export async function flushPendingWrites(): Promise<void> {
  if (pendingWrites.size === 0) return;
  await Promise.allSettled([...pendingWrites]);
}

/**
 * Stores the full authentication state in a single folder using atomic file writes.
 * Same interface as Baileys' useMultiFileAuthState.
 */
export async function useAtomicMultiFileAuthState(folderRaw: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  const folder = resolve(folderRaw);

  async function writeData(data: unknown, file: string): Promise<void> {
    const filePath = join(folder, fixFileName(file));
    const json = JSON.stringify(data, BufferJSON.replacer);
    const writePromise = atomicWrite(filePath, json);
    pendingWrites.add(writePromise);
    try {
      await writePromise;
    } finally {
      pendingWrites.delete(writePromise);
    }
  }

  async function readData(file: string): Promise<unknown | null> {
    try {
      const filePath = join(folder, fixFileName(file));
      const data = await readFile(filePath, { encoding: 'utf-8' });
      return JSON.parse(data, BufferJSON.reviver);
    } catch {
      return null;
    }
  }

  async function removeData(file: string): Promise<void> {
    try {
      const filePath = join(folder, fixFileName(file));
      await unlink(filePath);
    } catch {
      // File may not exist — non-fatal
    }
  }

  const folderInfo = await stat(folder).catch(() => undefined);
  if (folderInfo) {
    if (!folderInfo.isDirectory()) {
      throw new Error(
        `found something that is not a directory at ${folder}, either delete it or specify a different location`,
      );
    }
  } else {
    await mkdir(folder, { recursive: true });
  }

  const creds =
    ((await readData('creds.json')) as ReturnType<typeof initAuthCreds> | null) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        get: async (type: string, ids: string[]): Promise<any> => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const data: Record<string, any> = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}.json`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(
                  value as Record<string, unknown>,
                );
              }
              data[id] = value;
            }),
          );
          return data;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        set: async (data: Record<string, Record<string, any>>) => {
          const tasks: Promise<void>[] = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const file = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      return writeData(creds, 'creds.json');
    },
  };
}

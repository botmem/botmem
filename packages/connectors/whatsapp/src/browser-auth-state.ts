import { randomUUID } from 'crypto';
import { initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';

/**
 * Auth state provider backed by browser IndexedDB via WebSocket.
 *
 * Implements the same interface as useMultiFileAuthState, but reads/writes
 * through a tunnel service that proxies to the browser's IndexedDB store.
 */

export interface AuthStateTransport {
  get(requestId: string, file: string): Promise<unknown>;
  set(requestId: string, file: string, data: unknown): Promise<void>;
}

export async function useBrowserAuthState(transport: AuthStateTransport) {
  const readData = async (file: string): Promise<unknown | null> => {
    try {
      const requestId = randomUUID();
      const data = await transport.get(requestId, file);
      return data ? JSON.parse(JSON.stringify(data), BufferJSON.reviver) : null;
    } catch {
      return null;
    }
  };

  const writeData = async (file: string, data: unknown): Promise<void> => {
    const requestId = randomUUID();
    const serialized = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
    await transport.set(requestId, file, serialized);
  };

  const creds =
    ((await readData('creds')) as ReturnType<typeof initAuthCreds> | null) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof import('@whiskeysockets/baileys').SignalDataTypeMap>(
          type: T,
          ids: string[],
        ) => {
          const data: Record<string, import('@whiskeysockets/baileys').SignalDataTypeMap[T]> = {};
          await Promise.all(
            ids.map(async (id) => {
              const value = await readData(`${type}-${id}`);
              if (value) {
                data[id] = value as import('@whiskeysockets/baileys').SignalDataTypeMap[T];
              }
            }),
          );
          return data;
        },
        set: async (data: Record<string, Record<string, unknown>>) => {
          const tasks: Promise<void>[] = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const file = `${category}-${id}`;
              tasks.push(value ? writeData(file, value) : writeData(file, null));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData('creds', creds),
  };
}

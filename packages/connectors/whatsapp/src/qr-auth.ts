import {
  makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  fetchLatestBaileysVersion,
  type proto,
} from '@whiskeysockets/baileys';
import * as QRCode from 'qrcode';
import pino from 'pino';
import { mkdirSync } from 'fs';
import type { AuthContext } from '@botmem/connector-sdk';

const logger = pino({ level: 'warn' }) as any;

/** Message store for decrypt retry — shared with sync.ts via module scope */
const authMessageStore = new Map<string, proto.IMessage>();
const AUTH_MSG_STORE_MAX = 5_000;

function storeAuthMessage(
  key: proto.IMessageKey | undefined | null,
  message: proto.IMessage | undefined | null,
) {
  if (!key?.id || !message) return;
  const storeKey = `${key.remoteJid}:${key.id}`;
  authMessageStore.set(storeKey, message);
  if (authMessageStore.size > AUTH_MSG_STORE_MAX) {
    const firstKey = authMessageStore.keys().next().value;
    if (firstKey) authMessageStore.delete(firstKey);
  }
}

async function getAuthMessage(key: proto.IMessageKey): Promise<proto.IMessage | undefined> {
  return authMessageStore.get(`${key.remoteJid}:${key.id}`);
}

function makeCacheStore(): {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  del(key: string): void;
  flushAll(): void;
} {
  const store = new Map<string, any>();
  return {
    get: <T>(key: string) => store.get(key) as T | undefined,
    set: <T>(key: string, value: T) => {
      store.set(key, value);
    },
    del: (key: string) => {
      store.delete(key);
    },
    flushAll: () => {
      store.clear();
    },
  };
}

let cachedVersion: { version: [number, number, number]; fetchedAt: number } | null = null;
const VERSION_TTL = 60 * 60 * 1000;

async function getWhatsAppVersion(): Promise<[number, number, number]> {
  if (cachedVersion && Date.now() - cachedVersion.fetchedAt < VERSION_TTL) {
    return cachedVersion.version;
  }
  try {
    const { version } = await fetchLatestBaileysVersion();
    cachedVersion = { version: version as [number, number, number], fetchedAt: Date.now() };
    return cachedVersion.version;
  } catch {
    return cachedVersion?.version ?? [2, 3000, 1033846690];
  }
}

export interface QrAuthCallbacks {
  onQrCode: (qrDataUrl: string) => void;
  onConnected: (auth: AuthContext, sock: ReturnType<typeof makeWASocket>) => void;
  onError: (error: Error) => void;
}

const FATAL_CODES = new Set([
  DisconnectReason.loggedOut,
  DisconnectReason.badSession,
  DisconnectReason.multideviceMismatch,
]);

const RECONNECT_CODES = new Set([
  DisconnectReason.restartRequired,
  DisconnectReason.connectionClosed,
  DisconnectReason.connectionReplaced,
  DisconnectReason.timedOut,
]);

export async function startQrAuth(
  sessionDir: string,
  callbacks: QrAuthCallbacks,
  maxRetries = 10,
): Promise<void> {
  let retries = 0;
  let qrShown = false;
  let connected = false;

  const attempt = async () => {
    if (connected) return;

    mkdirSync(sessionDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const version = await getWhatsAppVersion();

    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      version,
      browser: ['Mac OS', 'Chrome', '10.15.7'],
      printQRInTerminal: false,
      logger,
      syncFullHistory: true,
      markOnlineOnConnect: false,
      getMessage: getAuthMessage,
      msgRetryCounterCache: makeCacheStore(),
    });

    if (sock.ws && typeof (sock.ws as any).on === 'function') {
      (sock.ws as any).on('error', (err: Error) => {
        console.error('[WhatsApp] WebSocket error:', err.message);
      });
    }

    sock.ev.on('creds.update', saveCreds);

    // Store incoming messages for decrypt retry
    sock.ev.on('messaging-history.set' as any, (data: any) => {
      for (const msg of data.messages || []) {
        storeAuthMessage(msg.key, msg.message);
      }
    });
    sock.ev.on('messages.upsert', (upsert: any) => {
      for (const msg of upsert.messages || []) {
        storeAuthMessage(msg.key, msg.message);
      }
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !connected) {
        qrShown = true;
        const qrDataUrl = await QRCode.toDataURL(qr);
        callbacks.onQrCode(qrDataUrl);
      }

      if (connection === 'open' && !connected) {
        connected = true;
        // Pass the socket to the caller so it can capture history sync events
        callbacks.onConnected({ raw: { sessionDir, jid: sock.user?.id } }, sock);
      }

      if (connection === 'close') {
        if (connected) return;

        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;

        if (FATAL_CODES.has(statusCode)) {
          callbacks.onError(new Error(`WhatsApp authentication failed (${statusCode})`));
          return;
        }

        if (RECONNECT_CODES.has(statusCode) && retries < maxRetries) {
          retries++;
          const delay = Math.min(500 * Math.pow(2, retries - 1), 10_000);
          setTimeout(attempt, delay);
          return;
        }

        if (qrShown) {
          callbacks.onError(new Error('WhatsApp connection closed'));
          return;
        }

        if (retries < maxRetries) {
          retries++;
          const delay = Math.min(500 * Math.pow(2, retries - 1), 10_000);
          setTimeout(attempt, delay);
        } else {
          callbacks.onError(new Error('Failed to connect to WhatsApp after retries'));
        }
      }
    });
  };

  await attempt();
}

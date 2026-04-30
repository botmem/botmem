import {
  makeWASocket,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  proto,
} from '@whiskeysockets/baileys';
import type { WAMessage } from '@whiskeysockets/baileys';

import type { Boom } from '@hapi/boom';
import * as QRCode from 'qrcode';
import pino from 'pino';
import { mkdirSync } from 'fs';
import { promisify } from 'util';
import { inflate } from 'zlib';
import type { AuthContext } from '@botmem/connector-sdk';
import { useAtomicMultiFileAuthState } from './atomic-auth-state.js';

const inflatePromise = promisify(inflate);

const logger = pino({ level: 'silent' }) as pino.Logger;

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
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string) => store.get(key) as T | undefined,
    set: <T>(key: string, value: T) => {
      store.set(key, value as unknown);
    },
    del: (key: string) => {
      store.delete(key);
    },
    flushAll: () => {
      store.clear();
    },
  };
}

/**
 * Process INITIAL_BOOTSTRAP inline payload that Baileys can't handle.
 * WhatsApp sends history data inline (no download URL), but Baileys only
 * knows how to download from URLs → fails silently → 0 messages.
 * We intercept via shouldSyncHistoryMessage and emit the data ourselves.
 */
async function processInlineHistoryPayload(
  notification: proto.Message.IHistorySyncNotification,
  ev: ReturnType<typeof makeWASocket>['ev'],
) {
  if (!notification.initialHistBootstrapInlinePayload?.length) return;
  try {
    let buffer = Buffer.from(notification.initialHistBootstrapInlinePayload);
    buffer = await inflatePromise(buffer);
    const syncData = proto.HistorySync.decode(buffer);

    const messages: WAMessage[] = [];
    const contacts: Array<{ id: string; name?: string; lid?: string }> = [];
    const chats: Array<{ id: string; name?: string | null }> = [];

    for (const chat of syncData.conversations || []) {
      if (!chat.id) continue;
      contacts.push({ id: chat.id, name: chat.name || undefined, lid: chat.lidJid || undefined });
      for (const item of chat.messages || []) {
        if (item.message?.key) messages.push(item.message as WAMessage);
      }
      chats.push({ id: chat.id, name: chat.name });
    }

    ev.emit('messaging-history.set', {
      chats,
      contacts,
      messages,
      syncType: syncData.syncType,
      progress: syncData.progress,
    });
  } catch (err) {
    console.error('[WhatsApp] Failed to process inline history payload:', err);
  }
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

const DEBUG_WHATSAPP_AUTH = process.env.WHATSAPP_DEBUG_AUTH === '1';

function debugAuth(message: string) {
  if (DEBUG_WHATSAPP_AUTH) console.info(message);
}

function disconnectStatusCode(lastDisconnect: unknown): number {
  const err = (lastDisconnect as { error?: Boom | Error } | undefined)?.error;
  return err && 'output' in err ? (err as Boom).output.statusCode : 0;
}

export interface QrAuthOptions {
  maxRetries?: number;
  /** Custom WebSocket URL for Baileys to connect to (e.g. tunnel relay) instead of WhatsApp directly */
  waWebSocketUrl?: string;
}

export async function startQrAuth(
  sessionDir: string,
  callbacks: QrAuthCallbacks,
  maxRetriesOrOptions: number | QrAuthOptions = 10,
): Promise<void> {
  const opts =
    typeof maxRetriesOrOptions === 'number'
      ? { maxRetries: maxRetriesOrOptions }
      : maxRetriesOrOptions;
  const maxRetries = opts.maxRetries ?? 10;
  let retries = 0;
  let qrShown = false;
  let connected = false;
  // Stability timer: after connection opens, wait before declaring success.
  // If a 515 restart arrives first, cancel the timer and let the reconnect happen.
  // Only fire onConnected with the socket that survives the stability window.
  let stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  const STABILITY_MS = 3000;

  const attempt = async () => {
    if (connected) return;

    mkdirSync(sessionDir, { recursive: true });
    const { state, saveCreds } = await useAtomicMultiFileAuthState(sessionDir);
    const version = await getWhatsAppVersion();
    debugAuth(
      `[WhatsApp QR] attempt=${retries + 1}/${maxRetries + 1} session=${sessionDir} version=${version.join('.')} hasMe=${state.creds.me?.id ? 'yes' : 'no'} processedHistory=${state.creds.processedHistoryMessages?.length || 0}`,
    );

    const socketConfig: Parameters<typeof makeWASocket>[0] = {
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      version,
      browser: Browsers.macOS('Desktop'),
      printQRInTerminal: false,
      logger,
      syncFullHistory: true,
      markOnlineOnConnect: false,
      getMessage: getAuthMessage,
      msgRetryCounterCache: makeCacheStore(),
    };
    if (opts.waWebSocketUrl) {
      (socketConfig as Record<string, unknown>).waWebSocketUrl = opts.waWebSocketUrl;
    }
    // Will be set after sock is created (needs sock.ev reference)
    let sockRef: ReturnType<typeof makeWASocket> | null = null;
    let inlineProcessed = false;
    (socketConfig as Record<string, unknown>).shouldSyncHistoryMessage = (
      msg: proto.Message.IHistorySyncNotification,
    ) => {
      debugAuth(
        `[WhatsApp QR] shouldSyncHistoryMessage type=${msg.syncType ?? '-'} progress=${msg.progress ?? '-'} inlineBytes=${msg.initialHistBootstrapInlinePayload?.length || 0}`,
      );
      if (!inlineProcessed && msg.initialHistBootstrapInlinePayload?.length && sockRef) {
        inlineProcessed = true;
        debugAuth('[WhatsApp QR] processing inline history payload');
        processInlineHistoryPayload(msg, sockRef.ev);
      }
      return true;
    };
    const sock = makeWASocket(socketConfig);
    sockRef = sock;

    if (sock.ws && typeof sock.ws.on === 'function') {
      sock.ws.on('error', (err: Error) => {
        console.debug('[WhatsApp] WebSocket error:', err.message);
      });
    }

    sock.ev.on('creds.update', () => void saveCreds());

    // Use sock.ev.process() for history-related handlers — Baileys buffers events
    // during history sync and flushes them as a consolidated map. Individual .on()
    // listeners may miss buffered history payloads.
    sock.ev.process(async (events) => {
      const keys = Object.keys(events);
      debugAuth(`[WhatsApp QR] ev.process events=${keys.join(',') || 'none'}`);
      if (events['messaging-history.set']) {
        const data = events['messaging-history.set'];
        debugAuth(
          `[WhatsApp QR] messaging-history.set msgs=${data.messages?.length || 0} chats=${data.chats?.length || 0} contacts=${data.contacts?.length || 0} syncType=${data.syncType ?? '-'} progress=${data.progress ?? '-'}`,
        );
        for (const msg of data.messages || []) {
          storeAuthMessage(msg.key, msg.message);
        }
      }
      if (events['messages.upsert']) {
        const upsert = events['messages.upsert'];
        debugAuth(
          `[WhatsApp QR] messages.upsert msgs=${upsert.messages?.length || 0} type=${upsert.type}`,
        );
        for (const msg of upsert.messages || []) {
          storeAuthMessage(msg.key, msg.message);
        }
      }
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      const statusCode = disconnectStatusCode(lastDisconnect);
      debugAuth(
        `[WhatsApp QR] connection.update connection=${connection || '-'} qr=${qr ? 'yes' : 'no'} isNewLogin=${update.isNewLogin ? 'yes' : 'no'} receivedPending=${update.receivedPendingNotifications ? 'yes' : 'no'} code=${statusCode || '-'}`,
      );

      if (qr && !connected) {
        qrShown = true;
        debugAuth('[WhatsApp QR] QR generated');
        const qrDataUrl = await QRCode.toDataURL(qr);
        callbacks.onQrCode(qrDataUrl);
      }

      if (connection === 'open' && !connected) {
        // Don't fire onConnected yet — wait for the socket to survive the
        // stability window. A 515 restart typically arrives within 1-2s of
        // the first connection:open after QR scan, killing this socket.
        // If 515 arrives, we cancel this timer and let the reconnect create
        // a new (stable) socket that actually receives history.
        if (stabilityTimer) clearTimeout(stabilityTimer);
        debugAuth(`[WhatsApp QR] connection open; waiting ${STABILITY_MS}ms stability window`);
        stabilityTimer = setTimeout(() => {
          if (connected) return;
          connected = true;
          stabilityTimer = null;
          debugAuth(
            `[WhatsApp QR] stable open; buffering auth socket and handing to first sync user=${sock.user?.id || '-'}`,
          );
          sock.ev.buffer();
          callbacks.onConnected({ raw: { sessionDir, jid: sock.user?.id } }, sock);
        }, STABILITY_MS);
      }

      if (connection === 'close') {
        // Cancel pending stability timer — this socket is dying
        if (stabilityTimer) {
          clearTimeout(stabilityTimer);
          stabilityTimer = null;
        }

        if (connected) return;

        if (FATAL_CODES.has(statusCode)) {
          debugAuth(`[WhatsApp QR] fatal close code=${statusCode}`);
          callbacks.onError(new Error(`WhatsApp authentication failed (${statusCode})`));
          return;
        }

        if (RECONNECT_CODES.has(statusCode) && retries < maxRetries) {
          retries++;
          const delay = Math.min(500 * Math.pow(2, retries - 1), 10_000);
          debugAuth(`[WhatsApp QR] reconnecting after close code=${statusCode} delay=${delay}ms`);
          setTimeout(attempt, delay);
          return;
        }

        if (qrShown) {
          debugAuth(`[WhatsApp QR] closed after QR without reconnect code=${statusCode}`);
          callbacks.onError(new Error('WhatsApp connection closed'));
          return;
        }

        if (retries < maxRetries) {
          retries++;
          const delay = Math.min(500 * Math.pow(2, retries - 1), 10_000);
          debugAuth(`[WhatsApp QR] retrying before QR code=${statusCode} delay=${delay}ms`);
          setTimeout(attempt, delay);
        } else {
          debugAuth(`[WhatsApp QR] failed after retries code=${statusCode}`);
          callbacks.onError(new Error('Failed to connect to WhatsApp after retries'));
        }
      }
    });
  };

  await attempt();
}

import { makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import type { SyncContext, ConnectorDataEvent } from '@botmem/connector-sdk';

const logger = pino({ level: 'warn' }) as any;

// Cache the fetched version for 1 hour
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

function extractText(msg: any): string {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    ''
  );
}

// How long to keep the socket open collecting messages after connection
const SYNC_WINDOW_MS = 60_000;
// After this many seconds of no new messages, close early
const IDLE_TIMEOUT_MS = 15_000;

export async function syncWhatsApp(
  ctx: SyncContext,
  emit: (event: ConnectorDataEvent) => void,
): Promise<{ cursor: string | null; hasMore: boolean; processed: number }> {
  const sessionDir = ctx.auth.raw?.sessionDir as string;
  if (!sessionDir) throw new Error('No WhatsApp session found');

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const version = await getWhatsAppVersion();
  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    version,
    printQRInTerminal: false,
    logger,
    // Request history sync on first connection
    syncFullHistory: true,
    markOnlineOnConnect: false,
  });

  // Prevent unhandled WebSocket errors from crashing
  if (sock.ws && typeof (sock.ws as any).on === 'function') {
    (sock.ws as any).on('error', (err: Error) => {
      ctx.logger.warn(`WebSocket error: ${err.message}`);
    });
  }

  sock.ev.on('creds.update', saveCreds);

  let processed = 0;

  // Wait for connection to open
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('WhatsApp connection timeout'));
    }, 30_000);

    sock.ev.on('connection.update', (update: any) => {
      if (update.connection === 'open') {
        clearTimeout(timeout);
        resolve();
      }
      if (update.connection === 'close') {
        clearTimeout(timeout);
        reject(new Error('WhatsApp connection closed during sync'));
      }
    });
  });

  ctx.logger.info('WhatsApp connected, listening for messages...');

  // Collect messages from real-time events
  await new Promise<void>((resolve) => {
    let idleTimer: ReturnType<typeof setTimeout>;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        ctx.logger.info('No new messages for 15s, closing sync window');
        resolve();
      }, IDLE_TIMEOUT_MS);
    };

    // Hard deadline for the sync window
    const deadline = setTimeout(() => {
      clearTimeout(idleTimer);
      ctx.logger.info('Sync window expired (60s)');
      resolve();
    }, SYNC_WINDOW_MS);

    // Abort signal from job cancellation
    if (ctx.signal.aborted) {
      clearTimeout(deadline);
      resolve();
      return;
    }
    ctx.signal.addEventListener('abort', () => {
      clearTimeout(deadline);
      clearTimeout(idleTimer);
      resolve();
    }, { once: true });

    // Listen for incoming messages (both real-time and history sync)
    sock.ev.on('messages.upsert', (upsert: any) => {
      const messages = upsert.messages || [];
      for (const msg of messages) {
        if (!msg.message || msg.key?.fromMe === undefined) continue;

        const text = extractText(msg);
        if (!text) continue;

        const remoteJid = msg.key?.remoteJid || '';
        const participant = msg.key?.participant || '';
        const sender = msg.key?.fromMe
          ? (sock as any).user?.id?.split(':')[0] || 'me'
          : (participant || remoteJid).split('@')[0];

        emit({
          sourceType: 'message',
          sourceId: msg.key?.id || `wa:${Date.now()}:${processed}`,
          timestamp: msg.messageTimestamp
            ? new Date(Number(msg.messageTimestamp) * 1000).toISOString()
            : new Date().toISOString(),
          content: {
            text,
            participants: [sender].filter(Boolean),
            metadata: {
              chatId: remoteJid,
              pushName: msg.pushName || '',
              fromMe: msg.key?.fromMe,
              isGroup: remoteJid.endsWith('@g.us'),
              type: upsert.type, // 'notify' (real-time) or 'append' (history)
            },
          },
        });
        processed++;
      }
      resetIdle();
    });

    // Start idle timer
    resetIdle();
  });

  // Clean up
  try {
    sock.ws?.close();
  } catch { /* ignore */ }

  ctx.logger.info(`Synced ${processed} WhatsApp messages`);
  return { cursor: null, hasMore: false, processed };
}

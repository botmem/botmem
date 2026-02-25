import { makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import type { SyncContext, ConnectorDataEvent } from '@botmem/connector-sdk';

const logger = pino({ level: 'warn' }) as any;

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

// Hard deadline for history sync
const MAX_SYNC_MS = 5 * 60_000;
// Close early if no new batches arrive
const IDLE_TIMEOUT_MS = 30_000;

type WaSock = ReturnType<typeof makeWASocket>;

/**
 * Create a fresh Baileys socket for subsequent syncs (not the first one).
 */
async function createSyncSocket(sessionDir: string): Promise<WaSock> {
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
    syncFullHistory: true,
    markOnlineOnConnect: false,
  });

  if (sock.ws && typeof (sock.ws as any).on === 'function') {
    (sock.ws as any).on('error', () => {});
  }

  sock.ev.on('creds.update', saveCreds);
  return sock;
}

export async function syncWhatsApp(
  ctx: SyncContext,
  emit: (event: ConnectorDataEvent) => void,
  existingSock?: WaSock,
): Promise<{ cursor: string | null; hasMore: boolean; processed: number }> {
  const sessionDir = ctx.auth.raw?.sessionDir as string;
  if (!sessionDir) throw new Error('No WhatsApp session found');

  let sock: WaSock;
  let ownsSocket: boolean;

  if (existingSock) {
    // Reuse the socket from QR auth — it's already connected and receiving history
    sock = existingSock;
    ownsSocket = true;
    ctx.logger.info('Reusing auth socket for first sync (history capture)');
  } else {
    // Create a fresh socket for subsequent syncs
    sock = await createSyncSocket(sessionDir);
    ownsSocket = true;

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WhatsApp connection timeout')), 30_000);
      sock.ev.on('connection.update', (update: any) => {
        if (update.connection === 'open') { clearTimeout(timeout); resolve(); }
        if (update.connection === 'close') { clearTimeout(timeout); reject(new Error('WhatsApp connection closed during sync')); }
      });
    });
  }

  ctx.logger.info('WhatsApp connected, waiting for history sync...');

  let processed = 0;
  let historyBatches = 0;

  await new Promise<void>((resolve) => {
    let idleTimer: ReturnType<typeof setTimeout>;
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(idleTimer);
      clearTimeout(deadline);
      resolve();
    };

    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        ctx.logger.info(`No new data for ${IDLE_TIMEOUT_MS / 1000}s, finishing`);
        finish();
      }, IDLE_TIMEOUT_MS);
    };

    const deadline = setTimeout(() => {
      ctx.logger.info(`Sync hard deadline reached (${MAX_SYNC_MS / 1000}s)`);
      finish();
    }, MAX_SYNC_MS);

    if (ctx.signal.aborted) { finish(); return; }
    ctx.signal.addEventListener('abort', finish, { once: true });

    const processMessage = (msg: any, source: string) => {
      if (!msg.message) return;
      const text = extractText(msg);
      if (!text) return;

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
            source,
          },
        },
      });
      processed++;
    };

    // History sync — bulk messages delivered by WhatsApp servers after linking
    sock.ev.on('messaging-history.set', (data: any) => {
      historyBatches++;
      const messages = data.messages || [];
      const progress = data.progress ?? null;
      const isLatest = data.isLatest ?? false;

      ctx.logger.info(`History batch #${historyBatches}: ${messages.length} messages (progress: ${progress}, isLatest: ${isLatest})`);

      for (const msg of messages) {
        processMessage(msg, 'history');
      }

      if (isLatest) {
        ctx.logger.info('Final history batch received');
        setTimeout(finish, 5_000);
        return;
      }

      resetIdle();
    });

    // Real-time messages
    sock.ev.on('messages.upsert', (upsert: any) => {
      for (const msg of upsert.messages || []) {
        processMessage(msg, upsert.type === 'notify' ? 'realtime' : 'append');
      }
      resetIdle();
    });

    resetIdle();
  });

  if (ownsSocket) {
    try { sock.ws?.close(); } catch { /* ignore */ }
  }

  ctx.logger.info(`Synced ${processed} WhatsApp messages from ${historyBatches} history batches`);
  return { cursor: null, hasMore: false, processed };
}

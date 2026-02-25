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

export async function syncWhatsApp(
  ctx: SyncContext,
  emit: (event: ConnectorDataEvent) => void,
): Promise<{ cursor: string | null; hasMore: boolean; processed: number }> {
  const sessionDir = ctx.auth.raw?.sessionDir as string;
  if (!sessionDir) throw new Error('No WhatsApp session found');

  const { state } = await useMultiFileAuthState(sessionDir);
  const version = await getWhatsAppVersion();
  const sock: any = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    version,
    printQRInTerminal: false,
    logger,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  let processed = 0;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      sock.end(undefined);
      resolve();
    }, 30_000);

    sock.ev.on('connection.update', (update: any) => {
      if (update.connection === 'open') {
        ctx.logger.info('WhatsApp connected, reading message store');
        clearTimeout(timeout);
        resolve();
      }
      if (update.connection === 'close') {
        clearTimeout(timeout);
        reject(new Error('WhatsApp connection closed'));
      }
    });
  });

  // Baileys stores messages in memory; fetch recent chats
  const chats: any = await sock.groupFetchAllParticipating();
  const chatIds = Object.keys(chats).slice(0, 20);

  for (const chatId of chatIds) {
    if (ctx.signal.aborted) break;

    try {
      const messages: any[] = await sock.fetchMessageHistory(50, { remoteJid: chatId }, undefined);

      for (const msg of messages || []) {
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        if (!text) continue;

        emit({
          sourceType: 'message',
          sourceId: msg.key?.id || `${chatId}:${msg.messageTimestamp}`,
          timestamp: new Date(Number(msg.messageTimestamp) * 1000).toISOString(),
          content: {
            text,
            participants: [msg.key?.participant || msg.key?.remoteJid || ''].filter(Boolean),
            metadata: { chatId, pushName: msg.pushName },
          },
        });
        processed++;
      }
    } catch {
      ctx.logger.warn(`Could not fetch history for ${chatId}`);
    }
  }

  sock.end(undefined);
  ctx.logger.info(`Synced ${processed} WhatsApp messages`);

  return { cursor: null, hasMore: false, processed };
}

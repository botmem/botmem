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

/** Extract phone number from a WhatsApp JID, stripping @suffix and :device */
function phoneFromJid(jid: string): string {
  return jid.split('@')[0]?.split(':')[0] || '';
}

const MAX_SYNC_MS = 5 * 60_000;
const IDLE_TIMEOUT_MS = 30_000;

type WaSock = ReturnType<typeof makeWASocket>;

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

  if (existingSock) {
    sock = existingSock;
    ctx.logger.info('Reusing auth socket for first sync (history capture)');
  } else {
    sock = await createSyncSocket(sessionDir);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WhatsApp connection timeout')), 30_000);
      sock.ev.on('connection.update', (update: any) => {
        if (update.connection === 'open') { clearTimeout(timeout); resolve(); }
        if (update.connection === 'close') { clearTimeout(timeout); reject(new Error('WhatsApp connection closed during sync')); }
      });
    });
  }

  // The user's own phone number and JID
  const selfJid = (sock as any).user?.id || '';
  const selfPhone = phoneFromJid(selfJid);
  ctx.logger.info(`WhatsApp connected as ${selfPhone}, waiting for history sync...`);

  let processed = 0;
  let historyBatches = 0;

  // Build a lookup of chat names and contact names from history sync data
  const chatNames = new Map<string, string>();  // chatJid → name
  const contactNames = new Map<string, string>(); // phoneNumber → name

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
      const isGroup = remoteJid.endsWith('@g.us');
      const fromMe = msg.key?.fromMe ?? false;

      // Determine sender phone and name
      let senderPhone: string;
      let senderName: string;
      if (fromMe) {
        senderPhone = selfPhone;
        senderName = 'me';
      } else if (isGroup) {
        senderPhone = phoneFromJid(participant);
        senderName = msg.pushName || contactNames.get(senderPhone) || senderPhone;
      } else {
        senderPhone = phoneFromJid(remoteJid);
        senderName = msg.pushName || contactNames.get(senderPhone) || senderPhone;
      }

      // Track contact names for future lookups
      if (msg.pushName && senderPhone) {
        contactNames.set(senderPhone, msg.pushName);
      }

      // Build chat context
      const chatName = chatNames.get(remoteJid) || (isGroup ? remoteJid : senderName);

      // Build all participants for this message (sender + chat context)
      const participants: string[] = [senderPhone];

      emit({
        sourceType: 'message',
        sourceId: msg.key?.id || `wa:${Date.now()}:${processed}`,
        timestamp: msg.messageTimestamp
          ? new Date(Number(msg.messageTimestamp) * 1000).toISOString()
          : new Date().toISOString(),
        content: {
          text,
          participants,
          metadata: {
            chatId: remoteJid,
            chatName,
            senderPhone,
            senderName,
            pushName: msg.pushName || '',
            fromMe,
            isGroup,
            source,
            selfPhone,
          },
        },
      });
      processed++;
    };

    // History sync — bulk data from WhatsApp servers
    sock.ev.on('messaging-history.set', (data: any) => {
      historyBatches++;
      const messages = data.messages || [];
      const chats = data.chats || [];
      const contacts = data.contacts || [];
      const progress = data.progress ?? null;
      const isLatest = data.isLatest ?? false;

      // Index chat names (group names, contact names)
      for (const chat of chats) {
        if (chat.id && chat.name) {
          chatNames.set(chat.id, chat.name);
        }
      }

      // Index contact names from the contacts array
      for (const contact of contacts) {
        const phone = phoneFromJid(contact.id || '');
        const name = contact.notify || contact.name || '';
        if (phone && name) {
          contactNames.set(phone, name);
        }
      }

      ctx.logger.info(`History batch #${historyBatches}: ${messages.length} msgs, ${chats.length} chats, ${contacts.length} contacts (progress: ${progress}, isLatest: ${isLatest})`);

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

  try { sock.ws?.close(); } catch { /* ignore */ }

  ctx.logger.info(`Synced ${processed} WhatsApp messages from ${historyBatches} history batches (${chatNames.size} chats, ${contactNames.size} contacts indexed)`);
  return { cursor: null, hasMore: false, processed };
}

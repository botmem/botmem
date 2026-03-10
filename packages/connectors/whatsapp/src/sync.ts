import {
  makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  downloadContentFromMessage,
  DisconnectReason,
  type proto,
} from '@whiskeysockets/baileys';
import type { Transform } from 'stream';
import pino from 'pino';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { SyncContext, ConnectorDataEvent } from '@botmem/connector-sdk';

/**
 * Simple in-memory message store for Baileys getMessage callback.
 * When Baileys fails to decrypt a message, it retries using this store
 * to provide the original message content for re-encryption.
 */
const messageStore = new Map<string, proto.IMessage>();
const MESSAGE_STORE_MAX = 10_000;

function storeMessage(
  key: proto.IMessageKey | undefined | null,
  message: proto.IMessage | undefined | null,
) {
  if (!key?.id || !message) return;
  const storeKey = `${key.remoteJid}:${key.id}`;
  messageStore.set(storeKey, message);
  // Evict oldest entries if store gets too large
  if (messageStore.size > MESSAGE_STORE_MAX) {
    const firstKey = messageStore.keys().next().value;
    if (firstKey) messageStore.delete(firstKey);
  }
}

async function getMessage(key: proto.IMessageKey): Promise<proto.IMessage | undefined> {
  const storeKey = `${key.remoteJid}:${key.id}`;
  return messageStore.get(storeKey);
}

/** Simple CacheStore implementation for msgRetryCounterCache */
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

/** Track decrypt failures to surface re-auth warnings */
let decryptFailCount = 0;
let decryptFailResetTimer: ReturnType<typeof setTimeout> | null = null;
const DECRYPT_FAIL_THRESHOLD = 5;
const DECRYPT_FAIL_WINDOW = 60_000;

let onDecryptFailure: ((count: number) => void) | null = null;

export function setDecryptFailureCallback(cb: (count: number) => void) {
  onDecryptFailure = cb;
}

// Suppress Baileys protocol noise — logMethod hook intercepts all calls for
// decrypt-fail counting but never writes output (level: silent + no method.apply).
const logger = pino({
  level: 'silent',
  hooks: {
    logMethod(inputArgs: any[], _method: any) {
      const msg = typeof inputArgs[0] === 'string' ? inputArgs[0] : inputArgs[1];
      if (typeof msg === 'string' && msg.includes('failed to decrypt')) {
        decryptFailCount++;
        if (!decryptFailResetTimer) {
          decryptFailResetTimer = setTimeout(() => {
            decryptFailCount = 0;
            decryptFailResetTimer = null;
          }, DECRYPT_FAIL_WINDOW);
        }
        if (decryptFailCount === DECRYPT_FAIL_THRESHOLD && onDecryptFailure) {
          onDecryptFailure(decryptFailCount);
        }
      }
      // Intentionally not calling _method.apply() — suppresses all Baileys output.
      // In pino, logMethod hooks bypass the level gate, so method.apply() writes
      // even at 'silent' level.
    },
  },
}) as any;

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
    msg.message?.documentMessage?.caption ||
    msg.message?.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    ''
  );
}

/** Detect the message type for rich metadata */
function detectMessageType(msg: any): { type: string; mimeType?: string; fileName?: string } {
  const m = msg.message;
  if (!m) return { type: 'unknown' };

  if (m.imageMessage) return { type: 'image', mimeType: m.imageMessage.mimetype };
  if (m.videoMessage) return { type: 'video', mimeType: m.videoMessage.mimetype };
  if (m.audioMessage) return { type: 'audio', mimeType: m.audioMessage.mimetype };
  if (m.stickerMessage) return { type: 'sticker', mimeType: m.stickerMessage.mimetype };
  if (m.documentMessage)
    return {
      type: 'document',
      mimeType: m.documentMessage.mimetype,
      fileName: m.documentMessage.fileName,
    };
  if (m.documentWithCaptionMessage?.message?.documentMessage) {
    const doc = m.documentWithCaptionMessage.message.documentMessage;
    return { type: 'document', mimeType: doc.mimetype, fileName: doc.fileName };
  }
  if (m.contactMessage || m.contactsArrayMessage) return { type: 'contact_card' };
  if (m.locationMessage || m.liveLocationMessage) return { type: 'location' };
  if (m.conversation || m.extendedTextMessage) return { type: 'text' };
  if (m.protocolMessage) return { type: 'protocol' };
  if (m.reactionMessage) return { type: 'reaction' };
  return { type: 'unknown' };
}

/** Extract shared contact vCards from a message */
function extractContactCards(msg: any): Array<{ displayName: string; vcard: string }> {
  const m = msg.message;
  if (!m) return [];

  if (m.contactMessage) {
    return [
      {
        displayName: m.contactMessage.displayName || '',
        vcard: m.contactMessage.vcard || '',
      },
    ];
  }
  if (m.contactsArrayMessage?.contacts) {
    return m.contactsArrayMessage.contacts.map((c: any) => ({
      displayName: c.displayName || '',
      vcard: c.vcard || '',
    }));
  }
  return [];
}

/** Extract location data from a message */
function extractLocation(
  msg: any,
): { lat: number; lng: number; name?: string; address?: string } | null {
  const loc = msg.message?.locationMessage || msg.message?.liveLocationMessage;
  if (!loc) return null;
  return {
    lat: loc.degreesLatitude,
    lng: loc.degreesLongitude,
    name: loc.name,
    address: loc.address,
  };
}

/** Extract phone number from a JID, stripping @suffix and :device */
function phoneFromJid(jid: string): string {
  if (!jid) return '';
  return jid.split('@')[0]?.split(':')[0] || '';
}

/** Check if a JID is a LID (Linked ID) rather than a phone-based JID */
function isLid(jid: string): boolean {
  return jid.endsWith('@lid');
}

/** Parse phone numbers from a vCard string */
function phonesFromVcard(vcard: string): string[] {
  const phones: string[] = [];
  const lines = vcard.split('\n');
  for (const line of lines) {
    if (line.startsWith('TEL') || line.startsWith('tel')) {
      // TEL;type=CELL:+971501234567
      const value = line.split(':').slice(1).join(':').trim();
      if (value) phones.push(value.replace(/[^+\d]/g, ''));
    }
  }
  return phones;
}

/** Parse name from a vCard string */
function nameFromVcard(vcard: string): string {
  const lines = vcard.split('\n');
  for (const line of lines) {
    if (line.startsWith('FN:') || line.startsWith('fn:')) {
      return line.slice(3).trim();
    }
  }
  return '';
}

/** Download image or document media and return base64-encoded content */
async function downloadMedia(
  msg: any,
): Promise<{ base64: string; mimetype: string; fileName?: string } | null> {
  const m = msg.message;
  if (!m) return null;

  let mediaMsg: any = null;
  let mediaType: string = '';
  let mime = '';
  let fileName = '';

  if (m.imageMessage) {
    mediaMsg = m.imageMessage;
    mediaType = 'image';
    mime = m.imageMessage.mimetype || 'image/jpeg';
  } else if (m.documentMessage) {
    mediaMsg = m.documentMessage;
    mediaType = 'document';
    mime = m.documentMessage.mimetype || 'application/octet-stream';
    fileName = m.documentMessage.fileName || '';
  } else if (m.documentWithCaptionMessage?.message?.documentMessage) {
    mediaMsg = m.documentWithCaptionMessage.message.documentMessage;
    mediaType = 'document';
    mime = mediaMsg.mimetype || 'application/octet-stream';
    fileName = mediaMsg.fileName || '';
  }

  if (!mediaMsg || !mediaMsg.mediaKey || !mediaMsg.directPath) return null;

  try {
    // Small jitter before media download to avoid burst requests
    await jitter(200, 800);
    const stream: Transform = await downloadContentFromMessage(mediaMsg, mediaType as any);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);
    return { base64: buffer.toString('base64'), mimetype: mime, fileName: fileName || undefined };
  } catch {
    return null; // Media expired or unavailable — non-fatal
  }
}

/** Persist identity maps to the session directory so re-syncs can reuse them */
function saveIdentityMaps(
  sessionDir: string,
  maps: {
    lidToPhone: Map<string, string>;
    phoneToName: Map<string, string>;
    lidToName: Map<string, string>;
  },
) {
  try {
    const data = {
      lidToPhone: Object.fromEntries(maps.lidToPhone),
      phoneToName: Object.fromEntries(maps.phoneToName),
      lidToName: Object.fromEntries(maps.lidToName),
    };
    writeFileSync(join(sessionDir, 'identity-maps.json'), JSON.stringify(data));
  } catch {
    /* non-critical */
  }
}

/** Load previously saved identity maps */
function loadIdentityMaps(sessionDir: string): {
  lidToPhone: Map<string, string>;
  phoneToName: Map<string, string>;
  lidToName: Map<string, string>;
} | null {
  try {
    const path = join(sessionDir, 'identity-maps.json');
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    return {
      lidToPhone: new Map(Object.entries(data.lidToPhone || {})),
      phoneToName: new Map(Object.entries(data.phoneToName || {})),
      lidToName: new Map(Object.entries(data.lidToName || {})),
    };
  } catch {
    return null;
  }
}

/** Random jitter delay to mimic human browsing patterns */
function jitter(minMs: number, maxMs: number): Promise<void> {
  const delay = minMs + Math.random() * (maxMs - minMs);
  return new Promise((r) => setTimeout(r, delay));
}

// Emit data as it arrives — don't block waiting for more history
const MAX_SYNC_MS = 10 * 60_000; // 10 minutes hard deadline
const IDLE_TIMEOUT_FIRST_MS = 30_000; // 30 seconds — process what we have, don't wait forever
const IDLE_TIMEOUT_RESYNC_MS = 15_000; // 15 seconds for re-syncs

// On-demand per-chat history fetching
const ON_DEMAND_ROUNDS_PER_CHAT = 5; // max fetch rounds per chat
const ON_DEMAND_MSGS_PER_FETCH = 50; // messages per fetch request
const ON_DEMAND_WAIT_MS = 3000; // wait for messages to arrive after fetch

type WaSock = ReturnType<typeof makeWASocket>;

async function createSyncSocket(sessionDir: string): Promise<WaSock> {
  mkdirSync(sessionDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  // Clear processedHistoryMessages so WhatsApp re-delivers history on reconnect
  if (state.creds.processedHistoryMessages?.length) {
    state.creds.processedHistoryMessages = [];
  }

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
    getMessage,
    msgRetryCounterCache: makeCacheStore(),
  });

  if (sock.ws && typeof (sock.ws as any).on === 'function') {
    (sock.ws as any).on('error', () => {});
  }

  sock.ev.on('creds.update', saveCreds);
  return sock;
}

/**
 * Resolves a JID (which may be a LID or phone-based) to { phone, name }.
 */
function resolveIdentity(
  jid: string,
  lidToPhone: Map<string, string>,
  phoneToName: Map<string, string>,
  lidToName: Map<string, string>,
): { phone: string; name: string } {
  if (!jid) return { phone: '', name: '' };

  const lidKey = phoneFromJid(jid); // strip @lid or @s.whatsapp.net

  if (isLid(jid)) {
    // LID — try to map to phone number
    const phone = lidToPhone.get(lidKey) || '';
    const name = lidToName.get(lidKey) || (phone ? phoneToName.get(phone) || '' : '');
    return { phone, name };
  }

  // Phone-based JID
  const phone = lidKey;
  const name = phoneToName.get(phone) || '';
  return { phone, name };
}

/**
 * Extract mentioned JIDs from the message's context info.
 */
function extractMentions(msg: any): string[] {
  const ctx =
    msg.message?.extendedTextMessage?.contextInfo || msg.message?.conversation?.contextInfo;
  return ctx?.mentionedJid || [];
}

export async function syncWhatsApp(
  ctx: SyncContext,
  emit: (event: ConnectorDataEvent) => void,
  existingSock?: WaSock,
  onDisconnect?: (reason: string, code: number) => void,
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
        ctx.logger.info(`connection.update: ${JSON.stringify(update)}`);
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
  }

  const syncStartTime = Date.now();
  const selfJid = (sock as any).user?.id || '';
  const selfPhone = phoneFromJid(selfJid);
  const isFirstSync = !!existingSock;
  const IDLE_TIMEOUT_MS = isFirstSync ? IDLE_TIMEOUT_FIRST_MS : IDLE_TIMEOUT_RESYNC_MS;
  ctx.logger.info(
    `WhatsApp connected as ${selfPhone}, ${isFirstSync ? 'first sync — waiting for history' : 're-sync — short idle timeout'}...`,
  );

  let processed = 0;
  let historyBatches = 0;

  // Identity resolution maps — seed from previously saved data if available
  const saved = loadIdentityMaps(sessionDir);
  const lidToPhone = saved?.lidToPhone ?? new Map<string, string>();
  const phoneToName = saved?.phoneToName ?? new Map<string, string>();
  const lidToName = saved?.lidToName ?? new Map<string, string>();
  const chatNames = new Map<string, string>();
  const groupParticipants = new Map<string, Set<string>>();

  if (saved) {
    ctx.logger.info(
      `Loaded saved identity maps: ${lidToPhone.size} lid→phone, ${phoneToName.size} phone→name, ${lidToName.size} lid→name`,
    );
  }

  // Track history message count (no longer buffered — emitted immediately)
  let historyMsgCount = 0;

  // Listen for LID → phone mappings
  sock.ev.on('chats.phoneNumberShare' as any, (data: any) => {
    if (data.lid && data.jid) {
      lidToPhone.set(phoneFromJid(data.lid), phoneFromJid(data.jid));
    }
  });

  // Listen for contacts.upsert — Baileys delivers contact info here
  sock.ev.on('contacts.upsert' as any, (contacts: any[]) => {
    for (const c of contacts) {
      const id = c.id || '';
      const lid = c.lid || '';
      const name = c.notify || c.name || c.verifiedName || '';

      if (!isLid(id)) {
        const phone = phoneFromJid(id);
        if (phone && name) phoneToName.set(phone, name);
        if (phone && lid) {
          lidToPhone.set(phoneFromJid(lid), phone);
          if (name) lidToName.set(phoneFromJid(lid), name);
        }
      } else {
        const lidNum = phoneFromJid(id);
        if (name) lidToName.set(lidNum, name);
        if (lid && !isLid(lid)) {
          const phone = phoneFromJid(lid);
          if (phone) {
            lidToPhone.set(lidNum, phone);
            if (name) phoneToName.set(phone, name);
          }
        }
      }
    }
  });

  // Listen for contacts.update — carries push name changes
  sock.ev.on('contacts.update' as any, (updates: any[]) => {
    for (const u of updates) {
      const id = u.id || '';
      const name = u.notify || u.name || u.verifiedName || '';
      if (!name) continue;

      if (!isLid(id)) {
        const phone = phoneFromJid(id);
        if (phone) phoneToName.set(phone, name);
      } else {
        lidToName.set(phoneFromJid(id), name);
      }
    }
  });

  // Listen for group participant updates
  sock.ev.on('group-participants.update' as any, (data: any) => {
    const groupJid = data.id;
    if (!groupJid) return;
    if (!groupParticipants.has(groupJid)) {
      groupParticipants.set(groupJid, new Set());
    }
    const members = groupParticipants.get(groupJid)!;
    for (const p of data.participants || []) {
      if (data.action === 'remove') members.delete(p);
      else members.add(p);
    }
  });

  // Per-chat oldest message tracking for on-demand fetching
  const chatOldest = new Map<string, { key: any; ts: number }>();

  const processMessage = async (msg: any, source: string, skipMedia = false) => {
    if (!msg.message) return;

    const msgType = detectMessageType(msg);

    // Skip protocol messages (read receipts, etc.)
    if (msgType.type === 'protocol' || msgType.type === 'reaction') return;

    const text = extractText(msg);
    const contactCards = extractContactCards(msg);
    const location = extractLocation(msg);

    // Skip if there's no meaningful content at all
    if (!text && contactCards.length === 0 && !location && msgType.type === 'unknown') return;

    const remoteJid = msg.key?.remoteJid || '';

    // Skip WhatsApp Status/Story posts — ephemeral broadcasts, not conversations
    if (remoteJid === 'status@broadcast') return;

    // Baileys history uses top-level participant (LID format)
    const participantJid = msg.key?.participant || msg.participant || '';
    const isGroup = remoteJid.endsWith('@g.us');
    const fromMe = msg.key?.fromMe ?? false;

    // Track group participants
    if (isGroup && participantJid) {
      if (!groupParticipants.has(remoteJid)) {
        groupParticipants.set(remoteJid, new Set());
      }
      groupParticipants.get(remoteJid)!.add(participantJid);
    }

    // Resolve sender identity
    let senderPhone: string;
    let senderName: string;
    let senderLid: string = '';

    if (fromMe) {
      senderPhone = selfPhone;
      senderName = phoneToName.get(selfPhone) || 'Me';
    } else if (participantJid) {
      const identity = resolveIdentity(participantJid, lidToPhone, phoneToName, lidToName);
      senderPhone = identity.phone;
      senderName = identity.name || msg.pushName || msg.verifiedBizName || '';
      if (isLid(participantJid)) senderLid = phoneFromJid(participantJid);
    } else if (!isGroup) {
      // DM — the other person is the remoteJid
      const identity = resolveIdentity(remoteJid, lidToPhone, phoneToName, lidToName);
      senderPhone = identity.phone;
      senderName = identity.name || msg.pushName || msg.verifiedBizName || '';
      if (isLid(remoteJid)) senderLid = phoneFromJid(remoteJid);
    } else {
      senderPhone = '';
      senderName = msg.pushName || msg.verifiedBizName || '';
    }

    // Track names from pushName (real-time messages have this)
    if (msg.pushName) {
      if (senderPhone) phoneToName.set(senderPhone, msg.pushName);
      if (senderLid) lidToName.set(senderLid, msg.pushName);
    }

    // Resolve mentions
    const mentionJids = extractMentions(msg);
    const mentions: Array<{ phone: string; name: string }> = [];
    for (const mJid of mentionJids) {
      const m = resolveIdentity(mJid, lidToPhone, phoneToName, lidToName);
      if (m.phone || m.name) mentions.push(m);
    }

    // Build contextual text
    const chatName = chatNames.get(remoteJid) || '';
    // Text is the message body only — sender/chat context lives in metadata
    let contextualText = '';

    if (text) {
      contextualText = text;
    }

    // Handle special message types that may not have text
    if (msgType.type === 'image' && !text) {
      contextualText = 'sent an image';
    } else if (msgType.type === 'video' && !text) {
      contextualText = 'sent a video';
    } else if (msgType.type === 'audio') {
      contextualText = 'sent a voice message';
    } else if (msgType.type === 'document') {
      const fname = msgType.fileName || 'a document';
      contextualText = text ? `${fname}: ${text}` : `sent ${fname}`;
    } else if (msgType.type === 'sticker' && !text) {
      contextualText = 'sent a sticker';
    } else if (msgType.type === 'contact_card') {
      const names = contactCards
        .map((c) => c.displayName)
        .filter(Boolean)
        .join(', ');
      contextualText = `shared contact${contactCards.length > 1 ? 's' : ''}: ${names}`;
    } else if (location) {
      const locLabel = location.name || location.address || `${location.lat},${location.lng}`;
      contextualText = `shared location: ${locLabel}`;
    }

    if (!contextualText) return;

    // Replace @mentions in text with resolved names
    for (const m of mentions) {
      const mLabel = m.name ? `${m.name} (+${m.phone})` : `+${m.phone}`;
      if (m.phone) {
        contextualText = contextualText.replace(new RegExp(`@${m.phone}\\b`, 'g'), `@${mLabel}`);
      }
    }

    // Build full participants list: sender + recipient (DMs) + mentions
    const participants: string[] = [];
    if (senderPhone) participants.push(senderPhone);

    // For DMs, add the other party
    if (!isGroup) {
      const otherJid = fromMe ? remoteJid : '';
      if (otherJid) {
        const other = resolveIdentity(otherJid, lidToPhone, phoneToName, lidToName);
        if (other.phone && other.phone !== senderPhone) {
          participants.push(other.phone);
        }
      } else if (!fromMe && selfPhone && selfPhone !== senderPhone) {
        participants.push(selfPhone);
      }
    }

    // Add mentioned users to participants
    for (const m of mentions) {
      if (m.phone && !participants.includes(m.phone)) {
        participants.push(m.phone);
      }
    }

    // Extract contact card phones for contact resolution
    const sharedContacts: Array<{ name: string; phones: string[] }> = [];
    for (const card of contactCards) {
      const phones = phonesFromVcard(card.vcard);
      const name = card.displayName || nameFromVcard(card.vcard);
      if (name || phones.length) {
        sharedContacts.push({ name, phones });
        for (const p of phones) {
          if (!participants.includes(p)) {
            participants.push(p);
          }
        }
      }
    }

    // Build attachment metadata
    const attachments: Array<{ mimeType: string; type: string; fileName?: string }> = [];
    if (
      msgType.type !== 'text' &&
      msgType.type !== 'contact_card' &&
      msgType.type !== 'location' &&
      msgType.mimeType
    ) {
      attachments.push({
        type: msgType.type,
        mimeType: msgType.mimeType,
        ...(msgType.fileName && { fileName: msgType.fileName }),
      });
    }

    const msgTs = Number(msg.messageTimestamp || 0);

    // Download image/document media if available
    let fileBase64: string | undefined;
    let fileMimetype: string | undefined;
    let fileFileName: string | undefined;
    if (!skipMedia && (msgType.type === 'image' || msgType.type === 'document')) {
      const media = await downloadMedia(msg);
      if (media) {
        fileBase64 = media.base64;
        fileMimetype = media.mimetype;
        fileFileName = media.fileName;
      }
    }

    emit({
      sourceType: 'message',
      sourceId: msg.key?.id || `wa:${Date.now()}:${processed}`,
      timestamp: msg.messageTimestamp
        ? new Date(msgTs * 1000).toISOString()
        : new Date().toISOString(),
      content: {
        text: contextualText,
        participants,
        metadata: {
          chatId: remoteJid,
          chatName,
          senderPhone,
          senderName,
          senderLid: senderLid || undefined,
          pushName: msg.pushName || '',
          fromMe,
          isGroup,
          source,
          selfPhone,
          messageType: msgType.type,
          mentions: mentions.length > 0 ? mentions : undefined,
          sharedContacts: sharedContacts.length > 0 ? sharedContacts : undefined,
          location: location || undefined,
          attachments: attachments.length > 0 ? attachments : undefined,
          fileBase64,
          mimetype: fileMimetype,
          fileName: fileFileName,
        },
      },
    });
    processed++;
  };

  // --- Phase 1: Passive history collection ---
  // Wait for WhatsApp to push history batches via messaging-history.set,
  // then after idle timeout, switch to on-demand per-chat fetching.
  let disconnectedDuringSync = false;
  let disconnectReason = '';
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
        ctx.logger.info(
          `No new data for ${IDLE_TIMEOUT_MS / 1000}s, ending passive phase (${historyMsgCount} history msgs processed)`,
        );
        finish();
      }, IDLE_TIMEOUT_MS);
    };

    const deadline = setTimeout(() => {
      ctx.logger.info(`Sync hard deadline reached (${MAX_SYNC_MS / 1000}s)`);
      finish();
    }, MAX_SYNC_MS);

    if (ctx.signal.aborted) {
      finish();
      return;
    }
    ctx.signal.addEventListener('abort', finish, { once: true });

    // Detect mid-sync disconnection (e.g. user logged out from phone)
    sock.ev.on('connection.update', (update: any) => {
      if (update.connection === 'close') {
        const statusCode = (update.lastDisconnect?.error as any)?.output?.statusCode ?? 0;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const isBadSession = statusCode === DisconnectReason.badSession;
        const isMultidevice = statusCode === DisconnectReason.multideviceMismatch;
        const isFatal = isLoggedOut || isBadSession || isMultidevice;

        const reason = isFatal
          ? isLoggedOut
            ? 'Session logged out from phone'
            : isBadSession
              ? 'Session expired or corrupted'
              : 'Multi-device mismatch'
          : 'Connection lost during sync';

        ctx.logger.error(`WhatsApp disconnected during sync: ${reason} (code ${statusCode})`);
        disconnectedDuringSync = true;
        disconnectReason = reason;
        if (onDisconnect) onDisconnect(reason, statusCode);
        finish();
      }
    });

    // History sync — buffer messages, index contacts immediately
    sock.ev.on('messaging-history.set', (data: any) => {
      historyBatches++;
      const messages = data.messages || [];
      const chats = data.chats || [];
      const contacts = data.contacts || [];
      const progress = data.progress ?? null;

      // Index contacts: build LID→phone and phone→name mappings
      for (const contact of contacts) {
        const contactId = contact.id || '';
        const contactLid = contact.lid || '';
        const name = contact.notify || contact.name || contact.verifiedName || '';

        if (!isLid(contactId)) {
          const phone = phoneFromJid(contactId);
          if (phone && name) phoneToName.set(phone, name);
          if (phone && contactLid) {
            lidToPhone.set(phoneFromJid(contactLid), phone);
            if (name) lidToName.set(phoneFromJid(contactLid), name);
          }
        } else {
          const lidNum = phoneFromJid(contactId);
          if (name) lidToName.set(lidNum, name);
          if (contactLid && !isLid(contactLid)) {
            const phone = phoneFromJid(contactLid);
            if (phone) {
              lidToPhone.set(lidNum, phone);
              if (name) phoneToName.set(phone, name);
            }
          }
        }
      }

      // Index chat names
      for (const chat of chats) {
        if (chat.id && chat.name) {
          chatNames.set(chat.id, chat.name);
        }
      }

      ctx.logger.info(
        `History batch #${historyBatches}: ${messages.length} msgs, ${chats.length} chats, ${contacts.length} contacts (progress: ${progress})`,
      );
      ctx.logger.info(
        `Identity maps: ${lidToPhone.size} lid→phone, ${phoneToName.size} phone→name, ${lidToName.size} lid→name, ${chatNames.size} chats`,
      );

      // Process history messages immediately — emit as they arrive
      for (const msg of messages) {
        storeMessage(msg.key, msg.message);

        const msgTs = Number(msg.messageTimestamp || 0);
        const chatJid = msg.key?.remoteJid || '';
        if (chatJid && msgTs > 0) {
          const existing = chatOldest.get(chatJid);
          if (!existing || msgTs < existing.ts) {
            chatOldest.set(chatJid, { key: msg.key, ts: msgTs });
          }
        }
        historyMsgCount++;
        processMessage(msg, 'history');
      }

      resetIdle();
    });

    // Real-time + offline messages — process immediately (identity maps are warm)
    sock.ev.on('messages.upsert', (upsert: any) => {
      const msgs = upsert.messages || [];
      const type = upsert.type === 'notify' ? 'realtime' : 'append';
      ctx.logger.info(`messages.upsert: ${msgs.length} msgs, type=${upsert.type}`);
      for (const msg of msgs) {
        // Store message for decrypt retry callback
        storeMessage(msg.key, msg.message);

        // Track per-chat oldest for on-demand fetching
        const msgTs = Number(msg.messageTimestamp || 0);
        const chatJid = msg.key?.remoteJid || '';
        if (chatJid && msgTs > 0) {
          const existing = chatOldest.get(chatJid);
          if (!existing || msgTs < existing.ts) {
            chatOldest.set(chatJid, { key: msg.key, ts: msgTs });
          }
        }
        processMessage(msg, type);
      }
      resetIdle();
    });

    resetIdle();

    // Flush any buffered events from the auth socket (history may have arrived before sync attached handlers)
    if (existingSock) {
      ctx.logger.info('Flushing buffered auth socket events...');
      sock.ev.flush();
    }
  });

  // If disconnected during sync, throw so the job gets marked as failed
  if (disconnectedDuringSync) {
    // Save whatever identity maps we collected before dying
    saveIdentityMaps(sessionDir, { lidToPhone, phoneToName, lidToName });
    throw new Error(`WhatsApp session disconnected: ${disconnectReason}`);
  }

  // --- Phase 2: On-demand per-chat history fetching ---
  // After passive history stops, iterate through chats and request older messages.
  if (
    !ctx.signal.aborted &&
    chatOldest.size > 0 &&
    typeof (sock as any).fetchMessageHistory === 'function'
  ) {
    const elapsedMs = Date.now() - syncStartTime;
    const remainingMs = MAX_SYNC_MS - elapsedMs;

    // Skip broadcast/newsletter chats, sort by fewest messages first (likely incomplete)
    const chatsToFetch = [...chatOldest.entries()]
      .filter(([jid]) => !jid.endsWith('@broadcast') && !jid.endsWith('@newsletter'))
      .sort(); // deterministic order

    ctx.logger.info(
      `On-demand fetching: ${chatsToFetch.length} chats with known oldest messages (${remainingMs / 1000}s budget)`,
    );

    let totalOnDemandMsgs = 0;
    let chatsChecked = 0;

    for (const [chatJid, oldest] of chatsToFetch) {
      if (ctx.signal.aborted) break;
      if (Date.now() - syncStartTime > MAX_SYNC_MS - 5000) {
        ctx.logger.info('On-demand fetching: time budget exhausted');
        break;
      }

      // Jitter between chats to avoid rate limiting
      if (chatsChecked > 0) await jitter(300, 1500);

      let currentKey = oldest.key;
      let currentTs = oldest.ts;

      for (let round = 0; round < ON_DEMAND_ROUNDS_PER_CHAT; round++) {
        // Jitter between fetches to mimic natural scrolling
        await jitter(500, 2000);

        const beforeCount = processed;
        try {
          await (sock as any).fetchMessageHistory(ON_DEMAND_MSGS_PER_FETCH, currentKey, currentTs);
        } catch (err: any) {
          ctx.logger.info(`fetchMessageHistory failed for ${chatJid}: ${err.message}`);
          break;
        }

        // Wait for messages to arrive via messaging-history.set
        await new Promise((r) => setTimeout(r, ON_DEMAND_WAIT_MS));

        const newMsgs = processed - beforeCount;
        totalOnDemandMsgs += newMsgs;

        if (newMsgs === 0) break; // No more history for this chat

        // Update oldest for next round
        const updated = chatOldest.get(chatJid);
        if (updated && updated.ts < currentTs) {
          currentKey = updated.key;
          currentTs = updated.ts;
        } else {
          break; // No older messages arrived
        }
      }

      chatsChecked++;
      if (chatsChecked % 20 === 0) {
        ctx.logger.info(
          `On-demand progress: ${chatsChecked}/${chatsToFetch.length} chats, +${totalOnDemandMsgs} msgs`,
        );
      }
    }

    ctx.logger.info(
      `On-demand fetching complete: ${chatsChecked} chats checked, +${totalOnDemandMsgs} additional messages`,
    );
  }

  // Fetch group metadata for chat names and member tracking
  // NOTE: In Baileys v7, group participants only have LID-based IDs (no phoneNumber field)
  try {
    ctx.logger.info('Fetching group metadata...');
    const groups = await (sock as any).groupFetchAllParticipating();
    let totalParticipants = 0;
    const allGroupLids = new Set<string>();

    for (const [groupJid, meta] of Object.entries(groups) as [string, any][]) {
      if (meta.subject) chatNames.set(groupJid, meta.subject);
      const participants = meta.participants || [];
      totalParticipants += participants.length;
      if (!groupParticipants.has(groupJid)) groupParticipants.set(groupJid, new Set());
      const memberSet = groupParticipants.get(groupJid)!;
      for (const p of participants) {
        const id = p.id || '';
        memberSet.add(id);
        if (isLid(id)) allGroupLids.add(phoneFromJid(id));
      }
    }
    ctx.logger.info(
      `Group metadata: ${Object.keys(groups).length} groups, ${totalParticipants} participants, ${allGroupLids.size} unique LIDs`,
    );
  } catch (err: any) {
    ctx.logger.info(`groupFetchAllParticipating failed: ${err.message}`);
  }

  // LID identity resolution status
  // NOTE: Baileys v6 does NOT support LID→phone resolution through any API.
  // WhatsApp uses LIDs for privacy in group participants. The only mapping source
  // is the `chats.phoneNumberShare` event which fires during real-time messages.
  // Real-time messages also carry `pushName` which populates lidToName.
  {
    let unresolvedCount = 0;
    for (const [, members] of groupParticipants) {
      for (const jid of members) {
        if (isLid(jid) && !lidToPhone.has(phoneFromJid(jid)) && !lidToName.has(phoneFromJid(jid))) {
          unresolvedCount++;
        }
      }
    }
    ctx.logger.info(
      `Unresolved LIDs: ${unresolvedCount} (from ${groupParticipants.size} groups). LID→phone mapping requires real-time messages.`,
    );
  }

  // Save identity maps for future re-syncs
  saveIdentityMaps(sessionDir, { lidToPhone, phoneToName, lidToName });
  ctx.logger.info(
    `Identity maps before processing: ${lidToPhone.size} lid→phone, ${phoneToName.size} phone→name, ${lidToName.size} lid→name`,
  );

  // Emit contact events for all resolved identities
  emitContactEvents(
    ctx,
    emit,
    selfPhone,
    phoneToName,
    lidToPhone,
    lidToName,
    chatNames,
    groupParticipants,
  );

  try {
    sock.ws?.close();
  } catch {
    /* ignore */
  }

  ctx.logger.info(
    `Synced ${processed} WhatsApp messages from ${historyBatches} history batches (${lidToPhone.size} lid→phone, ${phoneToName.size} phone→name, ${chatNames.size} chats)`,
  );
  return { cursor: null, hasMore: false, processed };
}

/**
 * Emit contact-type events for every person we discovered during the sync.
 * This ensures the contacts table gets populated with WhatsApp identities.
 */
function emitContactEvents(
  ctx: SyncContext,
  emit: (event: ConnectorDataEvent) => void,
  selfPhone: string,
  phoneToName: Map<string, string>,
  lidToPhone: Map<string, string>,
  lidToName: Map<string, string>,
  chatNames: Map<string, string>,
  groupParticipants: Map<string, Set<string>>,
): void {
  const emittedPhones = new Set<string>();

  // Emit contact for every phone→name mapping we have
  for (const [phone, name] of phoneToName) {
    if (emittedPhones.has(phone)) continue;
    emittedPhones.add(phone);

    emit({
      sourceType: 'message',
      sourceId: `wa-contact:${phone}`,
      timestamp: new Date().toISOString(),
      content: {
        text: `WhatsApp contact: ${name} (+${phone})`,
        participants: [phone],
        metadata: {
          type: 'contact',
          name,
          phone,
          phones: [phone],
          connectorType: 'whatsapp',
          selfPhone,
        },
      },
    });
  }

  // Emit contacts from LID maps that resolved to a phone
  for (const [lid, phone] of lidToPhone) {
    if (emittedPhones.has(phone)) continue;
    emittedPhones.add(phone);

    const name = lidToName.get(lid) || phoneToName.get(phone) || '';
    emit({
      sourceType: 'message',
      sourceId: `wa-contact:${phone}`,
      timestamp: new Date().toISOString(),
      content: {
        text: `WhatsApp contact: ${name || 'Unknown'} (+${phone})`,
        participants: [phone],
        metadata: {
          type: 'contact',
          name,
          phone,
          phones: [phone],
          connectorType: 'whatsapp',
          selfPhone,
        },
      },
    });
  }

  // Emit group metadata
  for (const [groupJid, groupName] of chatNames) {
    if (!groupJid.endsWith('@g.us')) continue;

    const members = groupParticipants.get(groupJid);
    const memberPhones: string[] = [];
    if (members) {
      for (const jid of members) {
        const identity = resolveIdentity(jid, lidToPhone, phoneToName, lidToName);
        if (identity.phone) memberPhones.push(identity.phone);
      }
    }

    emit({
      sourceType: 'message',
      sourceId: `wa-group:${groupJid}`,
      timestamp: new Date().toISOString(),
      content: {
        text: `WhatsApp group: ${groupName} (${memberPhones.length} known members)`,
        participants: memberPhones,
        metadata: {
          type: 'contact',
          name: groupName,
          isGroup: true,
          groupJid,
          memberCount: memberPhones.length,
          memberPhones,
          connectorType: 'whatsapp',
          selfPhone,
        },
      },
    });
  }

  ctx.logger.info(
    `Emitted ${emittedPhones.size} contact events and ${chatNames.size} group events`,
  );
}



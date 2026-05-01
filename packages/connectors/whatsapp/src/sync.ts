import {
  makeWASocket,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  downloadContentFromMessage,
  DisconnectReason,
  Browsers,
  USyncQuery,
  USyncUser,
  proto,
  type WAMessage,
  type WAMessageKey,
} from '@whiskeysockets/baileys';
import type { GroupMetadata, MediaType } from '@whiskeysockets/baileys';
import type { Boom } from '@hapi/boom';
import type { Transform } from 'stream';
import pino from 'pino';
import type { LogFn } from 'pino';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { promisify } from 'util';
import { inflate } from 'zlib';
import { isAbsolute, join, resolve } from 'path';
import type { SyncContext, ConnectorDataEvent, ConnectorLogger } from '@botmem/connector-sdk';
import { isNoise } from '@botmem/connector-sdk';
import { useAtomicMultiFileAuthState, flushPendingWrites } from './atomic-auth-state.js';

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
    logMethod(inputArgs: Parameters<LogFn>, _method: LogFn) {
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
}) as pino.Logger;

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

function extractText(msg: WAMessage): string {
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
function detectMessageType(msg: WAMessage): { type: string; mimeType?: string; fileName?: string } {
  const m = msg.message;
  if (!m) return { type: 'unknown' };

  if (m.imageMessage) return { type: 'image', mimeType: m.imageMessage.mimetype || undefined };
  if (m.videoMessage) return { type: 'video', mimeType: m.videoMessage.mimetype || undefined };
  if (m.audioMessage) return { type: 'audio', mimeType: m.audioMessage.mimetype || undefined };
  if (m.stickerMessage)
    return { type: 'sticker', mimeType: m.stickerMessage.mimetype || undefined };
  if (m.documentMessage)
    return {
      type: 'document',
      mimeType: m.documentMessage.mimetype || undefined,
      fileName: m.documentMessage.fileName || undefined,
    };
  if (m.documentWithCaptionMessage?.message?.documentMessage) {
    const doc = m.documentWithCaptionMessage.message.documentMessage;
    return {
      type: 'document',
      mimeType: doc.mimetype || undefined,
      fileName: doc.fileName || undefined,
    };
  }
  if (m.contactMessage || m.contactsArrayMessage) return { type: 'contact_card' };
  if (m.locationMessage || m.liveLocationMessage) return { type: 'location' };
  if (m.conversation || m.extendedTextMessage) return { type: 'text' };
  if (m.protocolMessage) return { type: 'protocol' };
  if (m.reactionMessage) return { type: 'reaction' };
  return { type: 'unknown' };
}

/** Extract shared contact vCards from a message */
function extractContactCards(msg: WAMessage): Array<{ displayName: string; vcard: string }> {
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
    return m.contactsArrayMessage.contacts.map((c) => ({
      displayName: c.displayName || '',
      vcard: c.vcard || '',
    }));
  }
  return [];
}

/** Extract location data from a message */
function extractLocation(
  msg: WAMessage,
): { lat: number; lng: number; name?: string; address?: string } | null {
  const locMsg = msg.message?.locationMessage;
  const liveLoc = msg.message?.liveLocationMessage;
  const loc = locMsg || liveLoc;
  if (!loc) return null;
  return {
    lat: loc.degreesLatitude ?? 0,
    lng: loc.degreesLongitude ?? 0,
    name: locMsg?.name || undefined,
    address: locMsg?.address || undefined,
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

function normalizePhoneForLookup(phone: string): string {
  const cleaned = phone.replace(/[^\d+]/g, '');
  if (!cleaned) return '';
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}

function rememberPhoneLidMapping(
  phone: string,
  lidJid: string,
  lidToPhone: Map<string, string>,
  phoneToLid: Map<string, string>,
) {
  const phoneKey = phoneFromJid(phone).replace(/[^\d]/g, '');
  const lidKey = phoneFromJid(lidJid);
  if (!phoneKey || !lidKey || !isLid(lidJid)) return;
  phoneToLid.set(phoneKey, lidKey);
  lidToPhone.set(lidKey, phoneKey);
}

async function resolveKnownPhonesToLids(
  sock: WaSock,
  phones: Iterable<string>,
  lidToPhone: Map<string, string>,
  phoneToLid: Map<string, string>,
  log: (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void,
) {
  if (typeof sock.executeUSyncQuery !== 'function') return;
  const phoneList = [...new Set([...phones].map(normalizePhoneForLookup).filter(Boolean))].filter(
    (phone) => !phoneToLid.has(phoneFromJid(phone).replace(/[^\d]/g, '')),
  );
  if (!phoneList.length) return;

  let resolved = 0;
  for (let i = 0; i < phoneList.length; i += PHONE_LOOKUP_BATCH_SIZE) {
    const batch = phoneList.slice(i, i + PHONE_LOOKUP_BATCH_SIZE);
    const query = new USyncQuery().withContactProtocol();
    for (const phone of batch) {
      query.withUser(new USyncUser().withPhone(phone));
    }
    try {
      const result = await sock.executeUSyncQuery(query);
      for (let idx = 0; idx < (result?.list?.length || 0); idx++) {
        const entry = result!.list[idx];
        const lidJid = entry?.id || '';
        if (!isLid(lidJid)) continue;
        rememberPhoneLidMapping(batch[idx], lidJid, lidToPhone, phoneToLid);
        resolved++;
      }
      await jitter(100, 400);
    } catch (err) {
      log(
        'debug',
        `WhatsApp phone→LID lookup failed for batch ${i / PHONE_LOOKUP_BATCH_SIZE + 1}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  if (resolved > 0) log('info', `Resolved ${resolved} WhatsApp phone number(s) to LIDs`);
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
  msg: WAMessage,
): Promise<{ base64: string; mimetype: string; fileName?: string } | null> {
  const m = msg.message;
  if (!m) return null;

  let mediaMsg: proto.IMessage[keyof proto.IMessage] | null = null;
  let mediaType: MediaType | '' = '';
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
    mime = (mediaMsg as proto.Message.IDocumentMessage).mimetype || 'application/octet-stream';
    fileName = (mediaMsg as proto.Message.IDocumentMessage).fileName || '';
  }

  if (
    !mediaMsg ||
    !(mediaMsg as { mediaKey?: unknown }).mediaKey ||
    !(mediaMsg as { directPath?: unknown }).directPath
  )
    return null;
  if (!mediaType) return null;

  try {
    // Small jitter before media download to avoid burst requests
    await jitter(200, 800);
    const stream: Transform = await downloadContentFromMessage(
      mediaMsg as Parameters<typeof downloadContentFromMessage>[0],
      mediaType,
    );
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
    phoneToLid: Map<string, string>;
    phoneToName: Map<string, string>;
    lidToName: Map<string, string>;
  },
) {
  try {
    const data = {
      lidToPhone: Object.fromEntries(maps.lidToPhone),
      phoneToLid: Object.fromEntries(maps.phoneToLid),
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
  phoneToLid: Map<string, string>;
  phoneToName: Map<string, string>;
  lidToName: Map<string, string>;
} | null {
  try {
    const path = join(sessionDir, 'identity-maps.json');
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    return {
      lidToPhone: new Map(Object.entries(data.lidToPhone || {})),
      phoneToLid: new Map(Object.entries(data.phoneToLid || {})),
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
const MAX_SYNC_MS = 60 * 60_000; // 60 minutes hard deadline for expansive first history sync
const IDLE_TIMEOUT_FIRST_MS = 30_000; // 30 seconds — process what we have, don't wait forever
const IDLE_TIMEOUT_RESYNC_MS = 15_000; // 15 seconds for re-syncs

// On-demand per-chat history fetching
const ON_DEMAND_ROUNDS_PER_CHAT = 40; // max fetch rounds per chat
const ON_DEMAND_MSGS_PER_FETCH = 100; // messages per fetch request
const ON_DEMAND_WAIT_MS = 2500; // wait for messages to arrive after fetch
const ON_DEMAND_FETCH_TIMEOUT_MS = 15_000;
const PHONE_LOOKUP_BATCH_SIZE = 50;
const WHATSAPP_HISTORY_CURSOR = 'whatsapp-history-v1';
const REALTIME_STARTUP_QUARANTINE_MS = 2 * 60_000;

type WaSock = ReturnType<typeof makeWASocket>;

const inflatePromise = promisify(inflate);

type SocketEventBatch = Record<string, unknown>;
type SocketEventLogger =
  | Pick<ConnectorLogger, 'info'>
  | ((level: 'info', message: string) => void)
  | undefined;

function socketLog(logger: SocketEventLogger, message: string) {
  if (process.env.WHATSAPP_DEBUG_SOCKET !== '1') return;
  if (!logger) return;
  if (typeof logger === 'function') logger('info', message);
  else logger.info(message);
}

function summarizeArray(value: unknown, label = 'items'): string {
  return `${Array.isArray(value) ? value.length : 0} ${label}`;
}

function summarizeSocketEvent(key: string, value: unknown): string {
  const data = (value || {}) as Record<string, unknown>;
  switch (key) {
    case 'connection.update': {
      const lastDisconnect = data.lastDisconnect as
        | { error?: { output?: { statusCode?: number } } }
        | undefined;
      const code = lastDisconnect?.error?.output?.statusCode;
      return `connection=${String(data.connection ?? '') || '-'} qr=${data.qr ? 'yes' : 'no'} isNewLogin=${data.isNewLogin ? 'yes' : 'no'} receivedPending=${data.receivedPendingNotifications ? 'yes' : 'no'}${code ? ` code=${code}` : ''}`;
    }
    case 'messaging-history.set':
      return `${summarizeArray(data.messages, 'msgs')} ${summarizeArray(data.chats, 'chats')} ${summarizeArray(data.contacts, 'contacts')} syncType=${String(data.syncType ?? '-')} progress=${String(data.progress ?? '-')}`;
    case 'messages.upsert':
      return `${summarizeArray(data.messages, 'msgs')} type=${String(data.type ?? '-')}`;
    case 'messages.update':
    case 'messages.delete':
    case 'messages.reaction':
    case 'message-receipt.update':
    case 'chats.upsert':
    case 'chats.update':
    case 'chats.delete':
    case 'contacts.upsert':
    case 'contacts.update':
    case 'groups.upsert':
    case 'groups.update':
    case 'group-participants.update':
    case 'blocklist.set':
    case 'blocklist.update':
    case 'call':
    case 'lid-mapping.update':
      return Array.isArray(value) ? summarizeArray(value) : 'event received';
    default:
      return Array.isArray(value) ? summarizeArray(value) : typeof value;
  }
}

function logSocketEventBatch(logger: SocketEventLogger, scope: string, events: SocketEventBatch) {
  const keys = Object.keys(events);
  socketLog(logger, `[wa:socket:${scope}] events=${keys.join(',') || 'none'}`);
  for (const key of keys) {
    socketLog(logger, `[wa:socket:${scope}] ${key}: ${summarizeSocketEvent(key, events[key])}`);
  }
}

function summarizeMessageForLog(msg: WAMessage): string {
  const message = (msg.message || {}) as Record<string, unknown>;
  const messageTypes = Object.keys(message).join('|') || '-';
  return [
    `fromMe=${String(msg.key?.fromMe ?? '-')}`,
    `ts=${String(msg.messageTimestamp || '-')}`,
    `types=${messageTypes}`,
  ].join(' ');
}

function resolveSessionDir(sessionDir: string): string {
  if (isAbsolute(sessionDir)) return sessionDir;
  const candidates = [
    resolve(sessionDir),
    resolve(process.cwd(), '..', '..', sessionDir),
    resolve(process.cwd(), '..', sessionDir),
  ];
  return candidates.find((dir) => existsSync(join(dir, 'creds.json'))) ?? candidates[0];
}

export interface WhatsAppRealtimeHandle {
  stop(): Promise<void>;
}

export interface WhatsAppRealtimeCallbacks {
  onEvent(event: ConnectorDataEvent): void | Promise<void>;
  onConnected?(info: { selfPhone: string }): void | Promise<void>;
  onDisconnect?(reason: string, code: number): void | Promise<void>;
  onLog?(level: 'info' | 'warn' | 'error' | 'debug', message: string): void;
  signal?: AbortSignal;
}

/**
 * Process INITIAL_BOOTSTRAP inline payload that Baileys can't handle.
 * WhatsApp sends history data inline (no download URL), but Baileys only
 * knows how to download from URLs → fails silently → 0 messages.
 * We intercept via shouldSyncHistoryMessage and emit the data ourselves.
 */
async function processInlineHistoryPayload(
  notification: proto.Message.IHistorySyncNotification,
  ev: WaSock['ev'],
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

async function createSyncSocket(
  sessionDir: string,
  options: { syncFullHistory?: boolean; logger?: Pick<ConnectorLogger, 'info'> } = {},
): Promise<WaSock> {
  mkdirSync(sessionDir, { recursive: true });
  const { state, saveCreds } = await useAtomicMultiFileAuthState(sessionDir);

  // Clear processedHistoryMessages so WhatsApp re-delivers history on reconnect
  if (state.creds.processedHistoryMessages?.length) {
    options.logger?.info(
      `WhatsApp createSyncSocket clearing processedHistoryMessages count=${state.creds.processedHistoryMessages.length}`,
    );
    state.creds.processedHistoryMessages = [];
  }

  const version = await getWhatsAppVersion();

  let sockRef: WaSock | null = null;
  let inlineProcessed = false;

  // Realtime sockets stay lightweight; explicit sync jobs request history so they
  // can repair messages missed while the realtime connection was down or stale.
  const isFirstPairing = !state.creds.me?.id;
  const syncFullHistory = options.syncFullHistory ?? isFirstPairing;
  options.logger?.info(
    `WhatsApp createSyncSocket session=${sessionDir} version=${version.join('.')} syncFullHistory=${syncFullHistory} hasMe=${state.creds.me?.id ? 'yes' : 'no'} processedHistory=${state.creds.processedHistoryMessages?.length || 0} browser=${syncFullHistory ? 'Desktop' : 'Chrome'}`,
  );

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    version,
    browser: syncFullHistory ? Browsers.macOS('Desktop') : Browsers.macOS('Chrome'),
    printQRInTerminal: false,
    logger,
    syncFullHistory,
    markOnlineOnConnect: false,
    getMessage,
    msgRetryCounterCache: makeCacheStore(),
    shouldSyncHistoryMessage: (msg: proto.Message.IHistorySyncNotification) => {
      options.logger?.info(
        `WhatsApp shouldSyncHistoryMessage type=${msg.syncType ?? '-'} progress=${msg.progress ?? '-'} inline=${msg.initialHistBootstrapInlinePayload?.length || 0}`,
      );
      if (!inlineProcessed && msg.initialHistBootstrapInlinePayload?.length && sockRef) {
        inlineProcessed = true;
        options.logger?.info('WhatsApp processing inline history payload');
        processInlineHistoryPayload(msg, sockRef.ev);
      }
      return true;
    },
  } as Parameters<typeof makeWASocket>[0]);
  sockRef = sock;

  if (sock.ws && typeof sock.ws.on === 'function') {
    sock.ws.on('error', () => {});
  }

  sock.ev.on('creds.update', () => void saveCreds());
  return sock;
}

function buildMessageEvent(
  msg: WAMessage,
  source: string,
  selfPhone: string,
  lidToPhone: Map<string, string>,
  phoneToLid: Map<string, string>,
  phoneToName: Map<string, string>,
  lidToName: Map<string, string>,
  chatNames: Map<string, string>,
  groupParticipants: Map<string, Set<string>>,
  log?: (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void,
): ConnectorDataEvent | null {
  if (!msg.message) return null;

  const m = msg.message;
  const msgType = detectMessageType(msg);
  if (msgType.type === 'protocol' || msgType.type === 'reaction') return null;
  if (
    m.ephemeralMessage ||
    m.viewOnceMessage ||
    m.viewOnceMessageV2 ||
    m.viewOnceMessageV2Extension
  ) {
    log?.('debug', `Noise filtered (ephemeral/view-once): msg ${msg.key?.id}`);
    return null;
  }
  if (m.groupInviteMessage || m.bcallMessage || m.callLogMesssage) return null;

  const remoteJid = msg.key?.remoteJid || '';
  if (!remoteJid || remoteJid === 'status@broadcast') return null;

  const text = extractText(msg);
  const contactCards = extractContactCards(msg);
  const location = extractLocation(msg);
  if (!text && contactCards.length === 0 && !location && msgType.type === 'unknown') return null;
  if (text && isNoise(text, {})) return null;

  const participantJid = msg.key?.participant || msg.participant || '';
  const isGroup = remoteJid.endsWith('@g.us');
  const fromMe = msg.key?.fromMe ?? false;

  if (isGroup && participantJid) {
    if (!groupParticipants.has(remoteJid)) groupParticipants.set(remoteJid, new Set());
    groupParticipants.get(remoteJid)!.add(participantJid);
  }

  let senderPhone = '';
  let senderName: string;
  let senderLid = '';
  if (fromMe) {
    senderPhone = selfPhone;
    senderName = phoneToName.get(selfPhone) || 'Me';
  } else if (participantJid) {
    const identity = resolveIdentity(
      participantJid,
      lidToPhone,
      phoneToLid,
      phoneToName,
      lidToName,
    );
    senderPhone = identity.phone;
    senderName = identity.name || msg.pushName || msg.verifiedBizName || '';
    if (isLid(participantJid)) senderLid = phoneFromJid(participantJid);
  } else if (!isGroup) {
    const identity = resolveIdentity(remoteJid, lidToPhone, phoneToLid, phoneToName, lidToName);
    senderPhone = identity.phone;
    senderName = identity.name || msg.pushName || msg.verifiedBizName || '';
    if (isLid(remoteJid)) senderLid = phoneFromJid(remoteJid);
  } else {
    senderName = msg.pushName || msg.verifiedBizName || '';
  }

  if (msg.pushName) {
    if (senderPhone) phoneToName.set(senderPhone, msg.pushName);
    if (senderLid) lidToName.set(senderLid, msg.pushName);
  }

  const mentionJids = extractMentions(msg);
  const mentions: Array<{ phone: string; name: string }> = [];
  for (const mJid of mentionJids) {
    const mention = resolveIdentity(mJid, lidToPhone, phoneToLid, phoneToName, lidToName);
    if (mention.phone || mention.name) mentions.push(mention);
  }

  let contextualText = text || '';
  if (msgType.type === 'image' && !text) contextualText = 'sent an image';
  else if (msgType.type === 'video' && !text) contextualText = 'sent a video';
  else if (msgType.type === 'audio') contextualText = 'sent a voice message';
  else if (msgType.type === 'document') {
    const fname = msgType.fileName || 'a document';
    contextualText = text ? `${fname}: ${text}` : `sent ${fname}`;
  } else if (msgType.type === 'sticker' && !text) contextualText = 'sent a sticker';
  else if (msgType.type === 'contact_card') {
    const names = contactCards
      .map((c) => c.displayName)
      .filter(Boolean)
      .join(', ');
    contextualText = `shared contact${contactCards.length > 1 ? 's' : ''}: ${names}`;
  } else if (location) {
    const locLabel = location.name || location.address || `${location.lat},${location.lng}`;
    contextualText = `shared location: ${locLabel}`;
  }
  if (!contextualText) return null;

  for (const mention of mentions) {
    const label = mention.name ? `${mention.name} (+${mention.phone})` : `+${mention.phone}`;
    if (mention.phone)
      contextualText = contextualText.replace(new RegExp(`@${mention.phone}\\b`, 'g'), `@${label}`);
  }

  const participants: string[] = [];
  if (senderPhone) participants.push(senderPhone);
  if (!isGroup) {
    const otherJid = fromMe ? remoteJid : '';
    if (otherJid) {
      const other = resolveIdentity(otherJid, lidToPhone, phoneToLid, phoneToName, lidToName);
      if (other.phone && other.phone !== senderPhone) participants.push(other.phone);
    } else if (!fromMe && selfPhone && selfPhone !== senderPhone) {
      participants.push(selfPhone);
    }
  }
  for (const mention of mentions) {
    if (mention.phone && !participants.includes(mention.phone)) participants.push(mention.phone);
  }

  const sharedContacts: Array<{ name: string; phones: string[] }> = [];
  for (const card of contactCards) {
    const phones = phonesFromVcard(card.vcard);
    const name = card.displayName || nameFromVcard(card.vcard);
    if (name || phones.length) {
      sharedContacts.push({ name, phones });
      for (const p of phones) if (!participants.includes(p)) participants.push(p);
    }
  }

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
  const messageId = msg.key?.id || `${Date.now()}`;
  return {
    sourceType: 'message',
    sourceId: `wa-msg:${messageId}`,
    timestamp: msgTs ? new Date(msgTs * 1000).toISOString() : new Date().toISOString(),
    content: {
      text: contextualText,
      participants,
      metadata: {
        chatId: remoteJid,
        chatName: chatNames.get(remoteJid) || '',
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
      },
    },
  };
}

export async function startWhatsAppRealtime(
  sessionDir: string,
  callbacks: WhatsAppRealtimeCallbacks,
): Promise<WhatsAppRealtimeHandle> {
  const resolvedSessionDir = resolveSessionDir(sessionDir);
  const credsPath = join(resolvedSessionDir, 'creds.json');
  if (!existsSync(resolvedSessionDir) || !existsSync(credsPath)) {
    throw new Error('WhatsApp session files missing — please reconnect (re-scan QR)');
  }

  const sock = await createSyncSocket(resolvedSessionDir, { syncFullHistory: false });
  let stopped = false;
  const saved = loadIdentityMaps(resolvedSessionDir);
  const lidToPhone = saved?.lidToPhone ?? new Map<string, string>();
  const phoneToLid = saved?.phoneToLid ?? new Map<string, string>();
  const phoneToName = saved?.phoneToName ?? new Map<string, string>();
  const lidToName = saved?.lidToName ?? new Map<string, string>();
  const chatNames = new Map<string, string>();
  const groupParticipants = new Map<string, Set<string>>();
  const log = callbacks.onLog;
  const emittedSourceIds = new Set<string>();
  const realtimeStartedAt = Date.now();
  const rememberEmitted = (sourceId: string) => {
    emittedSourceIds.add(sourceId);
    if (emittedSourceIds.size > MESSAGE_STORE_MAX) {
      const first = emittedSourceIds.values().next().value;
      if (first) emittedSourceIds.delete(first);
    }
  };
  const emitRealtimeEvent = async (event: ConnectorDataEvent | null) => {
    if (!event) return;
    if (emittedSourceIds.has(event.sourceId)) return;
    rememberEmitted(event.sourceId);
    await callbacks.onEvent(event);
  };
  const handleUpsert = async (
    upsert: { messages?: WAMessage[]; type?: string },
    sourceOverride?: string,
  ) => {
    const source = sourceOverride ?? (upsert.type === 'notify' ? 'realtime' : 'append');
    const isStartupReplay =
      source === 'realtime' && Date.now() - realtimeStartedAt < REALTIME_STARTUP_QUARANTINE_MS;
    log?.(
      'info',
      `WhatsApp realtime messages.upsert: ${upsert.messages?.length || 0} msgs, type=${upsert.type}`,
    );
    for (const msg of upsert.messages || []) {
      storeMessage(msg.key, msg.message);
      if (isStartupReplay) {
        log?.('info', `WhatsApp realtime startup replay filtered: ${summarizeMessageForLog(msg)}`);
        continue;
      }
      await emitRealtimeEvent(
        buildMessageEvent(
          msg,
          source,
          phoneFromJid(sock.user?.id || ''),
          lidToPhone,
          phoneToLid,
          phoneToName,
          lidToName,
          chatNames,
          groupParticipants,
          log,
        ),
      );
    }
    saveIdentityMaps(resolvedSessionDir, { lidToPhone, phoneToLid, phoneToName, lidToName });
  };
  const stopFromSignal = () => {
    stopped = true;
    try {
      sock.ws?.close();
    } catch {
      /* ignore */
    }
  };
  callbacks.signal?.addEventListener('abort', stopFromSignal, { once: true });

  const waitForOpen = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WhatsApp connection timeout')), 30_000);
    sock.ev.on('connection.update', (update) => {
      logSocketEventBatch(log, 'realtime:on', { 'connection.update': update });
      if (stopped) return;
      if (update.connection === 'open') {
        clearTimeout(timeout);
        resolve();
      }
      if (update.connection === 'close') {
        clearTimeout(timeout);
        const disconnectError = update.lastDisconnect?.error as Boom | Error | undefined;
        const statusCode =
          disconnectError && 'output' in disconnectError
            ? (disconnectError as Boom).output.statusCode
            : 0;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const isBadSession = statusCode === DisconnectReason.badSession;
        const isMultidevice = statusCode === DisconnectReason.multideviceMismatch;
        const isReplaced = statusCode === DisconnectReason.connectionReplaced;
        const reason = isLoggedOut
          ? 'Session logged out from phone — please reconnect (re-scan QR)'
          : isBadSession
            ? 'Session expired or corrupted — please reconnect (re-scan QR)'
            : isMultidevice
              ? 'Multi-device mismatch — please reconnect (re-scan QR)'
              : isReplaced
                ? 'Another WhatsApp Web session is active — close it and retry sync'
                : 'Connection lost during realtime sync';
        void callbacks.onDisconnect?.(reason, statusCode);
        reject(new Error(reason));
      }
    });
  });

  sock.ev.process(async (events) => {
    logSocketEventBatch(log, 'realtime:process', events);
    if (stopped) return;
    if (events['messaging-history.set']) {
      const data = events['messaging-history.set'];
      for (const contact of data.contacts || []) {
        const contactId = contact.id || '';
        const contactLid = contact.lid || '';
        const name = contact.notify || contact.name || contact.verifiedName || '';
        if (!isLid(contactId)) {
          const phone = phoneFromJid(contactId);
          if (phone && name) phoneToName.set(phone, name);
          if (phone && contactLid)
            rememberPhoneLidMapping(phone, contactLid, lidToPhone, phoneToLid);
        }
      }
      for (const chat of data.chats || [])
        if (chat.id && chat.name) chatNames.set(chat.id, chat.name);
      for (const msg of data.messages || []) {
        storeMessage(msg.key, msg.message);
        const event = buildMessageEvent(
          msg,
          'history',
          phoneFromJid(sock.user?.id || ''),
          lidToPhone,
          phoneToLid,
          phoneToName,
          lidToName,
          chatNames,
          groupParticipants,
          log,
        );
        await emitRealtimeEvent(event);
      }
      saveIdentityMaps(resolvedSessionDir, { lidToPhone, phoneToLid, phoneToName, lidToName });
    }

    if (events['messages.upsert']) {
      await handleUpsert(events['messages.upsert']);
    }
  });

  sock.ev.on('messages.upsert', (upsert) => {
    logSocketEventBatch(log, 'realtime:on', { 'messages.upsert': upsert });
    if (stopped) return;
    void handleUpsert(upsert).catch((err) =>
      log?.(
        'error',
        `WhatsApp realtime upsert handler failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  });

  await waitForOpen;
  const selfPhone = phoneFromJid(sock.user?.id || '');
  await callbacks.onConnected?.({ selfPhone });

  try {
    const groups: Record<string, GroupMetadata> = await sock.groupFetchAllParticipating();
    for (const [groupJid, meta] of Object.entries(groups)) {
      if (meta.subject) chatNames.set(groupJid, meta.subject);
      const participants = meta.participants || [];
      if (!groupParticipants.has(groupJid)) groupParticipants.set(groupJid, new Set());
      const memberSet = groupParticipants.get(groupJid)!;
      for (const p of participants) if (p.id) memberSet.add(p.id);
    }
    await resolveKnownPhonesToLids(
      sock,
      [selfPhone, ...phoneToName.keys()],
      lidToPhone,
      phoneToLid,
      (level, message) => log?.(level, message),
    );
    emitContactEvents(
      {
        logger: {
          info: (m) => log?.('info', m),
          warn: (m) => log?.('warn', m),
          error: (m) => log?.('error', m),
          debug: (m) => log?.('debug', m),
        },
      } as SyncContext,
      callbacks.onEvent,
      selfPhone,
      phoneToName,
      lidToPhone,
      phoneToLid,
      lidToName,
      chatNames,
      groupParticipants,
    );
  } catch (err) {
    log?.(
      'warn',
      `WhatsApp realtime group metadata failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    async stop() {
      stopped = true;
      callbacks.signal?.removeEventListener('abort', stopFromSignal);
      await flushPendingWrites();
      try {
        sock.ws?.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Resolves a JID (which may be a LID or phone-based) to { phone, name }.
 */
function resolveIdentity(
  jid: string,
  lidToPhone: Map<string, string>,
  phoneToLid: Map<string, string>,
  phoneToName: Map<string, string>,
  lidToName: Map<string, string>,
): { phone: string; name: string } {
  if (!jid) return { phone: '', name: '' };

  const lidKey = phoneFromJid(jid); // strip @lid or @s.whatsapp.net

  if (isLid(jid)) {
    // LID — only resolvable if we already learned phone→LID for a known phone.
    const phone = lidToPhone.get(lidKey) || '';
    const name = lidToName.get(lidKey) || (phone ? phoneToName.get(phone) || '' : '');
    return { phone, name };
  }

  // Phone-based JID
  const phone = lidKey;
  const name = phoneToName.get(phone) || '';
  const lid = phoneToLid.get(phone);
  if (lid && name) lidToName.set(lid, name);
  return { phone, name };
}

/**
 * Extract mentioned JIDs from the message's context info.
 */
function extractMentions(msg: WAMessage): string[] {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  return ctx?.mentionedJid || [];
}

export async function syncWhatsApp(
  ctx: SyncContext,
  emit: (event: ConnectorDataEvent) => void,
  existingSock?: WaSock,
  onDisconnect?: (reason: string, code: number) => void,
): Promise<{ cursor: string | null; hasMore: boolean; processed: number }> {
  const rawSessionDir = ctx.auth.raw?.sessionDir as string;
  if (!rawSessionDir) throw new Error('No WhatsApp session found');
  const sessionDir = resolveSessionDir(rawSessionDir);
  if (ctx.cursor === WHATSAPP_HISTORY_CURSOR && !existingSock) {
    ctx.logger.info('WhatsApp history already synced; realtime connector handles new messages');
    return { cursor: WHATSAPP_HISTORY_CURSOR, hasMore: false, processed: 0 };
  }

  // Check for missing/deleted session files before attempting connection
  if (!existingSock) {
    const credsPath = join(sessionDir, 'creds.json');
    if (!existsSync(sessionDir) || !existsSync(credsPath)) {
      const reason = 'WhatsApp session files missing — please reconnect (re-scan QR)';
      ctx.logger.error(reason);
      if (onDisconnect) onDisconnect(reason, DisconnectReason.loggedOut);
      throw new Error(reason);
    }
  }

  let sock: WaSock;

  if (existingSock) {
    sock = existingSock;
    ctx.logger.info('Reusing auth socket for first sync (history capture) buffered=yes');
  } else {
    sock = await createSyncSocket(sessionDir, { syncFullHistory: true, logger: ctx.logger });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WhatsApp connection timeout')), 30_000);
      sock.ev.on('connection.update', (update) => {
        logSocketEventBatch(ctx.logger, 'sync:connect', { 'connection.update': update });
        if (update.connection === 'open') {
          clearTimeout(timeout);
          resolve();
        }
        if (update.connection === 'close') {
          const disconnectError = update.lastDisconnect?.error as Boom | Error | undefined;
          const statusCode =
            disconnectError && 'output' in disconnectError
              ? (disconnectError as Boom).output.statusCode
              : 0;
          clearTimeout(timeout);
          // Provide actionable error for connection-phase failures
          const isReplaced = statusCode === DisconnectReason.connectionReplaced;
          const isBadSession = statusCode === DisconnectReason.badSession;
          const isLoggedOut = statusCode === DisconnectReason.loggedOut;
          const reason = isReplaced
            ? 'Another WhatsApp Web session is active — close it and retry sync'
            : isBadSession || isLoggedOut
              ? 'WhatsApp session expired — please reconnect (re-scan QR)'
              : 'WhatsApp connection closed during sync';
          if (onDisconnect) onDisconnect(reason, statusCode);
          reject(new Error(reason));
        }
      });
    });
  }

  const syncStartTime = Date.now();
  const selfJid = sock.user?.id || '';
  const selfPhone = phoneFromJid(selfJid);
  const isFirstSync = !!existingSock;
  const IDLE_TIMEOUT_MS = isFirstSync ? IDLE_TIMEOUT_FIRST_MS : IDLE_TIMEOUT_RESYNC_MS;
  ctx.logger.info(
    `WhatsApp connected as ${selfPhone}, ${isFirstSync ? 'first sync — waiting for history' : 're-sync — short idle timeout'}; idle=${IDLE_TIMEOUT_MS}ms session=${sessionDir}`,
  );

  let processed = 0;
  let historyBatches = 0;

  // Identity resolution maps — seed from previously saved data if available
  const saved = loadIdentityMaps(sessionDir);
  const lidToPhone = saved?.lidToPhone ?? new Map<string, string>();
  const phoneToLid = saved?.phoneToLid ?? new Map<string, string>();
  const phoneToName = saved?.phoneToName ?? new Map<string, string>();
  const lidToName = saved?.lidToName ?? new Map<string, string>();
  const chatNames = new Map<string, string>();
  const groupParticipants = new Map<string, Set<string>>();

  if (saved) {
    ctx.logger.info(
      `Loaded saved identity maps: ${lidToPhone.size} lid→phone, ${phoneToLid.size} phone→lid, ${phoneToName.size} phone→name, ${lidToName.size} lid→name`,
    );
  }

  // Track history message count (no longer buffered — emitted immediately)
  let historyMsgCount = 0;
  const emittedSourceIds = new Set<string>();

  // Use sock.ev.process() for identity/contact/group events — Baileys buffers events
  // during history sync and flushes them as a consolidated map. Individual .on()
  // listeners may miss buffered payloads.
  const handleSocketEvents = async (events: Record<string, any>) => {
    logSocketEventBatch(ctx.logger, 'sync:identity', events);
    // LID → phone mappings
    if (events['chats.phoneNumberShare']) {
      const data = events['chats.phoneNumberShare'];
      if (data.lid && data.jid) {
        rememberPhoneLidMapping(data.jid, data.lid, lidToPhone, phoneToLid);
      }
    }

    // contacts.upsert — Baileys delivers contact info here
    if (events['contacts.upsert']) {
      const contacts = events['contacts.upsert'];
      for (const c of contacts) {
        const id = c.id || '';
        const lid = c.lid || '';
        const name = c.notify || c.name || c.verifiedName || '';

        if (!isLid(id)) {
          const phone = phoneFromJid(id);
          if (phone && name) phoneToName.set(phone, name);
          if (phone && lid) {
            rememberPhoneLidMapping(phone, lid, lidToPhone, phoneToLid);
            if (name) lidToName.set(phoneFromJid(lid), name);
          }
        } else {
          const lidNum = phoneFromJid(id);
          if (name) lidToName.set(lidNum, name);
          if (lid && !isLid(lid)) {
            const phone = phoneFromJid(lid);
            if (phone) {
              rememberPhoneLidMapping(phone, id, lidToPhone, phoneToLid);
              if (name) phoneToName.set(phone, name);
            }
          }
        }
      }
    }

    // contacts.update — carries push name changes
    if (events['contacts.update']) {
      const updates = events['contacts.update'];
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
    }

    // Group participant updates
    if (events['group-participants.update']) {
      const data = events['group-participants.update'];
      const groupJid = data.id;
      if (groupJid) {
        if (!groupParticipants.has(groupJid)) {
          groupParticipants.set(groupJid, new Set());
        }
        const members = groupParticipants.get(groupJid)!;
        for (const p of data.participants || []) {
          if (data.action === 'remove') members.delete(p);
          else members.add(p);
        }
      }
    }
  };

  sock.ev.process(handleSocketEvents);
  ctx.logger.info('WhatsApp registered early identity event processor');
  sock.ev.on('messaging-history.set', (data) => {
    void handleSocketEvents({ 'messaging-history.set': data });
  });
  sock.ev.on('messages.upsert', (upsert) => {
    void handleSocketEvents({ 'messages.upsert': upsert });
  });
  ctx.logger.info('WhatsApp registered direct history/message listeners');

  // Per-chat oldest message tracking for on-demand fetching
  const chatOldest = new Map<string, { key: WAMessageKey; ts: number }>();

  let filteredCount = 0;

  let skippedNullMsg = 0;
  const processMessage = async (msg: WAMessage, source: string, skipMedia = false) => {
    if (!msg.message) {
      skippedNullMsg++;
      return;
    }

    const m = msg.message;
    const msgType = detectMessageType(msg);

    // Skip protocol messages (read receipts, etc.)
    if (msgType.type === 'protocol' || msgType.type === 'reaction') {
      filteredCount++;
      return;
    }

    // Skip ephemeral/view-once media — disappearing content, not persistent memory
    if (
      m.ephemeralMessage ||
      m.viewOnceMessage ||
      m.viewOnceMessageV2 ||
      m.viewOnceMessageV2Extension
    ) {
      filteredCount++;
      ctx.logger.debug(`Noise filtered (ephemeral/view-once): msg ${msg.key?.id}`);
      return;
    }

    // Skip system messages (group setting changes, participant adds/removes, etc.)
    if (m.groupInviteMessage || m.bcallMessage || m.callLogMesssage) {
      filteredCount++;
      ctx.logger.debug(`Noise filtered (system): msg ${msg.key?.id}`);
      return;
    }

    const text = extractText(msg);
    const contactCards = extractContactCards(msg);
    const location = extractLocation(msg);

    // Skip if there's no meaningful content at all
    if (!text && contactCards.length === 0 && !location && msgType.type === 'unknown') {
      filteredCount++;
      ctx.logger.debug(`Message filtered unknown-empty: ${summarizeMessageForLog(msg)}`);
      return;
    }

    const remoteJid = msg.key?.remoteJid || '';

    // Skip WhatsApp Status/Story posts — ephemeral broadcasts, not conversations
    if (remoteJid === 'status@broadcast') {
      filteredCount++;
      ctx.logger.debug(`Message filtered status: ${summarizeMessageForLog(msg)}`);
      return;
    }

    // Apply shared noise filter on extracted text
    if (text && isNoise(text, {})) {
      filteredCount++;
      ctx.logger.debug(`Noise filtered (shared): textLen=${text.length}`);
      return;
    }

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
      const identity = resolveIdentity(
        participantJid,
        lidToPhone,
        phoneToLid,
        phoneToName,
        lidToName,
      );
      senderPhone = identity.phone;
      senderName = identity.name || msg.pushName || msg.verifiedBizName || '';
      if (isLid(participantJid)) senderLid = phoneFromJid(participantJid);
    } else if (!isGroup) {
      // DM — the other person is the remoteJid
      const identity = resolveIdentity(remoteJid, lidToPhone, phoneToLid, phoneToName, lidToName);
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
      const m = resolveIdentity(mJid, lidToPhone, phoneToLid, phoneToName, lidToName);
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

    if (!contextualText) {
      filteredCount++;
      ctx.logger.debug(`Message filtered no-contextual-text: ${summarizeMessageForLog(msg)}`);
      return;
    }

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
        const other = resolveIdentity(otherJid, lidToPhone, phoneToLid, phoneToName, lidToName);
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
    const sourceId = `wa-msg:${msg.key?.id || `${Date.now()}:${processed}`}`;
    if (emittedSourceIds.has(sourceId)) {
      ctx.logger.info(`Message filtered duplicate-in-run sourceId=${sourceId}`);
      return;
    }
    emittedSourceIds.add(sourceId);
    if (emittedSourceIds.size > MESSAGE_STORE_MAX) {
      const first = emittedSourceIds.values().next().value;
      if (first) emittedSourceIds.delete(first);
    }

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

    const event: ConnectorDataEvent = {
      sourceType: 'message',
      sourceId,
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
    };
    ctx.logger.info(
      `Emitting WhatsApp event source=${source} sourceId=${sourceId} type=${msgType.type} textLen=${contextualText.length} participants=${participants.length}`,
    );
    emit(event);
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

    // Detect mid-sync disconnection — keep as .on() since it must fire immediately
    // regardless of event buffering (disconnect is time-critical)
    sock.ev.on('connection.update', (update) => {
      logSocketEventBatch(ctx.logger, 'sync:on', { 'connection.update': update });
      if (update.connection === 'close') {
        const disconnectError = update.lastDisconnect?.error as Boom | Error | undefined;
        const statusCode =
          disconnectError && 'output' in disconnectError
            ? (disconnectError as Boom).output.statusCode
            : 0;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const isBadSession = statusCode === DisconnectReason.badSession;
        const isMultidevice = statusCode === DisconnectReason.multideviceMismatch;
        const isReplaced = statusCode === DisconnectReason.connectionReplaced;

        const reason = isLoggedOut
          ? 'Session logged out from phone — please reconnect (re-scan QR)'
          : isBadSession
            ? 'Session expired or corrupted — please reconnect (re-scan QR)'
            : isMultidevice
              ? 'Multi-device mismatch — please reconnect (re-scan QR)'
              : isReplaced
                ? 'Another WhatsApp Web session is active — close it and retry sync'
                : 'Connection lost during sync';

        ctx.logger.error(`WhatsApp disconnected during sync: ${reason} (code ${statusCode})`);
        disconnectedDuringSync = true;
        disconnectReason = reason;
        if (onDisconnect) onDisconnect(reason, statusCode);
        finish();
      }
    });

    // Use sock.ev.process() for history and message handlers — Baileys buffers events
    // during history sync and flushes them as a consolidated map. Individual .on()
    // listeners may miss buffered history payloads.
    ctx.logger.info('WhatsApp passive history phase registering sync event processor');
    sock.ev.process(async (events) => {
      logSocketEventBatch(ctx.logger, 'sync:process', events);
      // History sync — index contacts, process messages immediately
      if (events['messaging-history.set']) {
        const data = events['messaging-history.set'];
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
              rememberPhoneLidMapping(phone, contactLid, lidToPhone, phoneToLid);
              if (name) lidToName.set(phoneFromJid(contactLid), name);
            }
          } else {
            const lidNum = phoneFromJid(contactId);
            if (name) lidToName.set(lidNum, name);
            if (contactLid && !isLid(contactLid)) {
              const phone = phoneFromJid(contactLid);
              if (phone) {
                rememberPhoneLidMapping(phone, contactId, lidToPhone, phoneToLid);
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

        // Diagnostic: count messages with null .message (protocol-level decrypt failure)
        let nullMsgCount = 0;
        for (const msg of messages) {
          if (!msg.message) nullMsgCount++;
        }

        ctx.logger.info(
          `History batch #${historyBatches}: ${messages.length} msgs (${nullMsgCount} null/undecrypted), ${chats.length} chats, ${contacts.length} contacts (progress: ${progress})`,
        );
        ctx.logger.info(
          `Identity maps: ${lidToPhone.size} lid→phone, ${phoneToName.size} phone→name, ${lidToName.size} lid→name, ${chatNames.size} chats`,
        );

        // Process history messages immediately — emit as they arrive
        const beforeProcessed = processed;
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
          await processMessage(msg, 'history');
        }
        const emittedThisBatch = processed - beforeProcessed;
        if (messages.length > 0) {
          ctx.logger.info(
            `History batch #${historyBatches} result: ${emittedThisBatch} emitted, ${messages.length - nullMsgCount - emittedThisBatch} filtered, ${nullMsgCount} undecrypted`,
          );
        }

        resetIdle();
      }

      // Real-time + offline messages — process immediately (identity maps are warm)
      if (events['messages.upsert']) {
        const upsert = events['messages.upsert'];
        const msgs = upsert.messages || [];
        const type = upsert.type === 'notify' ? 'realtime' : 'append';
        ctx.logger.info(`messages.upsert: ${msgs.length} msgs, type=${upsert.type}`);
        if (type === 'realtime') {
          ctx.logger.info(
            `Skipping ${msgs.length} realtime WhatsApp upsert messages during history sync; they can be stale reconnect replays`,
          );
          resetIdle();
          return;
        }
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
          await processMessage(msg, type);
        }
        resetIdle();
      }
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
    saveIdentityMaps(sessionDir, { lidToPhone, phoneToLid, phoneToName, lidToName });
    throw new Error(`WhatsApp session disconnected: ${disconnectReason}`);
  }

  // Load group chat IDs before on-demand fetching so a quiet passive history
  // phase still has chats to scroll backwards through.
  try {
    ctx.logger.info('Fetching group metadata before on-demand history...');
    const groups: Record<string, GroupMetadata> = await sock.groupFetchAllParticipating();
    let totalParticipants = 0;
    for (const [groupJid, meta] of Object.entries(groups)) {
      if (meta.subject) chatNames.set(groupJid, meta.subject);
      const participants = meta.participants || [];
      totalParticipants += participants.length;
      if (!groupParticipants.has(groupJid)) groupParticipants.set(groupJid, new Set());
      const memberSet = groupParticipants.get(groupJid)!;
      for (const p of participants) {
        if (p.id) memberSet.add(p.id);
      }
    }
    ctx.logger.info(
      `Preloaded ${Object.keys(groups).length} WhatsApp groups for on-demand history (${totalParticipants} participants)`,
    );
  } catch (err: unknown) {
    ctx.logger.info(
      `pre-fetch group metadata failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // --- Phase 2: On-demand per-chat history fetching ---
  // After passive history stops, iterate through chats and request older messages.
  // Also include chats discovered from bootstrap/groups that have no seed messages yet.
  const allKnownChats = new Set([...chatOldest.keys(), ...chatNames.keys()]);
  const hasChatsToFetch = allKnownChats.size > 0;

  if (!ctx.signal.aborted && hasChatsToFetch && typeof sock.fetchMessageHistory === 'function') {
    const elapsedMs = Date.now() - syncStartTime;
    const remainingMs = MAX_SYNC_MS - elapsedMs;

    // Build fetch list: chats with seed messages + chats from bootstrap without seeds
    const chatsToFetch: Array<[string, { key: WAMessageKey; ts: number } | null]> = [];
    for (const jid of allKnownChats) {
      if (jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) continue;
      const oldest = chatOldest.get(jid) || null;
      chatsToFetch.push([jid, oldest]);
    }
    // Sort: seeded chats first, then unseeded
    chatsToFetch.sort((a, b) => (a[1] ? 0 : 1) - (b[1] ? 0 : 1));

    ctx.logger.info(
      `On-demand fetching: ${chatsToFetch.length} chats (${chatOldest.size} seeded, ${chatsToFetch.length - chatOldest.size} from bootstrap) (${remainingMs / 1000}s budget)`,
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

      // Use seed message key if available, else fresh key for bootstrap-only chats
      let currentKey: WAMessageKey =
        oldest?.key || ({ remoteJid: chatJid, fromMe: false, id: '' } as WAMessageKey);
      let currentTs = oldest?.ts || 0;

      for (let round = 0; round < ON_DEMAND_ROUNDS_PER_CHAT; round++) {
        // Jitter between fetches to mimic natural scrolling
        await jitter(500, 2000);

        const beforeCount = processed;
        try {
          await Promise.race([
            sock.fetchMessageHistory(ON_DEMAND_MSGS_PER_FETCH, currentKey, currentTs),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error('fetchMessageHistory timed out')),
                ON_DEMAND_FETCH_TIMEOUT_MS,
              ),
            ),
          ]);
        } catch (err: unknown) {
          ctx.logger.info(
            `fetchMessageHistory failed for ${chatJid}: ${err instanceof Error ? err.message : String(err)}`,
          );
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
    const groups: Record<string, GroupMetadata> = await sock.groupFetchAllParticipating();
    let totalParticipants = 0;
    const allGroupLids = new Set<string>();

    for (const [groupJid, meta] of Object.entries(groups)) {
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
  } catch (err: unknown) {
    ctx.logger.info(
      `groupFetchAllParticipating failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  await resolveKnownPhonesToLids(
    sock,
    [selfPhone, ...phoneToName.keys(), ...lidToPhone.values()],
    lidToPhone,
    phoneToLid,
    (level, message) => ctx.logger[level](message),
  );

  // LID identity resolution status
  // WhatsApp does not expose LID→phone lookup. We resolve known phone numbers to
  // LIDs, then use that local reverse map to attach phone identities to group LIDs.
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
  saveIdentityMaps(sessionDir, { lidToPhone, phoneToLid, phoneToName, lidToName });
  ctx.logger.info(
    `Identity maps before processing: ${lidToPhone.size} lid→phone, ${phoneToLid.size} phone→lid, ${phoneToName.size} phone→name, ${lidToName.size} lid→name`,
  );

  // Emit contact events for all resolved identities
  emitContactEvents(
    ctx,
    emit,
    selfPhone,
    phoneToName,
    lidToPhone,
    phoneToLid,
    lidToName,
    chatNames,
    groupParticipants,
  );

  // Flush any pending atomic auth state writes before closing the socket
  await flushPendingWrites();

  try {
    sock.ws?.close();
  } catch {
    /* ignore */
  }

  ctx.logger.info(
    `Synced ${processed} WhatsApp messages from ${historyBatches} history batches (${skippedNullMsg} undecrypted, ${filteredCount} noise filtered, ${lidToPhone.size} lid→phone, ${phoneToLid.size} phone→lid, ${phoneToName.size} phone→name, ${chatNames.size} chats)`,
  );
  return { cursor: WHATSAPP_HISTORY_CURSOR, hasMore: false, processed };
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
  phoneToLid: Map<string, string>,
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
      sourceType: 'contact',
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
      sourceType: 'contact',
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
    const memberLids: string[] = [];
    const memberJids: string[] = [];
    if (members) {
      for (const jid of members) {
        memberJids.push(jid);
        if (isLid(jid)) memberLids.push(phoneFromJid(jid));
        const identity = resolveIdentity(jid, lidToPhone, phoneToLid, phoneToName, lidToName);
        if (identity.phone) memberPhones.push(identity.phone);
      }
    }
    const uniqueMemberPhones = [...new Set(memberPhones)];
    const uniqueMemberLids = [...new Set(memberLids)];
    const uniqueMemberJids = [...new Set(memberJids)];

    emit({
      sourceType: 'contact',
      sourceId: `wa-group:${groupJid}`,
      timestamp: new Date().toISOString(),
      content: {
        text: `WhatsApp group: ${groupName} (${uniqueMemberPhones.length} known phone members, ${uniqueMemberLids.length} LID members)`,
        participants: uniqueMemberPhones,
        metadata: {
          type: 'contact',
          name: groupName,
          isGroup: true,
          groupJid,
          memberCount: uniqueMemberJids.length || uniqueMemberPhones.length,
          memberPhones: uniqueMemberPhones,
          memberLids: uniqueMemberLids,
          memberJids: uniqueMemberJids,
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

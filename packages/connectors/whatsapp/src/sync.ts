import { makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { SyncContext, ConnectorDataEvent } from '@botmem/connector-sdk';

/** Track decrypt failures to surface re-auth warnings */
let decryptFailCount = 0;
let decryptFailResetTimer: ReturnType<typeof setTimeout> | null = null;
const DECRYPT_FAIL_THRESHOLD = 5;
const DECRYPT_FAIL_WINDOW = 60_000;

let onDecryptFailure: ((count: number) => void) | null = null;

export function setDecryptFailureCallback(cb: (count: number) => void) {
  onDecryptFailure = cb;
}

const logger = pino({
  level: 'warn',
  hooks: {
    logMethod(inputArgs: any[], method: any) {
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
      method.apply(this, inputArgs);
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
  if (m.documentMessage) return { type: 'document', mimeType: m.documentMessage.mimetype, fileName: m.documentMessage.fileName };
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
    return [{
      displayName: m.contactMessage.displayName || '',
      vcard: m.contactMessage.vcard || '',
    }];
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
function extractLocation(msg: any): { lat: number; lng: number; name?: string; address?: string } | null {
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

/** Persist identity maps to the session directory so re-syncs can reuse them */
function saveIdentityMaps(sessionDir: string, maps: {
  lidToPhone: Map<string, string>;
  phoneToName: Map<string, string>;
  lidToName: Map<string, string>;
}) {
  try {
    const data = {
      lidToPhone: Object.fromEntries(maps.lidToPhone),
      phoneToName: Object.fromEntries(maps.phoneToName),
      lidToName: Object.fromEntries(maps.lidToName),
    };
    writeFileSync(join(sessionDir, 'identity-maps.json'), JSON.stringify(data));
  } catch { /* non-critical */ }
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
  } catch { return null; }
}

// Emit data as it arrives — don't block waiting for more history
const MAX_SYNC_MS = 10 * 60_000;  // 10 minutes hard deadline
const IDLE_TIMEOUT_FIRST_MS = 30_000; // 30 seconds — process what we have, don't wait forever
const IDLE_TIMEOUT_RESYNC_MS = 15_000; // 15 seconds for re-syncs

type WaSock = ReturnType<typeof makeWASocket>;

async function createSyncSocket(sessionDir: string): Promise<WaSock> {
  mkdirSync(sessionDir, { recursive: true });
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
  const ctx = msg.message?.extendedTextMessage?.contextInfo ||
    msg.message?.conversation?.contextInfo;
  return ctx?.mentionedJid || [];
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
        ctx.logger.info(`connection.update: ${JSON.stringify(update)}`);
        if (update.connection === 'open') { clearTimeout(timeout); resolve(); }
        if (update.connection === 'close') { clearTimeout(timeout); reject(new Error('WhatsApp connection closed during sync')); }
      });
    });
  }

  const selfJid = (sock as any).user?.id || '';
  const selfPhone = phoneFromJid(selfJid);
  const isFirstSync = !!existingSock;
  const IDLE_TIMEOUT_MS = isFirstSync ? IDLE_TIMEOUT_FIRST_MS : IDLE_TIMEOUT_RESYNC_MS;
  ctx.logger.info(`WhatsApp connected as ${selfPhone}, ${isFirstSync ? 'first sync — waiting for history' : 're-sync — short idle timeout'}...`);

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
    ctx.logger.info(`Loaded saved identity maps: ${lidToPhone.size} lid→phone, ${phoneToName.size} phone→name, ${lidToName.size} lid→name`);
  }

  // Buffer history messages — process them at the end after all identity maps are populated
  const bufferedMessages: Array<{ msg: any; source: string }> = [];

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
    for (const p of (data.participants || [])) {
      if (data.action === 'remove') members.delete(p);
      else members.add(p);
    }
  });

  let oldestTimestamp = Math.floor(Date.now() / 1000);
  let oldestMsgKey: any = null;

  const processMessage = (msg: any, source: string) => {
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
    const senderLabel = buildSenderLabel(senderName, senderPhone, isGroup);

    let contextualText = '';

    if (text) {
      if (isGroup && chatName) {
        contextualText = `[${chatName}] ${senderLabel}: ${text}`;
      } else {
        contextualText = `${senderLabel}: ${text}`;
      }
    }

    // Handle special message types that may not have text
    if (msgType.type === 'image' && !text) {
      contextualText = `${senderLabel} sent an image`;
      if (isGroup && chatName) contextualText = `[${chatName}] ${contextualText}`;
    } else if (msgType.type === 'video' && !text) {
      contextualText = `${senderLabel} sent a video`;
      if (isGroup && chatName) contextualText = `[${chatName}] ${contextualText}`;
    } else if (msgType.type === 'audio') {
      contextualText = `${senderLabel} sent a voice message`;
      if (isGroup && chatName) contextualText = `[${chatName}] ${contextualText}`;
    } else if (msgType.type === 'document') {
      const fname = msgType.fileName || 'a document';
      contextualText = `${senderLabel} sent ${fname}`;
      if (text) contextualText += `: ${text}`;
      if (isGroup && chatName) contextualText = `[${chatName}] ${contextualText}`;
    } else if (msgType.type === 'sticker' && !text) {
      contextualText = `${senderLabel} sent a sticker`;
      if (isGroup && chatName) contextualText = `[${chatName}] ${contextualText}`;
    } else if (msgType.type === 'contact_card') {
      const names = contactCards.map((c) => c.displayName).filter(Boolean).join(', ');
      contextualText = `${senderLabel} shared contact${contactCards.length > 1 ? 's' : ''}: ${names}`;
      if (isGroup && chatName) contextualText = `[${chatName}] ${contextualText}`;
    } else if (location) {
      const locLabel = location.name || location.address || `${location.lat},${location.lng}`;
      contextualText = `${senderLabel} shared location: ${locLabel}`;
      if (isGroup && chatName) contextualText = `[${chatName}] ${contextualText}`;
    }

    if (!contextualText) return;

    // Replace @mentions in text with resolved names
    for (const m of mentions) {
      const mLabel = m.name ? `${m.name} (+${m.phone})` : `+${m.phone}`;
      if (m.phone) {
        contextualText = contextualText.replace(
          new RegExp(`@${m.phone}\\b`, 'g'),
          `@${mLabel}`,
        );
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
          const normalized = p.replace(/^\+/, '');
          if (!participants.includes(normalized)) {
            participants.push(normalized);
          }
        }
      }
    }

    // Build attachment metadata
    const attachments: Array<{ mimeType: string; type: string; fileName?: string }> = [];
    if (msgType.type !== 'text' && msgType.type !== 'contact_card' && msgType.type !== 'location' && msgType.mimeType) {
      attachments.push({
        type: msgType.type,
        mimeType: msgType.mimeType,
        ...(msgType.fileName && { fileName: msgType.fileName }),
      });
    }

    const msgTs = Number(msg.messageTimestamp || 0);

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
        },
      },
    });
    processed++;
  };

  await new Promise<void>((resolve) => {
    let idleTimer: ReturnType<typeof setTimeout>;
    let finished = false;
    let fetchHistoryAttempts = 0;
    const MAX_FETCH_ATTEMPTS = 2;
    let lastBufferedCount = 0;

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(idleTimer);
      clearTimeout(deadline);
      resolve();
    };

    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(async () => {
        // Only try fetchMessageHistory if we haven't exhausted attempts
        // and new messages actually arrived since last attempt
        const newMessages = bufferedMessages.length > lastBufferedCount;
        if (newMessages) {
          fetchHistoryAttempts = 0; // Reset if we got new data
        }

        if (oldestMsgKey && fetchHistoryAttempts < MAX_FETCH_ATTEMPTS && typeof (sock as any).fetchMessageHistory === 'function') {
          fetchHistoryAttempts++;
          lastBufferedCount = bufferedMessages.length;
          ctx.logger.info(`Idle timeout — requesting more history before oldest msg (${new Date(oldestTimestamp * 1000).toISOString()}) attempt ${fetchHistoryAttempts}/${MAX_FETCH_ATTEMPTS}`);
          try {
            await (sock as any).fetchMessageHistory(50, oldestMsgKey, oldestTimestamp);
            resetIdle();
            return;
          } catch (err: any) {
            ctx.logger.info(`fetchMessageHistory failed: ${err.message} — finishing`);
          }
        }
        ctx.logger.info(`No new data for ${IDLE_TIMEOUT_MS / 1000}s, finishing (${bufferedMessages.length} buffered msgs)`);
        finish();
      }, IDLE_TIMEOUT_MS);
    };

    const deadline = setTimeout(() => {
      ctx.logger.info(`Sync hard deadline reached (${MAX_SYNC_MS / 1000}s)`);
      finish();
    }, MAX_SYNC_MS);

    if (ctx.signal.aborted) { finish(); return; }
    ctx.signal.addEventListener('abort', finish, { once: true });

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

      ctx.logger.info(`History batch #${historyBatches}: ${messages.length} msgs, ${chats.length} chats, ${contacts.length} contacts (progress: ${progress})`);
      ctx.logger.info(`Identity maps: ${lidToPhone.size} lid→phone, ${phoneToName.size} phone→name, ${lidToName.size} lid→name, ${chatNames.size} chats`);

      // Buffer history messages — process after all batches arrive for best identity resolution
      let sampleGroupMsg = false;
      for (const msg of messages) {
        const msgTs = Number(msg.messageTimestamp || 0);
        if (msgTs > 0 && msgTs < oldestTimestamp) {
          oldestTimestamp = msgTs;
          oldestMsgKey = msg.key;
        }
        bufferedMessages.push({ msg, source: 'history' });

        // Debug: log a sample group message to see available fields
        const participantJid = msg.key?.participant || msg.participant || '';
        if (!sampleGroupMsg && participantJid && isLid(participantJid) && historyBatches === 1) {
          ctx.logger.info(`Sample LID msg: participant=${participantJid} pushName=${msg.pushName || '(none)'} verifiedBizName=${msg.verifiedBizName || '(none)'} keys=${Object.keys(msg).join(',')}`);
          sampleGroupMsg = true;
        }
      }

      resetIdle();
    });

    // Real-time + offline messages — process immediately (identity maps are warm)
    sock.ev.on('messages.upsert', (upsert: any) => {
      const msgs = upsert.messages || [];
      const type = upsert.type === 'notify' ? 'realtime' : 'append';
      ctx.logger.info(`messages.upsert: ${msgs.length} msgs, type=${upsert.type}`);
      for (const msg of msgs) {
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
    ctx.logger.info(`Group metadata: ${Object.keys(groups).length} groups, ${totalParticipants} participants, ${allGroupLids.size} unique LIDs`);
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
    ctx.logger.info(`Unresolved LIDs: ${unresolvedCount} (from ${groupParticipants.size} groups). LID→phone mapping requires real-time messages.`);
  }

  // Save identity maps for future re-syncs
  saveIdentityMaps(sessionDir, { lidToPhone, phoneToName, lidToName });
  ctx.logger.info(`Identity maps before processing: ${lidToPhone.size} lid→phone, ${phoneToName.size} phone→name, ${lidToName.size} lid→name`);

  // Process all buffered history messages now that identity maps are fully populated
  ctx.logger.info(`Processing ${bufferedMessages.length} buffered history messages with ${lidToPhone.size} lid→phone, ${phoneToName.size} phone→name mappings`);
  for (const { msg, source } of bufferedMessages) {
    processMessage(msg, source);
  }

  // Emit contact events for all resolved identities
  emitContactEvents(ctx, emit, selfPhone, phoneToName, lidToPhone, lidToName, chatNames, groupParticipants);

  try { sock.ws?.close(); } catch { /* ignore */ }

  ctx.logger.info(`Synced ${processed} WhatsApp messages from ${historyBatches} history batches (${lidToPhone.size} lid→phone, ${phoneToName.size} phone→name, ${chatNames.size} chats)`);
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

  ctx.logger.info(`Emitted ${emittedPhones.size} contact events and ${chatNames.size} group events`);
}

function buildSenderLabel(name: string, phone: string, isGroup?: boolean): string {
  if (name && phone && name !== phone) {
    return `${name} (+${phone})`;
  }
  if (phone) {
    return `+${phone}`;
  }
  if (name) {
    return name;
  }
  return isGroup ? 'A member' : 'Someone';
}

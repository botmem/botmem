import type {
  ConnectorDataEvent,
  ConnectorRealtimeContext,
  ConnectorRealtimeHandle,
  SyncContext,
} from '@botmem/connector-sdk';
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js';
import { createClientFromSession } from './auth.js';

interface DialogCursors {
  [dialogId: string]: number;
}

type TelegramEntity = Record<string, unknown>;
type TelegramMessage = {
  id: number;
  message?: string;
  media?: unknown;
  date?: number;
  out?: boolean;
  getSender?: () => Promise<TelegramEntity | undefined>;
  peerId?: Record<string, unknown>;
};

function jitter(min: number, max: number): Promise<void> {
  const ms = min + Math.random() * (max - min);
  return new Promise((r) => setTimeout(r, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withRetries<T>(
  action: () => Promise<T>,
  ctx: SyncContext,
  label: string,
  attempts = 3,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await action();
    } catch (err) {
      lastError = err;
      if (attempt >= attempts) break;
      const delay = 1000 * attempt;
      ctx.logger.warn(
        `${label} failed on attempt ${attempt}/${attempts}: ${err instanceof Error ? err.message : String(err)}; retrying in ${delay}ms`,
      );
      await jitter(delay, delay + 500);
    }
  }
  throw lastError instanceof Error
    ? new Error(`Telegram ${label} failed after ${attempts} attempts: ${lastError.message}`, {
        cause: lastError,
      })
    : new Error(`Telegram ${label} failed after ${attempts} attempts`);
}

function entityName(entity: TelegramEntity | undefined): string {
  if (!entity) return '';
  return (
    [entity.firstName as string | undefined, entity.lastName as string | undefined]
      .filter(Boolean)
      .join(' ') ||
    (entity.username as string | undefined) ||
    ''
  );
}

function peerIdFromMessage(msg: TelegramMessage): string {
  const peer = msg.peerId || {};
  return (
    (peer.channelId as { toString?: () => string } | undefined)?.toString?.() ||
    (peer.chatId as { toString?: () => string } | undefined)?.toString?.() ||
    (peer.userId as { toString?: () => string } | undefined)?.toString?.() ||
    ''
  );
}

async function buildTelegramMessageEvent(
  msg: TelegramMessage,
  options: {
    chatId: string;
    chatName?: string;
    isGroup?: boolean;
  },
): Promise<ConnectorDataEvent | null> {
  if (!msg.message && !msg.media) return null;

  const sender = await msg.getSender?.();
  if (sender?.bot === true) return null;

  const senderPhone = sender?.phone as string | undefined;
  const senderUsername = sender?.username as string | undefined;
  const senderName = entityName(sender);
  const senderId = sender?.id?.toString() || '';
  const participants: string[] = [];
  if (senderPhone) participants.push(senderPhone);
  else if (senderUsername) participants.push(senderUsername);

  const timestamp =
    typeof msg.date === 'number' && msg.date > 0
      ? new Date(msg.date * 1000).toISOString()
      : new Date().toISOString();

  return {
    sourceType: 'message',
    sourceId: `telegram:${options.chatId}:${msg.id}`,
    timestamp,
    content: {
      text: msg.message || '[media]',
      participants,
      metadata: {
        chatId: options.chatId,
        chatName: options.chatName || '',
        isGroup: options.isGroup || false,
        fromMe: msg.out || false,
        senderId,
        senderPhone: senderPhone || undefined,
        senderName: senderName || undefined,
        senderUsername: senderUsername || undefined,
        messageType: msg.media ? 'media' : 'text',
      },
    },
  };
}

/**
 * Sync messages and contacts from Telegram.
 */
export async function syncTelegram(
  ctx: SyncContext,
  emitData: (event: ConnectorDataEvent) => boolean,
): Promise<{ cursor: string | null; hasMore: boolean; processed: number }> {
  const session = ctx.auth.raw?.session as string;
  if (!session) throw new Error('No Telegram session — please re-authenticate');

  const client = createClientFromSession(session);
  await Promise.race([
    client.connect(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Telegram connection timed out after 60s')), 60_000),
    ),
  ]);

  let processed = 0;
  const cursors: DialogCursors = ctx.cursor ? JSON.parse(ctx.cursor) : {};
  let hasMore = false;

  try {
    // Phase 1: Dialogs + Messages
    ctx.logger.info('Phase 1: Fetching dialogs...');
    const dialogs = await withRetries(
      () =>
        withTimeout(client.getDialogs({}), 120_000, 'Telegram dialog fetch timed out after 120s'),
      ctx,
      'dialog fetch',
    );
    ctx.logger.info(`Found ${dialogs.length} dialogs`);

    for (const dialog of dialogs) {
      if (ctx.signal.aborted) break;

      const entity = dialog.entity as Record<string, unknown> | undefined;
      if (!entity) continue;

      // Skip broadcast channels and bot conversations
      const isBroadcast = (entity as Record<string, unknown>).broadcast === true;
      if (isBroadcast) continue;
      const isBot = (entity as Record<string, unknown>).bot === true;
      if (isBot) continue;

      const dialogId = String(dialog.id);
      const minId = cursors[dialogId] || 0;
      let maxFetchedId = minId;

      try {
        const messages = await client.getMessages(dialog.entity, {
          limit: 100,
          minId,
        });

        for (const msg of messages) {
          if (ctx.signal.aborted) break;
          if (!msg.message && !msg.media) continue;

          const msgId = msg.id;
          if (msgId > maxFetchedId) maxFetchedId = msgId;

          const isGroup = dialog.isGroup || dialog.isChannel;
          const chatName = dialog.title || '';

          // Build media metadata
          let fileBase64: string | undefined;
          let mimetype: string | undefined;
          let fileName: string | undefined;
          if (msg.media) {
            try {
              const buffer = (await client.downloadMedia(msg.media, {})) as Buffer | undefined;
              if (buffer && buffer.length <= 20 * 1024 * 1024) {
                fileBase64 = buffer.toString('base64');
                mimetype =
                  ((msg.media as unknown as Record<string, unknown>)?.mimeType as string) ||
                  'application/octet-stream';
                fileName =
                  ((msg.media as unknown as Record<string, unknown>)?.fileName as string) ||
                  undefined;
              }
            } catch {
              // Media download failed — skip
            }
          }

          const event = await buildTelegramMessageEvent(msg as unknown as TelegramMessage, {
            chatId: dialogId,
            chatName,
            isGroup,
          });
          if (!event) continue;
          if (fileBase64) Object.assign(event.content.metadata, { fileBase64, mimetype, fileName });

          emitData(event);
          processed++;
        }

        if (messages.length === 100) hasMore = true;
      } catch (err: unknown) {
        const errMsg = (err as { errorMessage?: string })?.errorMessage || '';
        if (errMsg === 'FLOOD_WAIT' || errMsg.startsWith('FLOOD_WAIT_')) {
          const seconds = parseInt(errMsg.split('_').pop() || '30', 10);
          ctx.logger.warn(`FLOOD_WAIT: sleeping ${seconds}s + jitter`);
          await jitter(seconds * 1000, seconds * 1000 + 5000);
          continue;
        }
        ctx.logger.warn(`Error fetching dialog ${dialogId}: ${errMsg || String(err)}`);
      }

      if (maxFetchedId > minId) {
        cursors[dialogId] = maxFetchedId;
      }

      // Jitter between dialogs
      await jitter(500, 2000);
    }

    // Phase 2: Contacts
    if (!ctx.signal.aborted) {
      ctx.logger.info('Phase 2: Fetching contacts...');
      try {
        const { Api } = await import('telegram/tl/index.js');
        const result = await client.invoke(
          new Api.contacts.GetContacts({ hash: 0 as unknown as import('big-integer').BigInteger }),
        );
        const contacts =
          ((result as unknown as Record<string, unknown>).users as Array<
            Record<string, unknown>
          >) || [];
        ctx.logger.info(`Found ${contacts.length} contacts`);

        for (const contact of contacts) {
          if (ctx.signal.aborted) break;
          // Skip bot contacts
          if (contact.bot === true) continue;

          const phone = contact.phone as string | undefined;
          const firstName = contact.firstName as string | undefined;
          const lastName = contact.lastName as string | undefined;
          const username = contact.username as string | undefined;
          const userId = contact.id?.toString() || '';
          const displayName =
            [firstName, lastName].filter(Boolean).join(' ') || username || phone || '';

          if (!displayName) continue;

          const contactEvent: ConnectorDataEvent = {
            sourceType: 'message',
            sourceId: `telegram:contact:${userId}`,
            timestamp: new Date().toISOString(),
            content: {
              text: '',
              participants: phone ? [phone] : [],
              metadata: {
                type: 'contact',
                name: displayName,
                firstName: firstName || undefined,
                lastName: lastName || undefined,
                phone: phone || undefined,
                username: username || undefined,
                telegramId: userId,
              },
            },
          };

          emitData(contactEvent);
          processed++;
        }
      } catch (err: unknown) {
        ctx.logger.warn(
          `Failed to fetch contacts: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } finally {
    await client.disconnect().catch(() => {});
  }

  return {
    cursor: JSON.stringify(cursors),
    hasMore,
    processed,
  };
}

export async function startTelegramRealtime(
  ctx: ConnectorRealtimeContext,
): Promise<ConnectorRealtimeHandle> {
  const session = ctx.auth.raw?.session as string;
  if (!session) throw new Error('No Telegram session — please re-authenticate');

  const client = createClientFromSession(session);
  await Promise.race([
    client.connect(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Telegram connection timed out after 60s')), 60_000),
    ),
  ]);

  let stopped = false;
  await ctx.onConnected?.();

  const handler = async (event: NewMessageEvent) => {
    if (stopped) return;
    try {
      const msg = event.message as unknown as TelegramMessage;
      const chat = (await event.getChat()) as TelegramEntity | undefined;
      const chatId = event.chatId?.toString() || peerIdFromMessage(msg);
      if (!chatId) return;

      const connectorEvent = await buildTelegramMessageEvent(msg, {
        chatId,
        chatName: (chat?.title as string | undefined) || entityName(chat),
        isGroup: event.isGroup || event.isChannel,
      });
      if (connectorEvent) await ctx.emitData(connectorEvent);
    } catch (err) {
      ctx.logger.warn(
        `Telegram realtime event failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const eventBuilder = new NewMessage({});
  client.addEventHandler(handler, eventBuilder);
  ctx.signal.addEventListener(
    'abort',
    () => {
      stopped = true;
      client.removeEventHandler(handler, eventBuilder);
      client.disconnect().catch(() => undefined);
    },
    { once: true },
  );

  return {
    async stop() {
      stopped = true;
      client.removeEventHandler(handler, eventBuilder);
      await client.disconnect().catch(() => undefined);
    },
  };
}

import type { SyncContext, ConnectorDataEvent } from '@botmem/connector-sdk';
import { createClientFromSession } from './auth.js';

interface DialogCursors {
  [dialogId: string]: number;
}

function jitter(min: number, max: number): Promise<void> {
  const ms = min + Math.random() * (max - min);
  return new Promise((r) => setTimeout(r, ms));
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
  await client.connect();

  let processed = 0;
  const cursors: DialogCursors = ctx.cursor ? JSON.parse(ctx.cursor) : {};
  let hasMore = false;

  try {
    // Phase 1: Dialogs + Messages
    ctx.logger.info('Phase 1: Fetching dialogs...');
    const dialogs = await client.getDialogs({});
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

          const sender = await msg.getSender();
          const senderData = sender as Record<string, unknown> | undefined;
          // Skip messages from bots
          if (senderData?.bot === true) continue;
          const senderPhone = senderData?.phone as string | undefined;
          const senderName =
            [
              senderData?.firstName as string | undefined,
              senderData?.lastName as string | undefined,
            ]
              .filter(Boolean)
              .join(' ') ||
            (senderData?.username as string | undefined) ||
            '';
          const senderUsername = senderData?.username as string | undefined;
          const senderId = senderData?.id?.toString() || '';

          const isGroup = dialog.isGroup || dialog.isChannel;
          const chatName = dialog.title || '';

          const participants: string[] = [];
          if (senderPhone) participants.push(senderPhone);
          else if (senderUsername) participants.push(senderUsername);

          // Build media metadata
          let fileBase64: string | undefined;
          let fileMimeType: string | undefined;
          if (msg.media) {
            try {
              const buffer = (await client.downloadMedia(msg.media, {})) as Buffer | undefined;
              if (buffer && buffer.length <= 20 * 1024 * 1024) {
                fileBase64 = buffer.toString('base64');
                fileMimeType =
                  ((msg.media as unknown as Record<string, unknown>)?.mimeType as string) ||
                  'application/octet-stream';
              }
            } catch {
              // Media download failed — skip
            }
          }

          const event: ConnectorDataEvent = {
            sourceType: 'message',
            sourceId: `telegram:${dialogId}:${msgId}`,
            timestamp: new Date((msg.date || 0) * 1000).toISOString(),
            content: {
              text: msg.message || '[media]',
              participants,
              metadata: {
                chatId: dialogId,
                chatName,
                isGroup,
                fromMe: msg.out || false,
                senderId,
                senderPhone: senderPhone || undefined,
                senderName: senderName || undefined,
                senderUsername: senderUsername || undefined,
                messageType: msg.media ? 'media' : 'text',
                ...(fileBase64 && { fileBase64, fileMimeType }),
              },
            },
          };

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

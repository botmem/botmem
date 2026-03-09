import { BaseConnector } from '@botmem/connector-sdk';
import type {
  ConnectorManifest,
  AuthContext,
  AuthInitResult,
  SyncContext,
  SyncResult,
  ConnectorDataEvent,
  EmbedResult,
  PipelineContext,
} from '@botmem/connector-sdk';
import { ImsgClient } from './imsg-client.js';

const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 19876;
const PROGRESS_INTERVAL = 50; // emit progress every N messages

export class IMessageConnector extends BaseConnector {
  readonly manifest: ConnectorManifest = {
    id: 'imessage',
    name: 'iMessage',
    description: 'Import iMessage conversations via imsg RPC bridge',
    color: '#4ECDC4',
    icon: 'smartphone',
    authType: 'local-tool',
    configSchema: {
      type: 'object',
      required: ['myIdentifier'],
      properties: {
        myIdentifier: {
          type: 'string',
          title: 'Your Email or Phone',
          description:
            'Your iMessage email or phone number (used to identify you in conversations)',
        },
        imsgHost: {
          type: 'string',
          title: 'imsg Bridge Host',
          description: 'Hostname or IP of the machine running the imsg RPC bridge',
          default: DEFAULT_HOST,
        },
        imsgPort: {
          type: 'number',
          title: 'imsg Bridge Port',
          description: 'TCP port the imsg RPC bridge is listening on',
          default: DEFAULT_PORT,
        },
      },
    },
    entities: ['person', 'message'],
    pipeline: { clean: false, embed: true, enrich: true },
    trustScore: 0.8,
  };

  embed(event: ConnectorDataEvent, cleanedText: string, ctx: PipelineContext): EmbedResult {
    const entities: EmbedResult['entities'] = [];
    const metadata = event.content?.metadata || {};
    const participants = event.content?.participants || [];
    const isFromMe = metadata.isFromMe as boolean | undefined;
    const myIdentifier = ctx.auth.raw?.myIdentifier as string | undefined;

    // Resolve "me" as sender
    if (myIdentifier && isFromMe) {
      if (myIdentifier.includes('@')) {
        entities.push({ type: 'person', id: `email:${myIdentifier}`, role: 'sender' });
      } else {
        entities.push({ type: 'person', id: `phone:${myIdentifier}`, role: 'sender' });
      }
    }

    // Resolve each participant
    for (const participant of participants) {
      if (!participant) continue;
      if (myIdentifier && participant === myIdentifier) continue;

      if (participant.includes('@')) {
        entities.push({
          type: 'person',
          id: `email:${participant}`,
          role: isFromMe ? 'recipient' : 'sender',
        });
      } else {
        entities.push({
          type: 'person',
          id: `phone:${participant}`,
          role: isFromMe ? 'recipient' : 'sender',
        });
      }
    }

    return { text: cleanedText, entities };
  }

  async initiateAuth(config: Record<string, unknown>): Promise<AuthInitResult> {
    const imsgHost = (config.imsgHost as string) || DEFAULT_HOST;
    const imsgPort = (config.imsgPort as number) || DEFAULT_PORT;

    const client = new ImsgClient(imsgHost, imsgPort);
    try {
      await client.connect();
      await client.chatsList(1); // ping to verify the bridge works
      client.disconnect();
    } catch (err: any) {
      throw new Error(
        `Cannot connect to imsg bridge at ${imsgHost}:${imsgPort} — ${err.message}. ` +
          'Make sure the imsg RPC bridge is running: socat TCP-LISTEN:19876,reuseaddr,fork EXEC:"imsg rpc"',
      );
    }

    const myIdentifier = (config.myIdentifier as string) || '';

    return {
      type: 'complete',
      auth: { raw: { imsgHost, imsgPort, myIdentifier } },
    };
  }

  async completeAuth(params: Record<string, unknown>): Promise<AuthContext> {
    const imsgHost = (params.imsgHost as string) || DEFAULT_HOST;
    const imsgPort = (params.imsgPort as number) || DEFAULT_PORT;
    const myIdentifier = (params.myIdentifier as string) || '';
    return { raw: { imsgHost, imsgPort, myIdentifier } };
  }

  async validateAuth(auth: AuthContext): Promise<boolean> {
    const imsgHost = (auth.raw?.imsgHost as string) || DEFAULT_HOST;
    const imsgPort = (auth.raw?.imsgPort as number) || DEFAULT_PORT;

    const client = new ImsgClient(imsgHost, imsgPort);
    try {
      await client.connect();
      await client.chatsList(1);
      client.disconnect();
      return true;
    } catch {
      return false;
    }
  }

  async revokeAuth(): Promise<void> {
    // Nothing to revoke
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const imsgHost = (ctx.auth.raw?.imsgHost as string) || DEFAULT_HOST;
    const imsgPort = (ctx.auth.raw?.imsgPort as number) || DEFAULT_PORT;

    ctx.logger.info(`Connecting to imsg bridge at ${imsgHost}:${imsgPort}`);
    const client = new ImsgClient(imsgHost, imsgPort);
    await client.connect();

    try {
      const chats = await client.chatsList(10_000);
      // Process most recently active chats first
      chats.sort((a, b) => (b.last_message_at || '').localeCompare(a.last_message_at || ''));
      ctx.logger.info(`Found ${chats.length} chats`);

      const startCursor = ctx.cursor || undefined;
      let latestTimestamp: string | null = null;
      let processed = 0;

      for (const chat of chats) {
        if (ctx.signal.aborted) break;

        const messages = await client.messagesHistory(chat.id, {
          start: startCursor,
        });

        // Process newest messages first
        messages.reverse();

        for (const msg of messages) {
          if (ctx.signal.aborted) break;

          this.emitData({
            sourceType: 'message',
            sourceId: msg.guid || `imsg-${msg.id}`,
            timestamp: msg.created_at,
            content: {
              text: msg.text || '',
              participants: msg.participants || [msg.sender],
              metadata: {
                chatId: msg.chat_id,
                chatName: msg.chat_name,
                service: 'iMessage',
                isFromMe: msg.is_from_me,
                isGroup: msg.is_group,
              },
            },
          });

          if (!latestTimestamp || msg.created_at > latestTimestamp) {
            latestTimestamp = msg.created_at;
          }

          processed++;

          if (processed % PROGRESS_INTERVAL === 0) {
            this.emit('progress', { processed });
          }
        }
      }

      ctx.logger.info(`Synced ${processed} iMessages from ${chats.length} chats`);
      this.emit('progress', { processed });

      return {
        cursor: latestTimestamp || ctx.cursor,
        hasMore: false,
        processed,
      };
    } finally {
      client.disconnect();
    }
  }
}

export default () => new IMessageConnector();

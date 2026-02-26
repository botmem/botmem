import { BaseConnector } from '@botmem/connector-sdk';
import type {
  ConnectorManifest,
  AuthContext,
  AuthInitResult,
  SyncContext,
  SyncResult,
} from '@botmem/connector-sdk';
import { ImsgClient } from './imsg-client.js';

const DEFAULT_HOST = 'host.docker.internal';
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
      properties: {
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
  };

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

    return {
      type: 'complete',
      auth: { raw: { imsgHost, imsgPort } },
    };
  }

  async completeAuth(params: Record<string, unknown>): Promise<AuthContext> {
    const imsgHost = (params.imsgHost as string) || DEFAULT_HOST;
    const imsgPort = (params.imsgPort as number) || DEFAULT_PORT;
    return { raw: { imsgHost, imsgPort } };
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
      ctx.logger.info(`Found ${chats.length} chats`);

      const startCursor = ctx.cursor || undefined;
      let latestTimestamp: string | null = null;
      let processed = 0;

      for (const chat of chats) {
        if (ctx.signal.aborted) break;

        const messages = await client.messagesHistory(chat.id, {
          start: startCursor,
        });

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

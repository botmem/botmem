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
import { sendCode, verifyCode, verify2fa, createClientFromSession } from './auth.js';
import { syncTelegram } from './sync.js';

export class TelegramConnector extends BaseConnector {
  readonly manifest: ConnectorManifest = {
    id: 'telegram',
    name: 'Telegram',
    description: 'Import messages and contacts from Telegram',
    color: '#26A5E4',
    icon: 'send',
    authType: 'phone-code',
    configSchema: {
      type: 'object',
      properties: {
        phone: {
          type: 'string',
          title: 'Phone Number',
          description: '+1234567890',
        },
        apiId: {
          type: 'string',
          title: 'API ID (optional)',
          description: 'From my.telegram.org/apps',
        },
        apiHash: {
          type: 'string',
          title: 'API Hash (optional)',
          description: 'From my.telegram.org/apps',
        },
      },
      required: ['phone'],
    },
    entities: ['person', 'message'],
    pipeline: { clean: true, embed: true, enrich: false },
    trustScore: 0.8,
  };

  async initiateAuth(config: Record<string, unknown>): Promise<AuthInitResult> {
    const phone = config.phone as string;
    if (!phone) throw new Error('Phone number is required');

    const wsChannel = `auth:telegram-${Date.now()}`;
    const { phoneCodeHash } = await sendCode(
      {
        phone,
        apiId: config.apiId as string | undefined,
        apiHash: config.apiHash as string | undefined,
      },
      wsChannel,
    );

    return { type: 'phone-code', phoneCodeHash, wsChannel };
  }

  async completeAuth(params: Record<string, unknown>): Promise<AuthContext> {
    const wsChannel = params.wsChannel as string;
    const code = params.code as string;
    const password = params.password as string;

    if (!wsChannel) throw new Error('Missing auth session');

    // If we have a password, this is the 2FA step
    if (password) {
      return verify2fa(wsChannel, password);
    }

    // Otherwise, verify the phone code
    if (!code) throw new Error('Verification code is required');

    const result = await verifyCode(wsChannel, code);
    if (result.need2fa) {
      // Signal that 2FA is needed — caller should prompt for password
      throw Object.assign(new Error('2FA password required'), {
        errorMessage: 'SESSION_PASSWORD_NEEDED',
        need2fa: true,
        wsChannel,
      });
    }

    return result.auth;
  }

  async validateAuth(auth: AuthContext): Promise<boolean> {
    const session = auth.raw?.session as string;
    if (!session) return false;

    try {
      const client = createClientFromSession(session);
      await client.connect();
      const me = await client.getMe();
      await client.disconnect();
      return !!me;
    } catch {
      return false;
    }
  }

  async revokeAuth(_auth: AuthContext): Promise<void> {
    // Session string is just discarded — no files to clean up
  }

  embed(event: ConnectorDataEvent, cleanedText: string, _ctx: PipelineContext): EmbedResult {
    const entities: EmbedResult['entities'] = [];
    const metadata = event.content?.metadata || {};
    const isGroup = metadata.isGroup as boolean | undefined;
    const chatId = metadata.chatId as string | undefined;
    const chatName = metadata.chatName as string | undefined;
    const senderPhone = metadata.senderPhone as string | undefined;
    const senderName = metadata.senderName as string | undefined;
    const senderUsername = metadata.senderUsername as string | undefined;
    const senderId = metadata.senderId as string | undefined;

    // Group entity
    if (isGroup && chatId) {
      const groupParts = [`telegram_group:${chatId}`];
      if (chatName) groupParts.push(`name:${chatName}`);
      entities.push({ type: 'group', id: groupParts.join('|'), role: 'group' });
    }

    // Sender — use phone as primary, username as fallback
    if (senderPhone) {
      const parts = [`phone:${senderPhone}`];
      if (senderName) parts.push(`name:${senderName}`);
      if (senderUsername) parts.push(`username:${senderUsername}`);
      entities.push({ type: 'person', id: parts.join('|'), role: 'sender' });
    } else if (senderUsername) {
      const parts = [`telegram_username:${senderUsername}`];
      if (senderName) parts.push(`name:${senderName}`);
      if (senderId) parts.push(`telegram_id:${senderId}`);
      entities.push({ type: 'person', id: parts.join('|'), role: 'sender' });
    } else if (senderId) {
      const parts = [`telegram_id:${senderId}`];
      if (senderName) parts.push(`name:${senderName}`);
      entities.push({ type: 'person', id: parts.join('|'), role: 'sender' });
    }

    return { text: cleanedText, entities };
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const result = await syncTelegram(ctx, (event) => this.emitData(event));
    this.emit('progress', { processed: result.processed });
    return result;
  }
}

export default () => new TelegramConnector();

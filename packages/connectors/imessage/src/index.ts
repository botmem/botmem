import { BaseConnector, isNoise } from '@botmem/connector-sdk';
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
import { AppleClient } from './apple-client.js';
import type { AppleContact } from './apple-client.js';
import type { RpcTransport } from './transport.js';

/** Tapback/reaction prefixes used by iMessage */
const TAPBACK_PREFIXES = [
  'Loved "',
  'Liked "',
  'Disliked "',
  'Laughed at "',
  'Emphasized "',
  'Questioned "',
  'Removed a like',
  'Removed a heart',
  'Removed a dislike',
  'Removed a laugh',
  'Removed an emphasis',
  'Removed a question mark',
];

const PROGRESS_INTERVAL = 50; // emit progress every N messages
const BRIDGE_PREFLIGHT_TIMEOUT_MS = 3000;

export interface AppleSelectedSources {
  contacts: boolean;
  imessages: boolean;
}

export interface AppleIdentityEvent {
  source: 'apple_contacts';
  contact: AppleContact;
}

function normalizeSelectedSources(raw: unknown): AppleSelectedSources {
  const value =
    raw && typeof raw === 'object'
      ? (raw as Partial<Record<keyof AppleSelectedSources, unknown>>)
      : {};
  return {
    contacts: value.contacts !== false,
    imessages: value.imessages !== false,
  };
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

export class AppleConnector extends BaseConnector {
  /** Optional tunnel transport injected by SyncProcessor for remote mode. */
  private tunnelTransport: RpcTransport | null = null;

  readonly manifest: ConnectorManifest = {
    id: 'apple',
    name: 'Apple',
    description: 'Import Apple Contacts and iMessage conversations via the Botmem bridge tunnel',
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
        selectedSources: {
          type: 'object',
          title: 'Apple Data Sources',
          description: 'Choose which local Apple data sources this bridge can sync',
          default: { contacts: true, imessages: true },
        },
        authMethod: {
          type: 'string',
          title: 'Bridge Mode',
          description: 'Use the Botmem encrypted WebSocket bridge',
          default: 'bridge',
        },
        appleHost: {
          type: 'string',
          title: 'Bridge Host',
          description: 'Optional host for a local iMessage bridge',
          default: 'localhost',
        },
        applePort: {
          type: 'number',
          title: 'Bridge Port',
          description: 'Optional port for a local iMessage bridge',
          default: 19876,
        },
      },
    },
    entities: ['person', 'message'],
    pipeline: { clean: false, embed: true, enrich: false },
    trustScore: 0.8,
  };

  /**
   * Inject a tunnel transport for remote bridge mode.
   * Called by SyncProcessor before sync() when account.tunnelMode is true.
   */
  setTunnelTransport(transport: RpcTransport): void {
    this.tunnelTransport = transport;
  }

  /** Clear tunnel transport after sync completes. */
  clearTunnelTransport(): void {
    this.tunnelTransport = null;
  }

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

    // Group chat entity
    const isGroup = metadata.isGroup as boolean | undefined;
    const chatName = metadata.chatName as string | undefined;
    if (isGroup && chatName) {
      entities.push({ type: 'group', id: `name:${chatName}`, role: 'group' });
    }

    return { text: cleanedText, entities };
  }

  async initiateAuth(config: Record<string, unknown>): Promise<AuthInitResult> {
    // Bridge (tunnel) mode — token generated server-side, no connectivity check needed
    if (config.authMethod === 'bridge' || config.tunnelMode) {
      const myIdentifier = (config.myIdentifier as string) || '';
      const selectedSources = normalizeSelectedSources(config.selectedSources);
      return {
        type: 'complete',
        auth: {
          raw: {
            myIdentifier,
            tunnelMode: true,
            bridgeToken: config.bridgeToken as string,
            selectedSources,
          },
        },
      };
    }

    throw new Error('Apple must be connected through the Botmem bridge setup flow.');
  }

  async completeAuth(params: Record<string, unknown>): Promise<AuthContext> {
    const myIdentifier = (params.myIdentifier as string) || '';
    return {
      raw: {
        myIdentifier,
        tunnelMode: true,
        selectedSources: normalizeSelectedSources(params.selectedSources),
      },
    };
  }

  async validateAuth(auth: AuthContext): Promise<boolean> {
    // Tunnel mode — validation happens via bridge connection status
    if (auth.raw?.tunnelMode) {
      return true; // Actual connectivity checked by AppleTunnelService.isConnected()
    }

    return false;
  }

  async revokeAuth(): Promise<void> {
    // Nothing to revoke
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const selectedSources = normalizeSelectedSources(ctx.auth.raw?.selectedSources);

    // Choose transport: tunnel (remote) or TCP (local)
    let transport: RpcTransport;

    if (this.tunnelTransport) {
      ctx.logger.info('Using tunnel transport (remote bridge)');
      transport = this.tunnelTransport;
    } else {
      throw new Error(
        'Apple bridge tunnel is not connected. Run the bridge command from connector setup, then retry sync.',
      );
    }

    const client = new AppleClient(transport);
    try {
      await withTimeout(
        client.connect(),
        BRIDGE_PREFLIGHT_TIMEOUT_MS,
        'Apple bridge tunnel is not connected',
      );
    } catch (err) {
      client.disconnect();
      throw new Error(
        'Apple bridge not connected. Start the Botmem Apple bridge from connector setup, then run `botmem sync <account-id>`.',
        { cause: err },
      );
    }

    try {
      if (selectedSources.contacts) {
        await this.syncContacts(client, ctx);
      } else {
        ctx.logger.info('Apple Contacts sync skipped by selected data sources');
      }

      if (!selectedSources.imessages) {
        ctx.logger.info('iMessage sync skipped by selected data sources');
        return {
          cursor: ctx.cursor,
          hasMore: false,
          processed: 0,
        };
      }

      const chats = await client.chatsList(10_000);
      // Process most recently active chats first
      chats.sort((a, b) => (b.last_message_at || '').localeCompare(a.last_message_at || ''));
      ctx.logger.info(`Found ${chats.length} chats`);

      const startCursor = ctx.cursor || undefined;
      let latestTimestamp: string | null = null;
      let processed = 0;
      let filteredCount = 0;

      for (const chat of chats) {
        if (ctx.signal.aborted) break;

        const messages = await client.messagesHistory(chat.id, {
          start: startCursor
            ? new Date(new Date(startCursor).getTime() + 1).toISOString()
            : undefined,
        });

        // Process newest messages first
        messages.reverse();

        for (const msg of messages) {
          if (ctx.signal.aborted) break;

          const text = msg.text || '';
          const hasAttachments = msg.attachments && msg.attachments.length > 0;

          // Skip null/empty text messages without attachments (delivery/read receipts)
          if (!text && !hasAttachments) {
            filteredCount++;
            continue;
          }

          // Skip tapback reactions (e.g. 'Loved "hey"', 'Liked "ok"')
          if (text && TAPBACK_PREFIXES.some((prefix) => text.startsWith(prefix))) {
            filteredCount++;
            ctx.logger.debug(`Noise filtered (tapback): ${text.slice(0, 60)}`);
            continue;
          }

          // Apply shared noise filter on message text
          if (text && isNoise(text, {})) {
            filteredCount++;
            continue;
          }

          this.emitData({
            sourceType: 'message',
            sourceId: msg.guid || `apple-msg-${msg.id}`,
            timestamp: msg.created_at,
            content: {
              text,
              participants: msg.participants || [msg.sender],
              attachments: hasAttachments
                ? msg.attachments.map((attachment) => ({
                    uri: attachment.filename || attachment.transfer_name || '',
                    mimeType: attachment.mime_type || 'application/octet-stream',
                    filename: attachment.transfer_name || attachment.filename,
                  }))
                : undefined,
              metadata: {
                chatId: msg.chat_id,
                chatName: msg.chat_name,
                service: 'iMessage',
                isFromMe: msg.is_from_me,
                isGroup: msg.is_group,
                attachments: hasAttachments
                  ? msg.attachments.map((attachment) => ({
                      uri: attachment.filename || attachment.transfer_name || '',
                      mimeType: attachment.mime_type || 'application/octet-stream',
                      filename: attachment.transfer_name || attachment.filename,
                    }))
                  : undefined,
              },
            },
          });

          if (!latestTimestamp || msg.created_at > latestTimestamp) {
            latestTimestamp = msg.created_at;
          }

          processed++;

          if (processed % PROGRESS_INTERVAL === 0) {
            this.emitProgress({ processed });
          }
        }
      }

      ctx.logger.info(
        `Synced ${processed} iMessages from ${chats.length} chats (${filteredCount} noise filtered)`,
      );
      this.emitProgress({ processed });

      return {
        cursor: latestTimestamp || ctx.cursor,
        hasMore: false,
        processed,
      };
    } finally {
      client.disconnect();
      this.clearTunnelTransport();
    }
  }

  private async syncContacts(client: AppleClient, ctx: SyncContext): Promise<void> {
    try {
      const contacts = await client.contactsList();
      let processed = 0;
      for (const contact of contacts) {
        if (ctx.signal.aborted) break;
        const hasDurableIdentifier =
          Boolean(contact.id) || contact.emails.length > 0 || contact.phones.length > 0;
        if (!hasDurableIdentifier) continue;
        this.emit('identity', {
          source: 'apple_contacts',
          contact,
        } satisfies AppleIdentityEvent);
        processed++;
      }
      ctx.logger.info(`Synced ${processed} Apple contact identit${processed === 1 ? 'y' : 'ies'}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit('degraded', {
        message: `Apple Contacts sync failed; continuing with iMessages: ${message}`,
      });
    }
  }
}

export { AppleConnector as IMessageConnector };

export default () => new AppleConnector();

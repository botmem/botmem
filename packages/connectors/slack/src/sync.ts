import { WebClient } from '@slack/web-api';
import type { SyncContext, ConnectorDataEvent } from '@botmem/connector-sdk';

export interface UserProfile {
  name: string;
  realName: string;
  email?: string;
  phone?: string;
  title?: string;
  avatarUrl?: string;
}

interface CursorState {
  channels: Record<string, string>; // channelId -> latest timestamp
  channelList?: string;             // cursor for channel pagination
}

/** Pre-fetch workspace users for mention resolution */
async function fetchUserMap(client: WebClient): Promise<Map<string, UserProfile>> {
  const map = new Map<string, UserProfile>();
  try {
    let cursor: string | undefined;
    do {
      const res = await client.users.list({ limit: 200, cursor });
      for (const u of res.members || []) {
        if (u.id && u.name) {
          const profile = (u as any).profile || {};
          map.set(u.id, {
            name: u.name,
            realName: (u as any).real_name || u.name,
            email: profile.email || undefined,
            phone: profile.phone || undefined,
            title: profile.title || undefined,
            avatarUrl: profile.image_72 || undefined,
          });
        }
      }
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);
  } catch {
    // Best effort — mentions will stay as raw IDs
  }
  return map;
}

/** Get display name from user map, falling back to raw ID */
function userName(users: Map<string, UserProfile>, id: string): string {
  return users.get(id)?.name ?? id;
}

/** Resolve Slack mrkdwn to human-readable text */
function normalizeSlackText(text: string, users: Map<string, UserProfile>): string {
  return text
    // User mentions: <@U123> or <@U123|name>
    .replace(/<@([A-Z0-9]+)(?:\|([^>]+))?>/g, (_m, id, label) => {
      return `@${label || userName(users, id)}`;
    })
    // Special mentions: <!channel>, <!here>, <!everyone>
    .replace(/<!(\w+)(?:\|([^>]+))?>/g, (_m, cmd, label) => `@${label || cmd}`)
    // Links: <url|label> or <url>
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    // Emoji shortcodes: :tada: → remove colons for readability
    .replace(/:([a-z0-9_+-]+):/g, '$1');
}

/** Determine conversation type label for metadata */
function channelType(channel: { is_im?: boolean; is_mpim?: boolean; is_private?: boolean }): string {
  if (channel.is_im) return 'dm';
  if (channel.is_mpim) return 'group-dm';
  if (channel.is_private) return 'private-channel';
  return 'channel';
}

/** Build a display name for the conversation */
function channelLabel(
  channel: { name?: string; is_im?: boolean; is_mpim?: boolean; user?: string },
  users: Map<string, UserProfile>,
): string {
  if (channel.is_im && channel.user) return `DM with ${userName(users, channel.user)}`;
  if (channel.is_mpim) return channel.name || 'group-dm';
  return channel.name || 'unknown';
}

/** Fetch thread replies and combine into contextual text */
async function fetchThreadContext(
  client: WebClient,
  channelId: string,
  threadTs: string,
  users: Map<string, UserProfile>,
): Promise<string> {
  try {
    const res = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: 50,
    });
    const replies = (res.messages || []).slice(1); // skip parent (already emitted)
    if (replies.length === 0) return '';
    return replies
      .map((r) => {
        const author = r.user ? userName(users, r.user) : 'unknown';
        return `[${author}]: ${normalizeSlackText(r.text || '', users)}`;
      })
      .join('\n');
  } catch {
    return '';
  }
}

export async function syncSlack(
  ctx: SyncContext,
  emit: (event: ConnectorDataEvent) => void,
): Promise<{ cursor: string | null; hasMore: boolean; processed: number }> {
  const client = new WebClient(ctx.auth.accessToken);
  let processed = 0;
  const cursorState: CursorState = ctx.cursor ? JSON.parse(ctx.cursor) : { channels: {} };

  ctx.logger.info('Starting Slack sync');

  // Pre-fetch users for mention resolution
  const users = await fetchUserMap(client);

  // Fetch all conversation types: channels, DMs, group DMs
  const channelsRes = await client.conversations.list({
    types: 'public_channel,private_channel,im,mpim',
    limit: 100,
    cursor: cursorState.channelList || undefined,
  });

  const channels = channelsRes.channels || [];

  for (const channel of channels) {
    if (ctx.signal.aborted) break;
    if (!channel.id) continue;

    const oldest = cursorState.channels[channel.id] || '0';
    const convType = channelType(channel);
    const convLabel = channelLabel(channel, users);

    const historyRes = await client.conversations.history({
      channel: channel.id,
      oldest,
      limit: 100,
    });

    const messages = historyRes.messages || [];
    let latestTs = oldest;

    for (const msg of messages) {
      if (ctx.signal.aborted) break;
      if (!msg.ts || msg.subtype) continue;

      const normalizedText = normalizeSlackText(msg.text || '', users);
      const author = msg.user ? userName(users, msg.user) : 'unknown';

      // Collect all participants (author + mentioned users)
      const participants = new Set<string>();
      if (msg.user) participants.add(userName(users, msg.user));

      // Build thread context if this message has replies
      let threadContext = '';
      const hasReplies = msg.thread_ts === msg.ts && (msg as any).reply_count > 0;
      if (hasReplies) {
        threadContext = await fetchThreadContext(client, channel.id, msg.ts, users);
        // Add thread participants
        const threadMentions = threadContext.match(/^\[([^\]]+)\]/gm);
        if (threadMentions) {
          for (const m of threadMentions) {
            participants.add(m.slice(1, -1));
          }
        }
      }

      // Extract file and attachment context
      let filesContext = '';
      const files = (msg as any).files || [];
      const attachments = (msg as any).attachments || [];
      if (files.length > 0) {
        const fileLines = files.map((f: any) =>
          `[file: ${f.name || 'untitled'}${f.filetype ? ` (${f.filetype})` : ''}]`
        );
        filesContext += fileLines.join(' ');
      }
      if (attachments.length > 0) {
        const attachLines = attachments
          .filter((a: any) => a.title || a.text || a.from_url)
          .map((a: any) => {
            const parts = [];
            if (a.title) parts.push(a.title);
            if (a.text) parts.push(a.text);
            if (a.from_url) parts.push(a.from_url);
            return `[link: ${parts.join(' - ')}]`;
          });
        filesContext += (filesContext ? ' ' : '') + attachLines.join(' ');
      }

      // Compose the full text with context
      let fullText = `[${convLabel}] ${author}: ${normalizedText}`;
      if (filesContext) {
        fullText += `\n${filesContext}`;
      }
      if (threadContext) {
        fullText += `\n--- thread replies ---\n${threadContext}`;
      }

      // Build participant profiles lookup from the users map
      const participantProfiles: Record<string, UserProfile> = {};
      for (const pName of participants) {
        // Find the UserProfile by display name
        for (const [, profile] of users) {
          if (profile.name === pName) {
            participantProfiles[pName] = profile;
            break;
          }
        }
      }

      emit({
        sourceType: 'message',
        sourceId: `${channel.id}:${msg.ts}`,
        timestamp: new Date(parseFloat(msg.ts) * 1000).toISOString(),
        content: {
          text: fullText,
          participants: [...participants],
          metadata: {
            channel: convLabel,
            channelId: channel.id,
            channelType: convType,
            threadTs: msg.thread_ts,
            replyCount: (msg as any).reply_count || 0,
            participantProfiles,
          },
        },
      });

      // Emit separate events for file attachments
      for (const file of files) {
        if (!file.url_private || !file.mimetype) continue;
        emit({
          sourceType: 'file',
          sourceId: `${channel.id}:${msg.ts}:${file.id || file.name}`,
          timestamp: new Date(parseFloat(msg.ts) * 1000).toISOString(),
          content: {
            text: `[${convLabel}] ${author} shared: ${file.name || 'untitled'}`,
            participants: [...participants],
            metadata: {
              channel: convLabel,
              channelId: channel.id,
              channelType: convType,
              fileName: file.name,
              mimetype: file.mimetype,
              fileUrl: file.url_private,
              fileSize: file.size,
              parentMessageId: `${channel.id}:${msg.ts}`,
              participantProfiles,
            },
          },
        });
        processed++;
      }

      if (msg.ts > latestTs) latestTs = msg.ts;
      processed++;
    }

    cursorState.channels[channel.id] = latestTs;
  }

  const hasMore = !!channelsRes.response_metadata?.next_cursor;
  if (hasMore) {
    cursorState.channelList = channelsRes.response_metadata!.next_cursor;
  }

  ctx.logger.info(`Synced ${processed} Slack messages`);

  return {
    cursor: JSON.stringify(cursorState),
    hasMore,
    processed,
  };
}

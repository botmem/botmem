import { WebClient } from '@slack/web-api';
import type { SyncContext, ConnectorDataEvent } from '@botmem/connector-sdk';
import type { Member, Profile } from '@slack/web-api/dist/types/response/UsersListResponse.js';
import type {
  MessageElement,
  FileElement,
  Attachment as SlackAttachment,
  Reaction,
} from '@slack/web-api/dist/types/response/ConversationsHistoryResponse.js';
import type { User as SlackUser } from '@slack/web-api/dist/types/response/UsersInfoResponse.js';

/** Delay helper for rate limiting */
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Tier-3 Slack API: ~50 req/min → 1.2s between calls is safe */
const REPLY_FETCH_DELAY = 1200;

export interface UserProfile {
  name: string;
  realName: string;
  email?: string;
  phone?: string;
  title?: string;
  avatarUrl?: string;
  slackId?: string;
}

interface CursorState {
  channels: Record<string, string>; // channelId -> latest timestamp
  channelList?: string; // cursor for channel pagination
}

/** Identify self via auth.test */
async function fetchSelfId(client: WebClient): Promise<string | undefined> {
  try {
    const res = await client.auth.test();
    return res.user_id as string | undefined;
  } catch {
    return undefined;
  }
}

/** Pre-fetch workspace users for mention resolution */
async function fetchUserMap(client: WebClient): Promise<Map<string, UserProfile>> {
  const map = new Map<string, UserProfile>();
  try {
    let cursor: string | undefined;
    do {
      const res = await client.users.list({ limit: 200, cursor });
      for (const u of (res.members || []) as Member[]) {
        if (!u.id) continue;
        const profile: Partial<Profile> = u.profile || {};
        // Try every possible name field — bots use different fields
        const realName = profile.real_name_normalized || profile.real_name || u.real_name || '';
        const displayName = profile.display_name_normalized || profile.display_name || '';
        const name = u.name || '';
        const bestName = realName || displayName || name;
        if (!bestName) continue; // truly anonymous — skip

        map.set(u.id, {
          name: name || bestName,
          realName: bestName,
          email: profile.email || undefined,
          phone: profile.phone || undefined,
          title: profile.title || undefined,
          avatarUrl: profile.image_72 || undefined,
          slackId: u.id,
        });
      }
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);
  } catch {
    // Best effort — mentions will stay as raw IDs
  }
  return map;
}

/** Get display name from user map */
function userName(users: Map<string, UserProfile>, id: string): string {
  const u = users.get(id);
  return u?.realName ?? u?.name ?? id;
}

/** Resolve Slack mrkdwn to human-readable text */
function normalizeSlackText(text: string, users: Map<string, UserProfile>): string {
  return (
    text
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
      .replace(/:([a-z0-9_+-]+):/g, '$1')
  );
}

/** Extract user IDs mentioned in message text */
function extractMentionedIds(text: string): string[] {
  const ids: string[] = [];
  const re = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g;
  let m;
  while ((m = re.exec(text)) !== null) ids.push(m[1]);
  return ids;
}

/** Determine conversation type label for metadata */
function channelType(channel: {
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
}): string {
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
  selfId: string | undefined,
): Promise<{ text: string; participantIds: string[] }> {
  try {
    const res = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: 100,
    });
    const replies = (res.messages || []).slice(1); // skip parent (already emitted)
    if (replies.length === 0) return { text: '', participantIds: [] };
    const pIds: string[] = [];
    const lines = replies.map((r) => {
      if (r.user) pIds.push(r.user);
      const author = r.user ? userName(users, r.user) : 'unknown';
      const isSelf = selfId && r.user === selfId;
      const prefix = isSelf ? '(you)' : '';
      return `[${author}${prefix}]: ${normalizeSlackText(r.text || '', users)}`;
    });
    return { text: lines.join('\n'), participantIds: pIds };
  } catch {
    return { text: '', participantIds: [] };
  }
}

/** Build participant profiles with roles */
function buildParticipantData(
  participantIds: Map<string, Set<string>>, // userId -> roles
  users: Map<string, UserProfile>,
): {
  participants: string[];
  participantProfiles: Record<string, UserProfile>;
  roles: Record<string, string[]>;
} {
  const participants: string[] = [];
  const participantProfiles: Record<string, UserProfile> = {};
  const roles: Record<string, string[]> = {};

  for (const [userId, roleSet] of participantIds) {
    const profile = users.get(userId);
    if (!profile) continue; // Skip unresolved Slack IDs
    const name = profile.realName || profile.name || userId;
    participants.push(name);
    participantProfiles[name] = profile;
    roles[name] = [...roleSet];
  }

  return { participants, participantProfiles, roles };
}

export async function syncSlack(
  ctx: SyncContext,
  emit: (event: ConnectorDataEvent) => void,
  emitProgress?: (processed: number) => void,
): Promise<{ cursor: string | null; hasMore: boolean; processed: number }> {
  const client = new WebClient(ctx.auth.accessToken, {
    retryConfig: { retries: 5, factor: 2.5, minTimeout: 5_000 },
  });
  let processed = 0;
  const cursorState: CursorState = ctx.cursor ? JSON.parse(ctx.cursor) : { channels: {} };

  ctx.logger.info('Starting Slack sync');

  // Identify self — critical for understanding "what I sent" vs "what I received"
  const selfId = await fetchSelfId(client);
  if (selfId) {
    ctx.logger.info(`Identified self as user ${selfId}`);
  } else {
    ctx.logger.warn("Could not identify self — messages won't have sender/recipient context");
  }

  // Pre-fetch users for mention resolution
  const users = await fetchUserMap(client);
  ctx.logger.info(`Fetched ${users.size} workspace users`);

  // Resolve external (Slack Connect) users in DMs that aren't in workspace user list
  const channelsPrefetch = await client.conversations.list({
    types: 'im',
    limit: 200,
  });
  for (const ch of channelsPrefetch.channels || []) {
    if (!ch.user || users.has(ch.user)) continue;
    try {
      const info = await client.users.info({ user: ch.user });
      const userInfo = info.user as SlackUser | undefined;
      const p: Partial<Profile> = userInfo?.profile || {};
      const realName = p.real_name_normalized || p.real_name || userInfo?.real_name || '';
      const displayName = p.display_name_normalized || p.display_name || '';
      const name = userInfo?.name || '';
      const bestName = realName || displayName || name;
      if (bestName) {
        users.set(ch.user, {
          name: name || bestName,
          realName: bestName,
          email: p.email || undefined,
          phone: p.phone || undefined,
          title: p.title || undefined,
          avatarUrl: p.image_72 || undefined,
          slackId: ch.user,
        });
        ctx.logger.info(`Resolved external user ${ch.user} → ${bestName}`);
      }
    } catch (err: unknown) {
      ctx.logger.warn(
        `Could not resolve external user ${ch.user}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  ctx.logger.info(`User map now has ${users.size} entries (including external)`);

  // Emit contact events for all known users (workspace + external)
  for (const [userId, profile] of users) {
    if (userId === selfId) continue; // Skip self
    emit({
      sourceType: 'message',
      sourceId: `slack-contact:${userId}`,
      timestamp: new Date().toISOString(),
      content: {
        text: `Slack workspace contact: ${profile.realName} (@${profile.name})${profile.title ? ` — ${profile.title}` : ''}`,
        participants: [profile.realName || profile.name],
        metadata: {
          type: 'contact',
          name: profile.realName || profile.name,
          slackId: userId,
          slackHandle: profile.name,
          emails: profile.email ? [profile.email] : [],
          phones: profile.phone ? [profile.phone] : [],
          avatarUrl: profile.avatarUrl,
          title: profile.title,
          connectorType: 'slack',
        },
      },
    });
    processed++;
  }
  if (processed > 0) emitProgress?.(processed);

  // Paginate through ALL conversations
  let channelListCursor = cursorState.channelList || undefined;
  let hasMoreChannels = true;

  while (hasMoreChannels && !ctx.signal.aborted) {
    const channelsRes = await client.conversations.list({
      types: 'public_channel,private_channel,im,mpim',
      limit: 200,
      cursor: channelListCursor,
    });

    const channels = channelsRes.channels || [];

    for (const channel of channels) {
      if (ctx.signal.aborted) break;
      if (!channel.id) continue;

      const oldest = cursorState.channels[channel.id] || '0';
      const convType = channelType(channel);
      const convLabel = channelLabel(channel, users);

      // For DMs, identify the other party — retry resolution if still unknown
      const dmPartnerId = channel.is_im ? channel.user : undefined;
      if (dmPartnerId && !users.has(dmPartnerId)) {
        try {
          const info = await client.users.info({ user: dmPartnerId });
          const userInfo = info.user as SlackUser | undefined;
          const p: Partial<Profile> = userInfo?.profile || {};
          const realName = p.real_name_normalized || p.real_name || userInfo?.real_name || '';
          const displayName = p.display_name_normalized || p.display_name || '';
          const name = userInfo?.name || '';
          const bestName = realName || displayName || name;
          if (bestName) {
            users.set(dmPartnerId, {
              name: name || bestName,
              realName: bestName,
              email: p.email || undefined,
              phone: p.phone || undefined,
              title: p.title || undefined,
              avatarUrl: p.image_72 || undefined,
              slackId: dmPartnerId,
            });
            ctx.logger.info(`Late-resolved DM partner ${dmPartnerId} → ${bestName}`);
          }
        } catch {
          ctx.logger.warn(`DM partner ${dmPartnerId} could not be resolved — will show as ID`);
        }
      }
      // Paginate through ALL messages in this channel
      let historyCursor: string | undefined;
      let latestTs = oldest;

      do {
        if (ctx.signal.aborted) break;

        const historyRes = await client.conversations.history({
          channel: channel.id,
          oldest,
          limit: 200,
          cursor: historyCursor,
        });

        const messages = historyRes.messages || [];

        for (const msg of messages) {
          if (ctx.signal.aborted) break;
          if (!msg.ts) continue;

          // Allow some useful subtypes but skip noise
          const skipSubtypes = new Set([
            'channel_join',
            'channel_leave',
            'channel_archive',
            'channel_unarchive',
            'pinned_item',
            'unpinned_item',
          ]);
          if (msg.subtype && skipSubtypes.has(msg.subtype)) continue;

          const rawText = msg.text || '';
          const normalizedText = normalizeSlackText(rawText, users);
          const authorId = msg.user || (msg as MessageElement).bot_id;
          const authorName = authorId ? userName(users, authorId) : 'bot';

          // Determine self-context
          const isSelf = selfId && msg.user === selfId;
          const mentionedIds = extractMentionedIds(rawText);

          // Build participant map with roles
          const participantRoles = new Map<string, Set<string>>();
          const addRole = (uid: string, role: string) => {
            if (!uid) return;
            if (!participantRoles.has(uid)) participantRoles.set(uid, new Set());
            participantRoles.get(uid)!.add(role);
          };

          // Sender
          if (msg.user) addRole(msg.user, 'sender');

          // In DMs: the other party is the recipient
          if (channel.is_im) {
            if (isSelf && dmPartnerId) addRole(dmPartnerId, 'recipient');
            else if (!isSelf && selfId) addRole(selfId, 'recipient');
          }

          // Mentioned users
          for (const mid of mentionedIds) addRole(mid, 'mentioned');

          // Reactions — who reacted to this message
          const reactions: Reaction[] = (msg as MessageElement).reactions || [];
          const reactionContext: string[] = [];
          for (const reaction of reactions) {
            const reactors = (reaction.users || []) as string[];
            for (const uid of reactors) addRole(uid, 'reacted');
            const reactorNames = reactors.map((uid: string) => userName(users, uid)).join(', ');
            reactionContext.push(`:${reaction.name}: by ${reactorNames}`);
          }

          // Build thread context if this message has replies
          let threadContext = '';
          const hasReplies =
            msg.thread_ts === msg.ts && ((msg as MessageElement).reply_count ?? 0) > 0;
          if (hasReplies) {
            await delay(REPLY_FETCH_DELAY); // Rate limit: conversations.replies is Tier 3
            const thread = await fetchThreadContext(client, channel.id!, msg.ts, users, selfId);
            threadContext = thread.text;
            for (const pid of thread.participantIds) addRole(pid, 'thread_participant');
          }

          // Extract file and attachment context
          let filesContext = '';
          const files: FileElement[] = (msg as MessageElement).files || [];
          const msgAttachments: SlackAttachment[] = (msg as MessageElement).attachments || [];
          if (files.length > 0) {
            const fileLines = files.map(
              (f: FileElement) =>
                `[file: ${f.name || 'untitled'}${f.filetype ? ` (${f.filetype})` : ''}]`,
            );
            filesContext += fileLines.join(' ');
          }
          if (msgAttachments.length > 0) {
            const attachLines = msgAttachments
              .filter((a: SlackAttachment) => a.title || a.text || a.from_url)
              .map((a: SlackAttachment) => {
                const parts = [];
                if (a.title) parts.push(a.title);
                if (a.text) parts.push(normalizeSlackText(a.text, users));
                if (a.from_url) parts.push(a.from_url);
                return `[link: ${parts.join(' - ')}]`;
              });
            filesContext += (filesContext ? ' ' : '') + (attachLines as string[]).join(' ');
          }

          // Prefix channel name for search/embedding context
          let fullText = `[${convLabel}] ${normalizedText}`;

          if (filesContext) fullText += `\n${filesContext}`;
          if (reactionContext.length > 0) fullText += `\nReactions: ${reactionContext.join(', ')}`;
          if (threadContext) fullText += `\n--- thread replies ---\n${threadContext}`;

          const { participants, participantProfiles, roles } = buildParticipantData(
            participantRoles,
            users,
          );

          emit({
            sourceType: 'message',
            sourceId: `${channel.id}:${msg.ts}`,
            timestamp: new Date(parseFloat(msg.ts) * 1000).toISOString(),
            content: {
              text: fullText,
              participants,
              metadata: {
                channel: convLabel,
                channelName: convLabel,
                channelId: channel.id,
                channelType: convType,
                threadTs: msg.thread_ts,
                replyCount: (msg as MessageElement).reply_count || 0,
                isSelf: !!isSelf,
                selfId,
                senderId: msg.user,
                senderName: authorName,
                participantProfiles,
                participantRoles: roles,
                reactions: reactions.map((r: Reaction) => ({
                  name: r.name,
                  count: r.count,
                  users: (r.users || []).map((uid: string) => userName(users, uid)),
                })),
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
                text: `shared: ${file.name || 'untitled'}`,
                participants,
                metadata: {
                  channel: convLabel,
                  channelId: channel.id,
                  channelType: convType,
                  fileName: file.name,
                  mimetype: file.mimetype,
                  fileUrl: file.url_private,
                  fileSize: file.size,
                  parentMessageId: `${channel.id}:${msg.ts}`,
                  isSelf: !!isSelf,
                  participantProfiles,
                },
              },
            });
            processed++;
          }

          if (msg.ts > latestTs) latestTs = msg.ts;
          processed++;
        }

        historyCursor = historyRes.response_metadata?.next_cursor || undefined;
        if (historyCursor) await delay(500); // Rate limit between history pages
      } while (historyCursor && !ctx.signal.aborted);

      cursorState.channels[channel.id] = latestTs;
      emitProgress?.(processed);
    }

    hasMoreChannels = !!channelsRes.response_metadata?.next_cursor;
    channelListCursor = channelsRes.response_metadata?.next_cursor || undefined;
  }

  if (channelListCursor) {
    cursorState.channelList = channelListCursor;
  }

  ctx.logger.info(`Synced ${processed} Slack events (messages + contacts + files)`);

  return {
    cursor: JSON.stringify(cursorState),
    hasMore: hasMoreChannels,
    processed,
  };
}

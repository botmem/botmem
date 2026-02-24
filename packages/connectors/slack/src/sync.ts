import { WebClient } from '@slack/web-api';
import type { SyncContext, ConnectorDataEvent } from '@botmem/connector-sdk';

interface CursorState {
  channels: Record<string, string>; // channelId -> latest timestamp
  channelList?: string;             // cursor for channel pagination
}

export async function syncSlack(
  ctx: SyncContext,
  emit: (event: ConnectorDataEvent) => void,
): Promise<{ cursor: string | null; hasMore: boolean; processed: number }> {
  const client = new WebClient(ctx.auth.accessToken);
  let processed = 0;
  const cursorState: CursorState = ctx.cursor ? JSON.parse(ctx.cursor) : { channels: {} };

  ctx.logger.info('Starting Slack sync');

  const channelsRes = await client.conversations.list({
    limit: 100,
    cursor: cursorState.channelList || undefined,
  });

  const channels = channelsRes.channels || [];

  for (const channel of channels) {
    if (ctx.signal.aborted) break;
    if (!channel.id) continue;

    const oldest = cursorState.channels[channel.id] || '0';

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

      emit({
        sourceType: 'message',
        sourceId: `${channel.id}:${msg.ts}`,
        timestamp: new Date(parseFloat(msg.ts) * 1000).toISOString(),
        content: {
          text: msg.text || '',
          participants: msg.user ? [msg.user] : [],
          metadata: {
            channel: channel.name,
            channelId: channel.id,
            threadTs: msg.thread_ts,
          },
        },
      });

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

import { describe, it, expect, vi } from 'vitest';
import type { SyncContext, ConnectorDataEvent } from '@botmem/connector-sdk';

const { mockConversationsList, mockConversationsHistory, mockConversationsReplies, mockUsersList } =
  vi.hoisted(() => ({
    mockConversationsList: vi.fn(),
    mockConversationsHistory: vi.fn(),
    mockConversationsReplies: vi.fn(),
    mockUsersList: vi.fn().mockResolvedValue({
      members: [
        { id: 'U1', name: 'alice' },
        { id: 'U2', name: 'bob' },
      ],
      response_metadata: { next_cursor: '' },
    }),
  }));

const mockAuthTest = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true, user_id: 'USELF' }));

const mockUsersInfo = vi.hoisted(() => vi.fn().mockRejectedValue(new Error('not found')));

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(() => ({
    conversations: {
      list: mockConversationsList,
      history: mockConversationsHistory,
      replies: mockConversationsReplies,
    },
    users: {
      list: mockUsersList,
      info: mockUsersInfo,
    },
    auth: {
      test: mockAuthTest,
    },
  })),
}));

import { syncSlack } from '../sync.js';

const makeCtx = (cursor?: string): SyncContext =>
  ({
    accountId: 'acc-1',
    auth: { accessToken: 'xoxb-test' },
    cursor: cursor || null,
    jobId: 'j1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    signal: AbortSignal.timeout(5000),
  }) as SyncContext;

describe('syncSlack', () => {
  it('fetches all conversation types and normalizes messages with context', async () => {
    mockConversationsList.mockResolvedValue({
      channels: [
        { id: 'C1', name: 'general' },
        { id: 'D1', name: undefined, is_im: true, user: 'U2' },
      ],
      response_metadata: { next_cursor: '' },
    });

    mockConversationsHistory.mockResolvedValue({
      messages: [
        { ts: '1700000000.000', text: '<!channel> Hello <@U2>', user: 'U1', reply_count: 0 },
      ],
    });

    const events: ConnectorDataEvent[] = [];
    const result = await syncSlack(makeCtx(), (e) => events.push(e));

    // 2 contact events (alice + bob) + 1 message per channel × 2 channels = 4
    expect(result.processed).toBe(4);

    // Filter out contact events to test message events
    const contactEvents = events.filter(
      (e: ConnectorDataEvent) => e.content.metadata?.type === 'contact',
    );
    const msgEvents = events.filter(
      (e: ConnectorDataEvent) => e.content.metadata?.type !== 'contact',
    );
    expect(contactEvents.length).toBe(2);
    expect(msgEvents.length).toBe(2);

    // Verify conversation types requested
    expect(mockConversationsList).toHaveBeenCalledWith(
      expect.objectContaining({ types: 'public_channel,private_channel,im,mpim' }),
    );

    // Verify normalization and context prefix
    expect(msgEvents[0].content.text).toContain('[general]');
    expect(msgEvents[0].content.text).toContain('@channel Hello @bob');
    expect(msgEvents[0].content.metadata.channelType).toBe('channel');

    // DM conversation
    expect(msgEvents[1].content.metadata.channelType).toBe('dm');
    expect(msgEvents[1].content.metadata.channel).toBe('DM with bob');
  });

  it('fetches thread replies for messages with reply_count > 0', async () => {
    mockConversationsList.mockResolvedValue({
      channels: [{ id: 'C1', name: 'general' }],
      response_metadata: {},
    });

    mockConversationsHistory.mockResolvedValue({
      messages: [
        {
          ts: '1700000000.000',
          thread_ts: '1700000000.000',
          text: 'Parent message',
          user: 'U1',
          reply_count: 2,
        },
      ],
    });

    mockConversationsReplies.mockResolvedValue({
      messages: [
        { ts: '1700000000.000', text: 'Parent message', user: 'U1' },
        { ts: '1700000001.000', text: 'Reply one', user: 'U2' },
        { ts: '1700000002.000', text: 'Reply two', user: 'U1' },
      ],
    });

    const events: ConnectorDataEvent[] = [];
    await syncSlack(makeCtx(), (e) => events.push(e));

    const msgEvents = events.filter(
      (e: ConnectorDataEvent) => e.content.metadata?.type !== 'contact',
    );
    expect(msgEvents.length).toBe(1);
    expect(msgEvents[0].content.text).toContain('[general]');
    expect(msgEvents[0].content.text).toContain('Parent message');
    expect(msgEvents[0].content.text).toContain('--- thread replies ---');
    expect(msgEvents[0].content.text).toContain('Reply one');
    expect(msgEvents[0].content.text).toContain('Reply two');
    expect(msgEvents[0].content.metadata.replyCount).toBe(2);

    // Thread participants included
    expect(msgEvents[0].content.participants).toContain('alice');
    expect(msgEvents[0].content.participants).toContain('bob');
  });

  it('skips messages with subtype', async () => {
    mockConversationsList.mockResolvedValue({
      channels: [{ id: 'C1', name: 'general' }],
      response_metadata: {},
    });

    mockConversationsHistory.mockResolvedValue({
      messages: [
        { ts: '1700000000.000', text: 'Normal', user: 'U1', reply_count: 0 },
        { ts: '1700000001.000', text: 'Bot joined', user: 'U2', subtype: 'channel_join' },
      ],
    });

    const events: ConnectorDataEvent[] = [];
    await syncSlack(makeCtx(), (e) => events.push(e));
    // 2 contact events + 1 normal message (subtype message skipped)
    const msgEvents = events.filter(
      (e: ConnectorDataEvent) => e.content.metadata?.type !== 'contact',
    );
    expect(msgEvents.length).toBe(1);
  });

  it('emits participantProfiles in metadata with full user profile data', async () => {
    // Override mockUsersList for this test with full profile data
    mockUsersList.mockResolvedValueOnce({
      members: [
        {
          id: 'U1',
          name: 'alice',
          real_name: 'Alice Johnson',
          profile: {
            email: 'alice@example.com',
            phone: '+1234567890',
            title: 'Engineer',
            image_72: 'https://avatars.slack.com/alice_72.png',
          },
        },
        {
          id: 'U2',
          name: 'bob',
          real_name: 'Bob Smith',
          profile: {
            email: 'bob@example.com',
            phone: '',
            title: 'Designer',
            image_72: 'https://avatars.slack.com/bob_72.png',
          },
        },
      ],
      response_metadata: { next_cursor: '' },
    });

    mockConversationsList.mockResolvedValue({
      channels: [{ id: 'C1', name: 'general' }],
      response_metadata: {},
    });

    mockConversationsHistory.mockResolvedValue({
      messages: [{ ts: '1700000000.000', text: 'Hello <@U2>', user: 'U1', reply_count: 0 }],
    });

    const events: ConnectorDataEvent[] = [];
    await syncSlack(makeCtx(), (e) => events.push(e));

    const msgEvents = events.filter(
      (e: ConnectorDataEvent) => e.content.metadata?.type !== 'contact',
    );
    expect(msgEvents.length).toBe(1);
    const profiles = msgEvents[0].content.metadata.participantProfiles;
    expect(profiles).toBeDefined();

    // alice is the author, so she should be in participantProfiles
    // Profile uses realName as key since buildParticipantData uses realName || name
    expect(profiles['Alice Johnson']).toEqual(
      expect.objectContaining({
        name: 'alice',
        realName: 'Alice Johnson',
        email: 'alice@example.com',
        phone: '+1234567890',
      }),
    );
  });

  it('emits separate file events for message attachments', async () => {
    mockConversationsList.mockResolvedValue({
      channels: [{ id: 'C1', name: 'general' }],
      response_metadata: {},
    });

    mockConversationsHistory.mockResolvedValue({
      messages: [
        {
          ts: '1700000000.000',
          text: 'Check this out',
          user: 'U1',
          reply_count: 0,
          files: [
            {
              id: 'F1',
              name: 'report.pdf',
              mimetype: 'application/pdf',
              filetype: 'pdf',
              size: 12345,
              url_private: 'https://files.slack.com/files-pri/T123/report.pdf',
            },
            {
              id: 'F2',
              name: 'photo.png',
              mimetype: 'image/png',
              filetype: 'png',
              size: 54321,
              url_private: 'https://files.slack.com/files-pri/T123/photo.png',
            },
          ],
        },
      ],
    });

    const events: ConnectorDataEvent[] = [];
    await syncSlack(makeCtx(), (e) => events.push(e));

    // 2 contact events + 1 message + 2 file events = 5
    const msgEvents = events.filter(
      (e: ConnectorDataEvent) =>
        e.sourceType === 'message' && e.content.metadata?.type !== 'contact',
    );
    expect(msgEvents.length).toBe(1);
    expect(msgEvents[0].content.text).toContain('[file: report.pdf (pdf)]');

    // File events
    const fileEvents = events.filter((e: ConnectorDataEvent) => e.sourceType === 'file');
    expect(fileEvents.length).toBe(2);
    expect(fileEvents[0].content.metadata.fileName).toBe('report.pdf');
    expect(fileEvents[0].content.metadata.mimetype).toBe('application/pdf');
    expect(fileEvents[0].content.metadata.fileUrl).toBe(
      'https://files.slack.com/files-pri/T123/report.pdf',
    );
    expect(fileEvents[0].content.metadata.parentMessageId).toBe('C1:1700000000.000');
    expect(fileEvents[1].content.metadata.fileName).toBe('photo.png');
    expect(fileEvents[1].content.metadata.mimetype).toBe('image/png');
  });

  it('uses existing cursor state', async () => {
    const cursorState = JSON.stringify({ channels: { C1: '1700000000.000' } });

    mockConversationsList.mockResolvedValue({
      channels: [{ id: 'C1', name: 'general' }],
      response_metadata: {},
    });

    mockConversationsHistory.mockResolvedValue({ messages: [] });

    await syncSlack(makeCtx(cursorState), vi.fn());
    expect(mockConversationsHistory).toHaveBeenCalledWith(
      expect.objectContaining({ oldest: '1700000000.000' }),
    );
  });

  it('handles reactions on messages', async () => {
    mockConversationsList.mockResolvedValue({
      channels: [{ id: 'C1', name: 'general' }],
      response_metadata: {},
    });

    mockConversationsHistory.mockResolvedValue({
      messages: [
        {
          ts: '1700000000.000',
          text: 'Great work!',
          user: 'U1',
          reply_count: 0,
          reactions: [{ name: 'thumbsup', count: 1, users: ['U2'] }],
        },
      ],
    });

    const events: ConnectorDataEvent[] = [];
    await syncSlack(makeCtx(), (e) => events.push(e));

    const msgEvents = events.filter(
      (e: ConnectorDataEvent) => e.content.metadata?.type !== 'contact',
    );
    expect(msgEvents[0].content.text).toContain('Reactions:');
    expect(msgEvents[0].content.text).toContain('thumbsup');
    expect(msgEvents[0].content.metadata.reactions[0].name).toBe('thumbsup');
  });

  it('handles attachments with title, text, and from_url', async () => {
    mockConversationsList.mockResolvedValue({
      channels: [{ id: 'C1', name: 'general' }],
      response_metadata: {},
    });

    mockConversationsHistory.mockResolvedValue({
      messages: [
        {
          ts: '1700000000.000',
          text: 'Check this link',
          user: 'U1',
          reply_count: 0,
          attachments: [
            { title: 'Article', text: 'Summary of the article', from_url: 'https://example.com' },
          ],
        },
      ],
    });

    const events: ConnectorDataEvent[] = [];
    await syncSlack(makeCtx(), (e) => events.push(e));
    const msgEvents = events.filter(
      (e: ConnectorDataEvent) => e.content.metadata?.type !== 'contact',
    );
    expect(msgEvents[0].content.text).toContain('[link: Article');
    expect(msgEvents[0].content.text).toContain('Summary of the article');
    expect(msgEvents[0].content.text).toContain('https://example.com');
  });

  it('handles DM where self is sender and partner is recipient', async () => {
    mockConversationsList.mockResolvedValue({
      channels: [{ id: 'D1', is_im: true, user: 'U2' }],
      response_metadata: {},
    });

    mockConversationsHistory.mockResolvedValue({
      messages: [{ ts: '1700000000.000', text: 'Hey Bob', user: 'USELF', reply_count: 0 }],
    });

    const events: ConnectorDataEvent[] = [];
    await syncSlack(makeCtx(), (e) => events.push(e));
    const msgEvents = events.filter(
      (e: ConnectorDataEvent) => e.content.metadata?.type !== 'contact',
    );
    expect(msgEvents[0].content.metadata.isSelf).toBe(true);
    expect(msgEvents[0].content.metadata.channelType).toBe('dm');
  });

  it('handles group DM and private channel types', async () => {
    mockConversationsList.mockResolvedValue({
      channels: [
        { id: 'G1', name: 'mpdm-alice-bob', is_mpim: true },
        { id: 'P1', name: 'secret', is_private: true },
      ],
      response_metadata: {},
    });

    mockConversationsHistory.mockResolvedValue({
      messages: [{ ts: '1700000000.000', text: 'Hello', user: 'U1', reply_count: 0 }],
    });

    const events: ConnectorDataEvent[] = [];
    await syncSlack(makeCtx(), (e) => events.push(e));
    const msgEvents = events.filter(
      (e: ConnectorDataEvent) => e.content.metadata?.type !== 'contact',
    );
    expect(msgEvents[0].content.metadata.channelType).toBe('group-dm');
    expect(msgEvents[1].content.metadata.channelType).toBe('private-channel');
  });

  it('skips messages with no ts', async () => {
    mockConversationsList.mockResolvedValue({
      channels: [{ id: 'C1', name: 'general' }],
      response_metadata: {},
    });

    mockConversationsHistory.mockResolvedValue({
      messages: [
        { text: 'No timestamp', user: 'U1' },
        { ts: '1700000000.000', text: 'Valid', user: 'U1', reply_count: 0 },
      ],
    });

    const events: ConnectorDataEvent[] = [];
    await syncSlack(makeCtx(), (e) => events.push(e));
    const msgEvents = events.filter(
      (e: ConnectorDataEvent) => e.content.metadata?.type !== 'contact',
    );
    expect(msgEvents.length).toBe(1);
  });

  it('handles user mention with label fallback', async () => {
    mockConversationsList.mockResolvedValue({
      channels: [{ id: 'C1', name: 'general' }],
      response_metadata: {},
    });

    mockConversationsHistory.mockResolvedValue({
      messages: [
        { ts: '1700000000.000', text: 'Hi <@U999|unknown_user>', user: 'U1', reply_count: 0 },
      ],
    });

    const events: ConnectorDataEvent[] = [];
    await syncSlack(makeCtx(), (e) => events.push(e));
    const msgEvents = events.filter(
      (e: ConnectorDataEvent) => e.content.metadata?.type !== 'contact',
    );
    expect(msgEvents[0].content.text).toContain('@unknown_user');
  });

  it('normalizes links with and without labels', async () => {
    mockConversationsList.mockResolvedValue({
      channels: [{ id: 'C1', name: 'general' }],
      response_metadata: {},
    });

    mockConversationsHistory.mockResolvedValue({
      messages: [
        {
          ts: '1700000000.000',
          text: 'Visit <https://example.com|Example> and <https://test.com>',
          user: 'U1',
          reply_count: 0,
        },
      ],
    });

    const events: ConnectorDataEvent[] = [];
    await syncSlack(makeCtx(), (e) => events.push(e));
    const msgEvents = events.filter(
      (e: ConnectorDataEvent) => e.content.metadata?.type !== 'contact',
    );
    expect(msgEvents[0].content.text).toContain('Example (https://example.com)');
    expect(msgEvents[0].content.text).toContain('https://test.com');
  });

  it('paginates through conversation history', async () => {
    mockConversationsList.mockResolvedValue({
      channels: [{ id: 'C1', name: 'general' }],
      response_metadata: {},
    });

    mockConversationsHistory
      .mockResolvedValueOnce({
        messages: [{ ts: '1700000000.000', text: 'Page 1', user: 'U1', reply_count: 0 }],
        response_metadata: { next_cursor: 'page2' },
      })
      .mockResolvedValueOnce({
        messages: [{ ts: '1700000001.000', text: 'Page 2', user: 'U1', reply_count: 0 }],
        response_metadata: {},
      });

    const events: ConnectorDataEvent[] = [];
    await syncSlack(makeCtx(), (e) => events.push(e));
    const msgEvents = events.filter(
      (e: ConnectorDataEvent) => e.content.metadata?.type !== 'contact',
    );
    expect(msgEvents.length).toBe(2);
  });

  it('handles selfId fetch failure gracefully', async () => {
    mockAuthTest.mockRejectedValueOnce(new Error('auth fail'));

    mockConversationsList.mockResolvedValue({
      channels: [{ id: 'C1', name: 'general' }],
      response_metadata: {},
    });

    mockConversationsHistory.mockResolvedValue({
      messages: [{ ts: '1700000000.000', text: 'Hello', user: 'U1', reply_count: 0 }],
    });

    const events: ConnectorDataEvent[] = [];
    const ctx = makeCtx();
    await syncSlack(ctx, (e) => events.push(e));
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not identify self'),
    );
  });

  it('handles user list fetch failure gracefully', async () => {
    mockUsersList.mockRejectedValueOnce(new Error('users fail'));

    mockConversationsList.mockResolvedValue({
      channels: [{ id: 'C1', name: 'general' }],
      response_metadata: {},
    });

    mockConversationsHistory.mockResolvedValue({
      messages: [{ ts: '1700000000.000', text: 'Hello', user: 'U1', reply_count: 0 }],
    });

    const events: ConnectorDataEvent[] = [];
    await syncSlack(makeCtx(), (e) => events.push(e));
    // Should still emit message events even without user resolution
    const msgEvents = events.filter(
      (e: ConnectorDataEvent) => e.content.metadata?.type !== 'contact',
    );
    expect(msgEvents.length).toBe(1);
  });

  it('handles thread reply fetch failure gracefully', async () => {
    mockConversationsList.mockResolvedValue({
      channels: [{ id: 'C1', name: 'general' }],
      response_metadata: {},
    });

    mockConversationsHistory.mockResolvedValue({
      messages: [
        {
          ts: '1700000000.000',
          thread_ts: '1700000000.000',
          text: 'Parent',
          user: 'U1',
          reply_count: 3,
        },
      ],
    });

    mockConversationsReplies.mockRejectedValueOnce(new Error('replies fail'));

    const events: ConnectorDataEvent[] = [];
    await syncSlack(makeCtx(), (e) => events.push(e));
    const msgEvents = events.filter(
      (e: ConnectorDataEvent) => e.content.metadata?.type !== 'contact',
    );
    expect(msgEvents[0].content.text).not.toContain('--- thread replies ---');
  });

  it('filters bot messages (bot_id present)', async () => {
    mockConversationsList.mockResolvedValue({
      channels: [{ id: 'C1', name: 'general' }],
      response_metadata: {},
    });

    mockConversationsHistory.mockResolvedValue({
      messages: [{ ts: '1700000000.000', text: 'Bot message', bot_id: 'B123', reply_count: 0 }],
    });

    const events: ConnectorDataEvent[] = [];
    await syncSlack(makeCtx(), (e) => events.push(e));
    const msgEvents = events.filter(
      (e: ConnectorDataEvent) => e.content.metadata?.type !== 'contact',
    );
    // Bot messages are now filtered by noise filtering
    expect(msgEvents.length).toBe(0);
  });

  it('skips channels with no id', async () => {
    mockConversationsList.mockResolvedValue({
      channels: [{ name: 'no-id' }, { id: 'C1', name: 'valid' }],
      response_metadata: {},
    });

    mockConversationsHistory.mockResolvedValue({
      messages: [{ ts: '1700000000.000', text: 'Hi', user: 'U1', reply_count: 0 }],
    });

    const events: ConnectorDataEvent[] = [];
    await syncSlack(makeCtx(), (e) => events.push(e));
    // Should only get events from the valid channel
    const msgEvents = events.filter(
      (e: ConnectorDataEvent) => e.content.metadata?.type !== 'contact',
    );
    expect(msgEvents.length).toBe(1);
  });

  it('handles files without url_private or mimetype (skipped)', async () => {
    mockConversationsList.mockResolvedValue({
      channels: [{ id: 'C1', name: 'general' }],
      response_metadata: {},
    });

    mockConversationsHistory.mockResolvedValue({
      messages: [
        {
          ts: '1700000000.000',
          text: 'Files',
          user: 'U1',
          reply_count: 0,
          files: [
            { id: 'F1', name: 'no-url.txt' },
            {
              id: 'F2',
              name: 'valid.pdf',
              mimetype: 'application/pdf',
              url_private: 'https://files.slack.com/valid.pdf',
            },
          ],
        },
      ],
    });

    const events: ConnectorDataEvent[] = [];
    await syncSlack(makeCtx(), (e) => events.push(e));
    const fileEvents = events.filter((e: ConnectorDataEvent) => e.sourceType === 'file');
    expect(fileEvents.length).toBe(1); // Only the valid file
  });
});

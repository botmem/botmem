import { describe, it, expect, vi } from 'vitest';

const { mockConversationsList, mockConversationsHistory, mockConversationsReplies, mockUsersList } = vi.hoisted(() => ({
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

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(() => ({
    conversations: {
      list: mockConversationsList,
      history: mockConversationsHistory,
      replies: mockConversationsReplies,
    },
    users: {
      list: mockUsersList,
    },
  })),
}));

import { syncSlack } from '../sync.js';

const makeCtx = (cursor?: string) => ({
  accountId: 'acc-1',
  auth: { accessToken: 'xoxb-test' },
  cursor: cursor || null,
  jobId: 'j1',
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  signal: AbortSignal.timeout(5000),
});

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

    const events: any[] = [];
    const result = await syncSlack(makeCtx() as any, (e) => events.push(e));

    // 1 message per channel × 2 channels
    expect(result.processed).toBe(2);
    expect(events.length).toBe(2);

    // Verify conversation types requested
    expect(mockConversationsList).toHaveBeenCalledWith(
      expect.objectContaining({ types: 'public_channel,private_channel,im,mpim' }),
    );

    // Verify normalization and context prefix
    expect(events[0].content.text).toBe('[general] alice: @channel Hello @bob');
    expect(events[0].content.participants).toEqual(['alice']);
    expect(events[0].content.metadata.channelType).toBe('channel');

    // DM conversation
    expect(events[1].content.text).toBe('[DM with bob] alice: @channel Hello @bob');
    expect(events[1].content.metadata.channelType).toBe('dm');
    expect(events[1].content.metadata.channel).toBe('DM with bob');
  });

  it('fetches thread replies for messages with reply_count > 0', async () => {
    mockConversationsList.mockResolvedValue({
      channels: [{ id: 'C1', name: 'general' }],
      response_metadata: {},
    });

    mockConversationsHistory.mockResolvedValue({
      messages: [
        { ts: '1700000000.000', thread_ts: '1700000000.000', text: 'Parent message', user: 'U1', reply_count: 2 },
      ],
    });

    mockConversationsReplies.mockResolvedValue({
      messages: [
        { ts: '1700000000.000', text: 'Parent message', user: 'U1' },
        { ts: '1700000001.000', text: 'Reply one', user: 'U2' },
        { ts: '1700000002.000', text: 'Reply two', user: 'U1' },
      ],
    });

    const events: any[] = [];
    await syncSlack(makeCtx() as any, (e) => events.push(e));

    expect(events.length).toBe(1);
    expect(events[0].content.text).toContain('[general] alice: Parent message');
    expect(events[0].content.text).toContain('--- thread replies ---');
    expect(events[0].content.text).toContain('[bob]: Reply one');
    expect(events[0].content.text).toContain('[alice]: Reply two');
    expect(events[0].content.metadata.replyCount).toBe(2);

    // Thread participants included
    expect(events[0].content.participants).toContain('alice');
    expect(events[0].content.participants).toContain('bob');
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

    const events: any[] = [];
    const result = await syncSlack(makeCtx() as any, (e) => events.push(e));
    expect(result.processed).toBe(1);
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
      messages: [
        { ts: '1700000000.000', text: 'Hello <@U2>', user: 'U1', reply_count: 0 },
      ],
    });

    const events: any[] = [];
    await syncSlack(makeCtx() as any, (e) => events.push(e));

    expect(events.length).toBe(1);
    const profiles = events[0].content.metadata.participantProfiles;
    expect(profiles).toBeDefined();

    // alice is the author, so she should be in participantProfiles
    expect(profiles['alice']).toEqual({
      name: 'alice',
      realName: 'Alice Johnson',
      email: 'alice@example.com',
      phone: '+1234567890',
      title: 'Engineer',
      avatarUrl: 'https://avatars.slack.com/alice_72.png',
    });
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

    const events: any[] = [];
    await syncSlack(makeCtx() as any, (e) => events.push(e));

    // 1 message + 2 file events
    expect(events.length).toBe(3);

    // The message event
    expect(events[0].sourceType).toBe('message');
    expect(events[0].content.text).toContain('[file: report.pdf (pdf)]');

    // File events
    const fileEvents = events.filter((e) => e.sourceType === 'file');
    expect(fileEvents.length).toBe(2);
    expect(fileEvents[0].content.metadata.fileName).toBe('report.pdf');
    expect(fileEvents[0].content.metadata.mimetype).toBe('application/pdf');
    expect(fileEvents[0].content.metadata.fileUrl).toBe('https://files.slack.com/files-pri/T123/report.pdf');
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

    await syncSlack(makeCtx(cursorState) as any, vi.fn());
    expect(mockConversationsHistory).toHaveBeenCalledWith(
      expect.objectContaining({ oldest: '1700000000.000' }),
    );
  });
});

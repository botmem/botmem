import { describe, it, expect, vi } from 'vitest';

const { mockConversationsList, mockConversationsHistory } = vi.hoisted(() => ({
  mockConversationsList: vi.fn(),
  mockConversationsHistory: vi.fn(),
}));

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(() => ({
    conversations: {
      list: mockConversationsList,
      history: mockConversationsHistory,
    },
  })),
}));

import { syncSlack } from '../sync.js';

describe('syncSlack', () => {
  it('syncs messages from channels', async () => {
    mockConversationsList.mockResolvedValue({
      channels: [
        { id: 'C1', name: 'general' },
        { id: 'C2', name: 'random' },
      ],
      response_metadata: { next_cursor: '' },
    });

    mockConversationsHistory.mockResolvedValue({
      messages: [
        { ts: '1700000000.000', text: 'Hello', user: 'U1' },
        { ts: '1700000001.000', text: 'World', user: 'U2' },
      ],
    });

    const events: any[] = [];
    const ctx = {
      accountId: 'acc-1',
      auth: { accessToken: 'xoxb-test' },
      cursor: null,
      jobId: 'j1',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      signal: AbortSignal.timeout(5000),
    };

    const result = await syncSlack(ctx as any, (e) => events.push(e));

    expect(result.processed).toBe(4); // 2 messages × 2 channels
    expect(result.hasMore).toBe(false);
    expect(events.length).toBe(4);
    expect(events[0].sourceType).toBe('message');
    expect(events[0].content.metadata.channel).toBe('general');
  });

  it('skips messages with subtype', async () => {
    mockConversationsList.mockResolvedValue({
      channels: [{ id: 'C1', name: 'general' }],
      response_metadata: {},
    });

    mockConversationsHistory.mockResolvedValue({
      messages: [
        { ts: '1700000000.000', text: 'Normal', user: 'U1' },
        { ts: '1700000001.000', text: 'Bot joined', user: 'U2', subtype: 'channel_join' },
      ],
    });

    const events: any[] = [];
    const ctx = {
      accountId: 'acc-1',
      auth: { accessToken: 'tok' },
      cursor: null,
      jobId: 'j1',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      signal: AbortSignal.timeout(5000),
    };

    const result = await syncSlack(ctx as any, (e) => events.push(e));
    expect(result.processed).toBe(1);
  });

  it('uses existing cursor state', async () => {
    const cursorState = JSON.stringify({ channels: { C1: '1700000000.000' } });

    mockConversationsList.mockResolvedValue({
      channels: [{ id: 'C1', name: 'general' }],
      response_metadata: {},
    });

    mockConversationsHistory.mockResolvedValue({ messages: [] });

    const ctx = {
      accountId: 'acc-1',
      auth: { accessToken: 'tok' },
      cursor: cursorState,
      jobId: 'j1',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      signal: AbortSignal.timeout(5000),
    };

    await syncSlack(ctx as any, vi.fn());
    expect(mockConversationsHistory).toHaveBeenCalledWith(
      expect.objectContaining({ oldest: '1700000000.000' }),
    );
  });
});

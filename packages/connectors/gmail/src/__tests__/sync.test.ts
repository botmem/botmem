import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockList, mockGet, mockGetProfile } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockGet: vi.fn(),
  mockGetProfile: vi.fn(),
}));

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: vi.fn().mockImplementation(() => ({
        setCredentials: vi.fn(),
      })),
    },
    gmail: vi.fn().mockReturnValue({
      users: {
        messages: {
          list: mockList,
          get: mockGet,
        },
        getProfile: mockGetProfile,
      },
    }),
  },
}));

import { syncGmail } from '../sync.js';

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acc-1',
    auth: { accessToken: 'tok', refreshToken: 'rt' },
    cursor: null,
    jobId: 'j1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    signal: AbortSignal.timeout(5000),
    ...overrides,
  } as any;
}

describe('syncGmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProfile.mockResolvedValue({ data: { messagesTotal: 100 } });
  });

  it('syncs messages and emits events', async () => {
    mockList.mockResolvedValue({
      data: {
        messages: [{ id: 'msg-1' }, { id: 'msg-2' }],
        nextPageToken: 'page2',
        resultSizeEstimate: 100,
      },
    });

    mockGet.mockImplementation(async (opts: any) => ({
      data: {
        id: opts.id,
        payload: {
          headers: [
            { name: 'Subject', value: `Email ${opts.id}` },
            { name: 'From', value: 'sender@test.com' },
            { name: 'To', value: 'receiver@test.com' },
            { name: 'Date', value: '2026-01-01T12:00:00Z' },
          ],
        },
        snippet: 'Hello world',
        labelIds: ['INBOX'],
      },
    }));

    const events: any[] = [];
    const progressEvents: any[] = [];

    const result = await syncGmail(makeCtx(), (e) => events.push(e), (p) => progressEvents.push(p));

    expect(result.processed).toBe(2);
    expect(result.hasMore).toBe(true);
    expect(result.cursor).toBe('page2');
    expect(events).toHaveLength(2);
    expect(events[0].sourceType).toBe('email');
    expect(events[0].content.text).toContain('Email msg-1');
    expect(progressEvents.length).toBeGreaterThan(0);
    expect(progressEvents[0].total).toBe(100);
  });

  it('handles empty message list', async () => {
    mockList.mockResolvedValue({ data: { messages: [], nextPageToken: null } });

    const events: any[] = [];
    const result = await syncGmail(makeCtx(), (e) => events.push(e), vi.fn());
    expect(result.processed).toBe(0);
    expect(result.hasMore).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('passes cursor as pageToken', async () => {
    mockList.mockResolvedValue({ data: { messages: [], nextPageToken: null } });

    await syncGmail(makeCtx({ cursor: 'existing-cursor' }), vi.fn(), vi.fn());
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ pageToken: 'existing-cursor' }));
  });

  it('fetches messages in parallel', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => ({ id: `msg-${i}` }));
    mockList.mockResolvedValue({ data: { messages: ids, nextPageToken: null, resultSizeEstimate: 25 } });
    mockGet.mockImplementation(async (opts: any) => ({
      data: {
        id: opts.id,
        payload: { headers: [{ name: 'Subject', value: 'Test' }] },
        snippet: 'body',
        labelIds: [],
      },
    }));

    const events: any[] = [];
    const result = await syncGmail(makeCtx(), (e) => events.push(e), vi.fn());
    expect(result.processed).toBe(25);
    expect(events).toHaveLength(25);
    // All 25 messages fetched via get
    expect(mockGet).toHaveBeenCalledTimes(25);
  });
});

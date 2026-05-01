import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SyncContext, ConnectorDataEvent, ProgressEvent } from '@botmem/connector-sdk';

const { mockList, mockGet, mockGetProfile, mockHistoryList } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockGet: vi.fn(),
  mockGetProfile: vi.fn(),
  mockHistoryList: vi.fn(),
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
        history: {
          list: mockHistoryList,
        },
        getProfile: mockGetProfile,
      },
    }),
  },
}));

import { syncGmail } from '../sync.js';

function makeCtx(overrides: Record<string, unknown> = {}): SyncContext {
  return {
    accountId: 'acc-1',
    auth: { accessToken: 'tok', refreshToken: 'rt' },
    cursor: null,
    jobId: 'j1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    signal: AbortSignal.timeout(5000),
    ...overrides,
  } as SyncContext;
}

describe('syncGmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProfile.mockResolvedValue({ data: { messagesTotal: 100, historyId: 'hist-100' } });
  });

  it('syncs messages and emits events', async () => {
    mockList.mockResolvedValue({
      data: {
        messages: [{ id: 'msg-1' }, { id: 'msg-2' }],
        nextPageToken: 'page2',
        resultSizeEstimate: 100,
      },
    });

    mockGet.mockImplementation(async (opts: { id: string }) => ({
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

    const events: ConnectorDataEvent[] = [];
    const progressEvents: ProgressEvent[] = [];

    const result = await syncGmail(
      makeCtx(),
      (e) => events.push(e),
      (p) => progressEvents.push(p),
    );

    expect(result.processed).toBe(2);
    expect(result.hasMore).toBe(true);
    expect(JSON.parse(result.cursor!)).toEqual({
      kind: 'gmail',
      version: 1,
      mode: 'backfill',
      pageToken: 'page2',
      targetHistoryId: 'hist-100',
    });
    expect(events).toHaveLength(2);
    expect(events[0].sourceType).toBe('email');
    expect(events[0].content.text).toContain('Email msg-1');
    expect(progressEvents.length).toBeGreaterThan(0);
    expect(progressEvents[0].total).toBe(100);
  });

  it('skips unavailable messages without failing the sync', async () => {
    mockList.mockResolvedValue({
      data: {
        messages: [{ id: 'msg-1' }, { id: 'msg-deleted' }, { id: 'msg-2' }],
        nextPageToken: null,
      },
    });

    mockGet.mockImplementation(async (opts: { id: string }) => {
      if (opts.id === 'msg-deleted') {
        const err = new Error('Requested entity was not found.') as Error & { code: number };
        err.code = 404;
        throw err;
      }
      return {
        data: {
          id: opts.id,
          payload: {
            headers: [
              { name: 'Subject', value: `Email ${opts.id}` },
              { name: 'From', value: 'sender@test.com' },
              { name: 'To', value: 'receiver@test.com' },
            ],
          },
          labelIds: ['INBOX'],
        },
      };
    });

    const ctx = makeCtx();
    const events: ConnectorDataEvent[] = [];

    const result = await syncGmail(ctx, (e) => events.push(e), vi.fn());

    expect(result.processed).toBe(2);
    expect(events.map((event) => event.sourceId)).toEqual(['msg-1', 'msg-2']);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Skipping unavailable Gmail message msg-deleted'),
    );
  });

  it('handles empty message list', async () => {
    mockList.mockResolvedValue({ data: { messages: [], nextPageToken: null } });

    const events: ConnectorDataEvent[] = [];
    const result = await syncGmail(makeCtx(), (e) => events.push(e), vi.fn());
    expect(result.processed).toBe(0);
    expect(result.hasMore).toBe(false);
    expect(JSON.parse(result.cursor!)).toEqual({
      kind: 'gmail',
      version: 1,
      mode: 'history',
      historyId: 'hist-100',
    });
    expect(events).toHaveLength(0);
  });

  it('resumes backfill cursors as pageToken', async () => {
    mockList.mockResolvedValue({ data: { messages: [], nextPageToken: null } });

    await syncGmail(
      makeCtx({
        cursor: JSON.stringify({
          kind: 'gmail',
          version: 1,
          mode: 'backfill',
          pageToken: 'existing-cursor',
          targetHistoryId: 'hist-100',
        }),
      }),
      vi.fn(),
      vi.fn(),
    );
    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ pageToken: 'existing-cursor' }),
    );
  });

  it('ignores legacy raw page-token cursors and starts backfill from the first page', async () => {
    mockList.mockResolvedValue({ data: { messages: [], nextPageToken: null } });
    const ctx = makeCtx({ cursor: 'legacy-page-token' });

    await syncGmail(ctx, vi.fn(), vi.fn());

    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ pageToken: undefined }));
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring legacy Gmail page cursor'),
    );
  });

  it('uses Gmail history for established cursors', async () => {
    mockHistoryList.mockResolvedValue({
      data: {
        history: [
          {
            messagesAdded: [{ message: { id: 'msg-1' } }, { message: { id: 'msg-1' } }],
          },
          {
            messagesAdded: [{ message: { id: 'msg-2' } }],
          },
        ],
        historyId: 'hist-200',
      },
    });
    mockGet.mockImplementation(async (opts: { id: string }) => ({
      data: {
        id: opts.id,
        payload: {
          headers: [
            { name: 'Subject', value: `Email ${opts.id}` },
            { name: 'From', value: 'sender@test.com' },
            { name: 'To', value: 'receiver@test.com' },
          ],
        },
        labelIds: ['INBOX'],
      },
    }));

    const events: ConnectorDataEvent[] = [];
    const result = await syncGmail(
      makeCtx({
        cursor: JSON.stringify({
          kind: 'gmail',
          version: 1,
          mode: 'history',
          historyId: 'hist-100',
        }),
      }),
      (e) => events.push(e),
      vi.fn(),
    );

    expect(mockHistoryList).toHaveBeenCalledWith(
      expect.objectContaining({ startHistoryId: 'hist-100' }),
    );
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(2);
    expect(result.hasMore).toBe(false);
    expect(JSON.parse(result.cursor!)).toEqual({
      kind: 'gmail',
      version: 1,
      mode: 'history',
      historyId: 'hist-200',
    });
  });

  it('fetches messages in parallel', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => ({ id: `msg-${i}` }));
    mockList.mockResolvedValue({
      data: { messages: ids, nextPageToken: null, resultSizeEstimate: 25 },
    });
    mockGet.mockImplementation(async (opts: { id: string }) => ({
      data: {
        id: opts.id,
        payload: { headers: [{ name: 'Subject', value: 'Test' }] },
        snippet: 'body',
        labelIds: [],
      },
    }));

    const events: ConnectorDataEvent[] = [];
    const result = await syncGmail(makeCtx(), (e) => events.push(e), vi.fn());
    expect(result.processed).toBe(25);
    expect(events).toHaveLength(25);
    // All 25 messages fetched via get
    expect(mockGet).toHaveBeenCalledTimes(25);
  });

  it('uses internalDate when available', async () => {
    mockList.mockResolvedValue({ data: { messages: [{ id: 'msg-1' }], nextPageToken: null } });
    mockGet.mockResolvedValue({
      data: {
        id: 'msg-1',
        internalDate: '1704067200000', // 2024-01-01T00:00:00Z
        payload: { headers: [{ name: 'Subject', value: 'Test' }] },
        labelIds: [],
      },
    });

    const events: ConnectorDataEvent[] = [];
    await syncGmail(makeCtx(), (e) => events.push(e), vi.fn());
    expect(events[0].timestamp).toBe('2024-01-01T00:00:00.000Z');
  });

  it('falls back to Date header when no internalDate', async () => {
    mockList.mockResolvedValue({ data: { messages: [{ id: 'msg-1' }], nextPageToken: null } });
    mockGet.mockResolvedValue({
      data: {
        id: 'msg-1',
        payload: {
          headers: [
            { name: 'Subject', value: 'Test' },
            { name: 'Date', value: '2024-06-15T10:30:00Z' },
          ],
        },
        labelIds: [],
      },
    });

    const events: ConnectorDataEvent[] = [];
    await syncGmail(makeCtx(), (e) => events.push(e), vi.fn());
    expect(events[0].timestamp).toBe('2024-06-15T10:30:00.000Z');
  });

  it('falls back to now when Date header is invalid', async () => {
    mockList.mockResolvedValue({ data: { messages: [{ id: 'msg-1' }], nextPageToken: null } });
    mockGet.mockResolvedValue({
      data: {
        id: 'msg-1',
        payload: {
          headers: [
            { name: 'Subject', value: 'Test' },
            { name: 'Date', value: 'not-a-date' },
          ],
        },
        labelIds: [],
      },
    });

    const events: ConnectorDataEvent[] = [];
    await syncGmail(makeCtx(), (e) => events.push(e), vi.fn());
    // Should be a valid ISO date (today-ish)
    expect(new Date(events[0].timestamp).getTime()).not.toBeNaN();
  });

  it('extracts HTML body and strips tags', async () => {
    const htmlBody = Buffer.from('<html><body><p>Hello <b>World</b></p></body></html>').toString(
      'base64url',
    );
    mockList.mockResolvedValue({ data: { messages: [{ id: 'msg-1' }], nextPageToken: null } });
    mockGet.mockResolvedValue({
      data: {
        id: 'msg-1',
        internalDate: '1704067200000',
        payload: {
          mimeType: 'text/html',
          headers: [{ name: 'Subject', value: 'HTML email' }],
          body: { data: htmlBody },
        },
        labelIds: [],
      },
    });

    const events: ConnectorDataEvent[] = [];
    await syncGmail(makeCtx(), (e) => events.push(e), vi.fn());
    expect(events[0].content.text).toContain('Hello');
    expect(events[0].content.text).toContain('World');
    expect(events[0].content.text).not.toContain('<b>');
  });

  it('extracts plain text body from multipart', async () => {
    const textBody = Buffer.from('Plain text body').toString('base64url');
    mockList.mockResolvedValue({ data: { messages: [{ id: 'msg-1' }], nextPageToken: null } });
    mockGet.mockResolvedValue({
      data: {
        id: 'msg-1',
        internalDate: '1704067200000',
        payload: {
          mimeType: 'multipart/alternative',
          headers: [{ name: 'Subject', value: 'Multi' }],
          parts: [
            { mimeType: 'text/plain', body: { data: textBody } },
            {
              mimeType: 'text/html',
              body: { data: Buffer.from('<p>HTML</p>').toString('base64url') },
            },
          ],
        },
        labelIds: [],
      },
    });

    const events: ConnectorDataEvent[] = [];
    await syncGmail(makeCtx(), (e) => events.push(e), vi.fn());
    expect(events[0].content.text).toContain('Plain text body');
  });

  it('falls back to HTML part when no text part in multipart', async () => {
    mockList.mockResolvedValue({ data: { messages: [{ id: 'msg-1' }], nextPageToken: null } });
    mockGet.mockResolvedValue({
      data: {
        id: 'msg-1',
        internalDate: '1704067200000',
        payload: {
          mimeType: 'multipart/alternative',
          headers: [{ name: 'Subject', value: 'HTML only' }],
          parts: [
            {
              mimeType: 'text/html',
              body: { data: Buffer.from('<div>Content</div>').toString('base64url') },
            },
          ],
        },
        labelIds: [],
      },
    });

    const events: ConnectorDataEvent[] = [];
    await syncGmail(makeCtx(), (e) => events.push(e), vi.fn());
    expect(events[0].content.text).toContain('Content');
  });

  it('handles nested multipart parts', async () => {
    const textBody = Buffer.from('Nested text').toString('base64url');
    mockList.mockResolvedValue({ data: { messages: [{ id: 'msg-1' }], nextPageToken: null } });
    mockGet.mockResolvedValue({
      data: {
        id: 'msg-1',
        internalDate: '1704067200000',
        payload: {
          mimeType: 'multipart/mixed',
          headers: [{ name: 'Subject', value: 'Nested' }],
          parts: [
            {
              mimeType: 'multipart/alternative',
              parts: [{ mimeType: 'text/plain', body: { data: textBody } }],
            },
          ],
        },
        labelIds: [],
      },
    });

    const events: ConnectorDataEvent[] = [];
    await syncGmail(makeCtx(), (e) => events.push(e), vi.fn());
    expect(events[0].content.text).toContain('Nested text');
  });

  it('extracts attachments from parts', async () => {
    mockList.mockResolvedValue({ data: { messages: [{ id: 'msg-1' }], nextPageToken: null } });
    mockGet.mockResolvedValue({
      data: {
        id: 'msg-1',
        internalDate: '1704067200000',
        payload: {
          headers: [{ name: 'Subject', value: 'With attachment' }],
          parts: [
            { mimeType: 'text/plain', body: { data: Buffer.from('Hi').toString('base64url') } },
            {
              filename: 'report.pdf',
              mimeType: 'application/pdf',
              body: { attachmentId: 'att-123', size: 1024 },
            },
          ],
        },
        labelIds: [],
      },
    });

    const events: ConnectorDataEvent[] = [];
    await syncGmail(makeCtx(), (e) => events.push(e), vi.fn());
    expect(events[0].content.attachments).toHaveLength(1);
    expect(events[0].content.attachments![0].uri).toBe('gmail://attachment/att-123');
    expect((events[0].content.attachments![0] as { filename?: string }).filename).toBe(
      'report.pdf',
    );
  });

  it('uses clientId/clientSecret from auth.raw', async () => {
    mockList.mockResolvedValue({ data: { messages: [], nextPageToken: null } });

    const ctx = makeCtx({
      auth: {
        accessToken: 'tok',
        refreshToken: 'rt',
        raw: { clientId: 'cid', clientSecret: 'cs', redirectUri: 'http://redirect' },
      },
    });

    await syncGmail(ctx, vi.fn(), vi.fn());
    // Should not throw — just verify it runs
    expect(mockList).toHaveBeenCalled();
  });

  it('includes cc and message headers in metadata', async () => {
    mockList.mockResolvedValue({ data: { messages: [{ id: 'msg-1' }], nextPageToken: null } });
    mockGet.mockResolvedValue({
      data: {
        id: 'msg-1',
        internalDate: '1704067200000',
        payload: {
          headers: [
            { name: 'Subject', value: 'Test' },
            { name: 'From', value: 'a@test.com' },
            { name: 'To', value: 'b@test.com' },
            { name: 'Cc', value: 'c@test.com' },
            { name: 'Message-ID', value: '<mid@test>' },
            { name: 'In-Reply-To', value: '<parent@test>' },
          ],
        },
        threadId: 'thread-1',
        labelIds: ['INBOX'],
        snippet: 'Test snippet',
        sizeEstimate: 5000,
      },
    });

    const events: ConnectorDataEvent[] = [];
    await syncGmail(makeCtx(), (e) => events.push(e), vi.fn());
    expect(events[0].content.metadata.cc).toBe('c@test.com');
    expect(events[0].content.metadata.messageId).toBe('<mid@test>');
    expect(events[0].content.metadata.inReplyTo).toBe('<parent@test>');
    expect(events[0].content.metadata.threadId).toBe('thread-1');
  });
});

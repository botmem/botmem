import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IMessageConnector } from '../index.js';

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn();
const mockChatsList = vi.fn().mockResolvedValue([
  {
    id: 1,
    name: 'Chat 1',
    identifier: '+1234567890',
    service: 'iMessage',
    last_message_at: '2025-01-01T00:00:00Z',
  },
]);
const mockMessagesHistory = vi.fn().mockResolvedValue([
  {
    id: 101,
    chat_id: 1,
    guid: 'guid-1',
    sender: '+1234567890',
    is_from_me: false,
    text: 'Hello',
    created_at: '2025-01-01T12:00:00Z',
    attachments: [],
    reactions: [],
    chat_identifier: '+1234567890',
    chat_name: 'Chat 1',
    participants: ['+1234567890', '+0987654321'],
    is_group: false,
  },
]);

vi.mock('../imsg-client.js', () => ({
  ImsgClient: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    disconnect: mockDisconnect,
    chatsList: mockChatsList,
    messagesHistory: mockMessagesHistory,
  })),
}));

describe('IMessageConnector', () => {
  let connector: IMessageConnector;

  beforeEach(() => {
    connector = new IMessageConnector();
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockChatsList.mockResolvedValue([
      {
        id: 1,
        name: 'Chat 1',
        identifier: '+1234567890',
        service: 'iMessage',
        last_message_at: '2025-01-01T00:00:00Z',
      },
    ]);
    mockMessagesHistory.mockResolvedValue([
      {
        id: 101,
        chat_id: 1,
        guid: 'guid-1',
        sender: '+1234567890',
        is_from_me: false,
        text: 'Hello',
        created_at: '2025-01-01T12:00:00Z',
        attachments: [],
        reactions: [],
        chat_identifier: '+1234567890',
        chat_name: 'Chat 1',
        participants: ['+1234567890', '+0987654321'],
        is_group: false,
      },
    ]);
  });

  describe('manifest', () => {
    it('has correct id', () => {
      expect(connector.manifest.id).toBe('imessage');
    });

    it('has local-tool auth type', () => {
      expect(connector.manifest.authType).toBe('local-tool');
    });

    it('has configSchema with imsgHost and imsgPort properties', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const schema = connector.manifest.configSchema as any;
      expect(schema.properties).toHaveProperty('imsgHost');
      expect(schema.properties).toHaveProperty('imsgPort');
      expect(schema.properties.imsgHost.type).toBe('string');
      expect(schema.properties.imsgPort.type).toBe('number');
    });
  });

  describe('initiateAuth', () => {
    it('returns complete with auth context containing host and port', async () => {
      const result = await connector.initiateAuth({
        imsgHost: '192.168.1.100',
        imsgPort: 19876,
      });

      expect(result.type).toBe('complete');
      if (result.type === 'complete') {
        expect(result.auth.raw).toEqual({
          imsgHost: '192.168.1.100',
          imsgPort: 19876,
          myIdentifier: '',
        });
      }
      expect(mockConnect).toHaveBeenCalledOnce();
      expect(mockChatsList).toHaveBeenCalledWith(1);
      expect(mockDisconnect).toHaveBeenCalledOnce();
    });

    it('uses default host and port when not provided', async () => {
      const result = await connector.initiateAuth({});

      expect(result.type).toBe('complete');
      if (result.type === 'complete') {
        expect(result.auth.raw).toEqual({
          imsgHost: 'localhost',
          imsgPort: 19876,
          myIdentifier: '',
        });
      }
    });

    it('throws when connect fails', async () => {
      mockConnect.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(connector.initiateAuth({})).rejects.toThrow(/Cannot connect to imsg bridge/);
    });
  });

  describe('completeAuth', () => {
    it('returns auth with host, port, and myIdentifier', async () => {
      const auth = await connector.completeAuth({
        imsgHost: '10.0.0.1',
        imsgPort: 9999,
        myIdentifier: 'me@icloud.com',
      });

      expect(auth.raw).toEqual({
        imsgHost: '10.0.0.1',
        imsgPort: 9999,
        myIdentifier: 'me@icloud.com',
      });
    });

    it('uses defaults when params are empty', async () => {
      const auth = await connector.completeAuth({});
      expect(auth.raw).toEqual({
        imsgHost: 'localhost',
        imsgPort: 19876,
        myIdentifier: '',
      });
    });
  });

  describe('validateAuth', () => {
    it('returns true on success', async () => {
      const result = await connector.validateAuth({
        raw: { imsgHost: 'localhost', imsgPort: 19876 },
      });

      expect(result).toBe(true);
      expect(mockConnect).toHaveBeenCalledOnce();
      expect(mockChatsList).toHaveBeenCalledWith(1);
      expect(mockDisconnect).toHaveBeenCalledOnce();
    });

    it('returns false on error', async () => {
      mockConnect.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await connector.validateAuth({
        raw: { imsgHost: 'localhost', imsgPort: 19876 },
      });

      expect(result).toBe(false);
    });
  });

  describe('revokeAuth', () => {
    it('does not throw', async () => {
      await expect(connector.revokeAuth()).resolves.toBeUndefined();
    });
  });

  describe('sync', () => {
    const makeSyncCtx = (overrides: Record<string, unknown> = {}) => ({
      accountId: 'acc-1',
      auth: { raw: { imsgHost: 'localhost', imsgPort: 19876 } },
      cursor: null as string | null,
      jobId: 'j1',
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      signal: AbortSignal.timeout(5000),
      ...overrides,
    });

    it('calls chatsList and messagesHistory, emits events, returns correct result', async () => {
      const dataListener = vi.fn();
      connector.on('data', dataListener);

      const ctx = makeSyncCtx();
      const result = await connector.sync(ctx as any);

      expect(mockConnect).toHaveBeenCalledOnce();
      expect(mockChatsList).toHaveBeenCalledWith(10_000);
      expect(mockMessagesHistory).toHaveBeenCalledWith(1, { start: undefined });

      expect(dataListener).toHaveBeenCalledOnce();
      expect(dataListener).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceType: 'message',
          sourceId: 'guid-1',
          timestamp: '2025-01-01T12:00:00Z',
          content: expect.objectContaining({
            text: 'Hello',
            participants: ['+1234567890', '+0987654321'],
          }),
        }),
      );

      expect(result.processed).toBe(1);
      expect(result.hasMore).toBe(false);
      expect(result.cursor).toBe('2025-01-01T12:00:00Z');
    });

    it('uses cursor as start param when provided', async () => {
      const ctx = makeSyncCtx({ cursor: '2025-01-01T00:00:00Z' });
      await connector.sync(ctx as any);

      expect(mockMessagesHistory).toHaveBeenCalledWith(1, {
        start: '2025-01-01T00:00:00.001Z',
      });
    });

    it('disconnects even on error (try/finally)', async () => {
      mockChatsList.mockRejectedValueOnce(new Error('RPC error'));

      const ctx = makeSyncCtx();
      await expect(connector.sync(ctx as any)).rejects.toThrow('RPC error');

      expect(mockDisconnect).toHaveBeenCalledOnce();
    });

    it('returns existing cursor when no messages are found', async () => {
      mockMessagesHistory.mockResolvedValueOnce([]);
      const ctx = makeSyncCtx({ cursor: '2024-12-01T00:00:00Z' });

      const result = await connector.sync(ctx as any);

      expect(result.cursor).toBe('2024-12-01T00:00:00Z');
      expect(result.processed).toBe(0);
    });
  });

  describe('embed', () => {
    it('resolves email sender when isFromMe with email identifier', () => {
      const event = {
        sourceType: 'message' as const,
        sourceId: 'guid-1',
        timestamp: '2025-01-01T12:00:00Z',
        content: {
          text: 'Hello',
          participants: ['+1234567890'],
          metadata: { isFromMe: true, isGroup: false },
        },
      };
      const ctx = { accountId: 'a', auth: { raw: { myIdentifier: 'me@icloud.com' } }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
      const result = connector.embed(event, 'Hello', ctx as any);
      expect(result.entities).toContainEqual({ type: 'person', id: 'email:me@icloud.com', role: 'sender' });
      // Participant is recipient since isFromMe=true
      expect(result.entities).toContainEqual({ type: 'person', id: 'phone:+1234567890', role: 'recipient' });
    });

    it('resolves phone sender when isFromMe with phone identifier', () => {
      const event = {
        sourceType: 'message' as const,
        sourceId: 'guid-1',
        timestamp: '2025-01-01T12:00:00Z',
        content: {
          text: 'Hello',
          participants: ['bob@email.com'],
          metadata: { isFromMe: true, isGroup: false },
        },
      };
      const ctx = { accountId: 'a', auth: { raw: { myIdentifier: '+1234567890' } }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
      const result = connector.embed(event, 'Hello', ctx as any);
      expect(result.entities).toContainEqual({ type: 'person', id: 'phone:+1234567890', role: 'sender' });
      expect(result.entities).toContainEqual({ type: 'person', id: 'email:bob@email.com', role: 'recipient' });
    });

    it('resolves participant as sender when not isFromMe', () => {
      const event = {
        sourceType: 'message' as const,
        sourceId: 'guid-1',
        timestamp: '2025-01-01T12:00:00Z',
        content: {
          text: 'Hello',
          participants: ['+1234567890'],
          metadata: { isFromMe: false },
        },
      };
      const ctx = { accountId: 'a', auth: { raw: { myIdentifier: 'me@icloud.com' } }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
      const result = connector.embed(event, 'Hello', ctx as any);
      expect(result.entities).toContainEqual({ type: 'person', id: 'phone:+1234567890', role: 'sender' });
    });

    it('skips self in participant list', () => {
      const event = {
        sourceType: 'message' as const,
        sourceId: 'guid-1',
        timestamp: '2025-01-01T12:00:00Z',
        content: {
          text: 'Hello',
          participants: ['me@icloud.com', '+5551234'],
          metadata: { isFromMe: true },
        },
      };
      const ctx = { accountId: 'a', auth: { raw: { myIdentifier: 'me@icloud.com' } }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
      const result = connector.embed(event, 'Hello', ctx as any);
      const personEntities = result.entities.filter(e => e.type === 'person');
      // Should have sender (me) + 1 recipient (not self)
      expect(personEntities).toHaveLength(2);
      expect(personEntities).not.toContainEqual(expect.objectContaining({ id: 'email:me@icloud.com', role: 'recipient' }));
    });

    it('extracts group entity when isGroup with chatName', () => {
      const event = {
        sourceType: 'message' as const,
        sourceId: 'guid-1',
        timestamp: '2025-01-01T12:00:00Z',
        content: {
          text: 'Hello group',
          participants: [],
          metadata: { isFromMe: false, isGroup: true, chatName: 'Family Chat' },
        },
      };
      const ctx = { accountId: 'a', auth: { raw: {} }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
      const result = connector.embed(event, 'Hello group', ctx as any);
      expect(result.entities).toContainEqual({ type: 'group', id: 'name:Family Chat', role: 'group' });
    });

    it('does not extract group entity when isGroup is false', () => {
      const event = {
        sourceType: 'message' as const,
        sourceId: 'guid-1',
        timestamp: '2025-01-01T12:00:00Z',
        content: { text: 'Hi', participants: [], metadata: { isGroup: false } },
      };
      const ctx = { accountId: 'a', auth: { raw: {} }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
      const result = connector.embed(event, 'Hi', ctx as any);
      expect(result.entities.filter(e => e.type === 'group')).toHaveLength(0);
    });

    it('skips empty participant names', () => {
      const event = {
        sourceType: 'message' as const,
        sourceId: 'guid-1',
        timestamp: '2025-01-01T12:00:00Z',
        content: { text: 'Hi', participants: ['', '+1234567890'], metadata: {} },
      };
      const ctx = { accountId: 'a', auth: { raw: {} }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
      const result = connector.embed(event, 'Hi', ctx as any);
      expect(result.entities).toHaveLength(1);
    });

    it('handles no myIdentifier gracefully', () => {
      const event = {
        sourceType: 'message' as const,
        sourceId: 'guid-1',
        timestamp: '2025-01-01T12:00:00Z',
        content: { text: 'Hi', participants: ['+1234567890'], metadata: { isFromMe: true } },
      };
      const ctx = { accountId: 'a', auth: { raw: {} }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
      const result = connector.embed(event, 'Hi', ctx as any);
      // No self entity since no myIdentifier, but participant still resolved
      expect(result.entities).toHaveLength(1);
    });
  });

  describe('sync (progress emission)', () => {
    it('emits progress every PROGRESS_INTERVAL messages', async () => {
      // Create enough messages to trigger progress
      const messages = Array.from({ length: 55 }, (_, i) => ({
        id: i,
        chat_id: 1,
        guid: `guid-${i}`,
        sender: '+1234567890',
        is_from_me: false,
        text: `Message ${i}`,
        created_at: `2025-01-01T12:${String(i).padStart(2, '0')}:00Z`,
        attachments: [],
        reactions: [],
        chat_identifier: '+1234567890',
        chat_name: 'Chat 1',
        participants: ['+1234567890'],
        is_group: false,
      }));
      mockMessagesHistory.mockResolvedValueOnce(messages);

      const progressListener = vi.fn();
      connector.on('data', () => {});
      connector.on('progress', progressListener);

      const ctx = {
        accountId: 'acc-1',
        auth: { raw: { imsgHost: 'localhost', imsgPort: 19876 } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(5000),
      };

      await connector.sync(ctx as any);

      // Should emit at 50 (PROGRESS_INTERVAL) and final
      expect(progressListener).toHaveBeenCalledWith({ processed: 50 });
      expect(progressListener).toHaveBeenCalledWith({ processed: 55 });
    });

    it('falls back to imsg-{id} sourceId when no guid', async () => {
      mockMessagesHistory.mockResolvedValueOnce([{
        id: 42,
        chat_id: 1,
        guid: '',
        sender: '+1234567890',
        is_from_me: false,
        text: 'No GUID',
        created_at: '2025-01-01T12:00:00Z',
        attachments: [],
        reactions: [],
        chat_identifier: '+1234567890',
        chat_name: 'Chat 1',
        participants: ['+1234567890'],
        is_group: false,
      }]);

      const dataListener = vi.fn();
      connector.on('data', dataListener);

      const ctx = {
        accountId: 'acc-1',
        auth: { raw: { imsgHost: 'localhost', imsgPort: 19876 } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(5000),
      };

      await connector.sync(ctx as any);
      expect(dataListener.mock.calls[0][0].sourceId).toBe('imsg-42');
    });

    it('uses sender when no participants array', async () => {
      mockMessagesHistory.mockResolvedValueOnce([{
        id: 1,
        chat_id: 1,
        guid: 'g1',
        sender: '+9999999999',
        is_from_me: false,
        text: 'Hi',
        created_at: '2025-01-01T12:00:00Z',
        attachments: [],
        reactions: [],
        chat_identifier: '+9999999999',
        chat_name: 'Chat 1',
        participants: null,
        is_group: false,
      }]);

      const dataListener = vi.fn();
      connector.on('data', dataListener);

      const ctx = {
        accountId: 'acc-1',
        auth: { raw: { imsgHost: 'localhost', imsgPort: 19876 } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(5000),
      };

      await connector.sync(ctx as any);
      expect(dataListener.mock.calls[0][0].content.participants).toEqual(['+9999999999']);
    });
  });
});

describe('default export', () => {
  it('exports factory function that returns IMessageConnector instance', async () => {
    const mod = await import('../index.js');
    expect(typeof mod.default).toBe('function');
    expect(mod.default()).toBeInstanceOf(IMessageConnector);
  });
});

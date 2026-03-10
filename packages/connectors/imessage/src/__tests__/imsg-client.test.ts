import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

interface MockSocket extends EventEmitter {
  connect: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  destroyed: boolean;
  removeListener: ReturnType<typeof vi.fn>;
}

let mockSocket: MockSocket;

function createMockSocket(): MockSocket {
  const socket = new EventEmitter() as MockSocket;
  socket.connect = vi.fn();
  socket.write = vi.fn();
  socket.destroy = vi.fn();
  socket.destroyed = false;
  const origRemove = EventEmitter.prototype.removeListener.bind(socket);
  socket.removeListener = vi.fn((event: string, fn: (...args: unknown[]) => void) => {
    origRemove(event, fn);
    return socket;
  });
  return socket;
}

vi.mock('net', () => {
  return {
    Socket: vi.fn(() => {
      return mockSocket;
    }),
  };
});

describe('ImsgClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSocket = createMockSocket();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  async function makeAndConnect() {
    const { ImsgClient } = await import('../imsg-client.js');
    const client = new ImsgClient('localhost', 19876);
    const p = client.connect();
    const calls = mockSocket.connect.mock.calls;
    calls[calls.length - 1][2](); // trigger connect callback
    await p;
    return client;
  }

  describe('connect', () => {
    it('resolves when connection succeeds', async () => {
      const { ImsgClient } = await import('../imsg-client.js');
      const client = new ImsgClient('localhost', 19876);
      const p = client.connect();
      mockSocket.connect.mock.calls[0][2]();
      await p;
      expect(mockSocket.connect).toHaveBeenCalledWith(19876, 'localhost', expect.any(Function));
    });

    it('resolves immediately if already connected', async () => {
      const client = await makeAndConnect();
      await client.connect();
      expect(mockSocket.connect).toHaveBeenCalledTimes(1);
    });

    it('rejects on socket error', async () => {
      const { ImsgClient } = await import('../imsg-client.js');
      const client = new ImsgClient('localhost', 19876);
      const connectPromise = client.connect();
      mockSocket.emit('error', new Error('Connection refused'));
      await expect(connectPromise).rejects.toThrow('Connection refused');
    });
  });

  describe('disconnect', () => {
    it('destroys socket and rejects pending requests', async () => {
      const client = await makeAndConnect();
      mockSocket.write.mockImplementation(
        (_d: string, _e: string, cb: (...args: unknown[]) => void) => cb(),
      );
      const reqPromise = client.chatsList();
      client.disconnect();
      expect(mockSocket.destroy).toHaveBeenCalled();
      await expect(reqPromise).rejects.toThrow('Client disconnected');
    });

    it('clears buffer on disconnect', async () => {
      const client = await makeAndConnect();
      (client as unknown as { buffer: string }).buffer = 'leftover';
      client.disconnect();
      expect((client as unknown as { buffer: string }).buffer).toBe('');
    });
  });

  describe('chatsList', () => {
    it('sends JSON-RPC request and returns chats', async () => {
      const client = await makeAndConnect();
      mockSocket.write.mockImplementation(
        (data: string, _e: string, cb: (...args: unknown[]) => void) => {
          cb();
          const req = JSON.parse(data.trim());
          mockSocket.emit(
            'data',
            Buffer.from(
              JSON.stringify({
                jsonrpc: '2.0',
                id: req.id,
                result: {
                  chats: [
                    {
                      id: 1,
                      name: 'Chat 1',
                      identifier: '+1234',
                      service: 'iMessage',
                      last_message_at: '',
                    },
                  ],
                },
              }) + '\n',
            ),
          );
        },
      );

      const chats = await client.chatsList(10);
      expect(chats).toHaveLength(1);
      expect(chats[0].name).toBe('Chat 1');
      const sentReq = JSON.parse(mockSocket.write.mock.calls[0][0].trim());
      expect(sentReq.method).toBe('chats.list');
      expect(sentReq.params.limit).toBe(10);
    });

    it('sends request without params when no limit', async () => {
      const client = await makeAndConnect();
      mockSocket.write.mockImplementation(
        (data: string, _e: string, cb: (...args: unknown[]) => void) => {
          cb();
          const req = JSON.parse(data.trim());
          mockSocket.emit(
            'data',
            Buffer.from(
              JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { chats: [] } }) + '\n',
            ),
          );
        },
      );
      const chats = await client.chatsList();
      expect(chats).toEqual([]);
    });
  });

  describe('messagesHistory', () => {
    it('sends correct params and returns messages', async () => {
      const client = await makeAndConnect();
      mockSocket.write.mockImplementation(
        (data: string, _e: string, cb: (...args: unknown[]) => void) => {
          cb();
          const req = JSON.parse(data.trim());
          mockSocket.emit(
            'data',
            Buffer.from(
              JSON.stringify({
                jsonrpc: '2.0',
                id: req.id,
                result: {
                  messages: [
                    {
                      id: 1,
                      chat_id: 5,
                      guid: 'g1',
                      sender: '+1234',
                      is_from_me: false,
                      text: 'Hello',
                      created_at: '2025-01-01T12:00:00Z',
                      attachments: [],
                      reactions: [],
                      chat_identifier: '+1234',
                      chat_name: 'Chat',
                      participants: ['+1234'],
                      is_group: false,
                    },
                  ],
                },
              }) + '\n',
            ),
          );
        },
      );

      const msgs = await client.messagesHistory(5, {
        limit: 100,
        start: '2025-01-01',
        end: '2025-12-31',
        attachments: true,
      });
      expect(msgs).toHaveLength(1);
      const sentReq = JSON.parse(mockSocket.write.mock.calls[0][0].trim());
      expect(sentReq.params.chat_id).toBe(5);
      expect(sentReq.params.limit).toBe(100);
    });

    it('sends minimal params when no options', async () => {
      const client = await makeAndConnect();
      mockSocket.write.mockImplementation(
        (data: string, _e: string, cb: (...args: unknown[]) => void) => {
          cb();
          const req = JSON.parse(data.trim());
          mockSocket.emit(
            'data',
            Buffer.from(
              JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { messages: [] } }) + '\n',
            ),
          );
        },
      );
      const msgs = await client.messagesHistory(3);
      expect(msgs).toEqual([]);
    });
  });

  describe('error handling', () => {
    it('rejects with RPC error', async () => {
      const client = await makeAndConnect();
      mockSocket.write.mockImplementation(
        (data: string, _e: string, cb: (...args: unknown[]) => void) => {
          cb();
          const req = JSON.parse(data.trim());
          mockSocket.emit(
            'data',
            Buffer.from(
              JSON.stringify({
                jsonrpc: '2.0',
                id: req.id,
                error: { code: -32600, message: 'Invalid request', data: { detail: 'bad' } },
              }) + '\n',
            ),
          );
        },
      );
      await expect(client.chatsList()).rejects.toThrow('Invalid request');
    });

    it('rejects when not connected', async () => {
      const { ImsgClient } = await import('../imsg-client.js');
      const client = new ImsgClient('localhost', 19876);
      await expect(client.chatsList()).rejects.toThrow('Not connected');
    });

    it('rejects on write error', async () => {
      const client = await makeAndConnect();
      mockSocket.write.mockImplementation(
        (_d: string, _e: string, cb: (...args: unknown[]) => void) => cb(new Error('Write failed')),
      );
      await expect(client.chatsList()).rejects.toThrow('Write failed');
    });

    it('times out on no response', async () => {
      const client = await makeAndConnect();
      mockSocket.write.mockImplementation(
        (_d: string, _e: string, cb: (...args: unknown[]) => void) => cb(),
      );
      const reqPromise = client.chatsList();
      vi.advanceTimersByTime(31_000);
      await expect(reqPromise).rejects.toThrow('timed out');
    });

    it('handles socket close with pending requests', async () => {
      const client = await makeAndConnect();
      mockSocket.write.mockImplementation(
        (_d: string, _e: string, cb: (...args: unknown[]) => void) => cb(),
      );
      const reqPromise = client.chatsList();
      mockSocket.emit('close');
      await expect(reqPromise).rejects.toThrow('Connection closed');
    });

    it('handles socket error with pending requests', async () => {
      const client = await makeAndConnect();
      mockSocket.write.mockImplementation(
        (_d: string, _e: string, cb: (...args: unknown[]) => void) => cb(),
      );
      const reqPromise = client.chatsList();
      mockSocket.emit('error', new Error('Socket error'));
      await expect(reqPromise).rejects.toThrow('Socket error');
    });
  });

  describe('buffer processing', () => {
    it('handles partial data across multiple chunks', async () => {
      const client = await makeAndConnect();
      let requestId = 0;
      mockSocket.write.mockImplementation(
        (data: string, _e: string, cb: (...args: unknown[]) => void) => {
          cb();
          requestId = JSON.parse(data.trim()).id;
        },
      );

      const chatsPromise = client.chatsList();
      const response = JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        result: {
          chats: [
            { id: 1, name: 'Test', identifier: 'x', service: 'iMessage', last_message_at: '' },
          ],
        },
      });
      const half = Math.floor(response.length / 2);
      mockSocket.emit('data', Buffer.from(response.slice(0, half)));
      mockSocket.emit('data', Buffer.from(response.slice(half) + '\n'));

      const chats = await chatsPromise;
      expect(chats).toHaveLength(1);
    });

    it('handles malformed JSON lines gracefully', async () => {
      const client = await makeAndConnect();
      let requestId = 0;
      mockSocket.write.mockImplementation(
        (data: string, _e: string, cb: (...args: unknown[]) => void) => {
          cb();
          requestId = JSON.parse(data.trim()).id;
        },
      );

      const chatsPromise = client.chatsList();
      const validResponse = JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        result: { chats: [] },
      });
      mockSocket.emit('data', Buffer.from('invalid json\n' + validResponse + '\n'));

      const chats = await chatsPromise;
      expect(chats).toEqual([]);
    });

    it('ignores notifications (no id field)', async () => {
      const client = await makeAndConnect();
      let requestId = 0;
      mockSocket.write.mockImplementation(
        (data: string, _e: string, cb: (...args: unknown[]) => void) => {
          cb();
          requestId = JSON.parse(data.trim()).id;
        },
      );

      const chatsPromise = client.chatsList();
      const notification = JSON.stringify({ jsonrpc: '2.0', method: 'status' });
      const response = JSON.stringify({ jsonrpc: '2.0', id: requestId, result: { chats: [] } });
      mockSocket.emit('data', Buffer.from(notification + '\n' + response + '\n'));

      const chats = await chatsPromise;
      expect(chats).toEqual([]);
    });

    it('ignores responses for unknown request ids', async () => {
      const client = await makeAndConnect();
      let requestId = 0;
      mockSocket.write.mockImplementation(
        (data: string, _e: string, cb: (...args: unknown[]) => void) => {
          cb();
          requestId = JSON.parse(data.trim()).id;
        },
      );

      const chatsPromise = client.chatsList();
      const wrongResponse = JSON.stringify({ jsonrpc: '2.0', id: 9999, result: {} });
      const rightResponse = JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        result: { chats: [] },
      });
      mockSocket.emit('data', Buffer.from(wrongResponse + '\n' + rightResponse + '\n'));

      const chats = await chatsPromise;
      expect(chats).toEqual([]);
    });

    it('handles empty lines in buffer', async () => {
      const client = await makeAndConnect();
      let requestId = 0;
      mockSocket.write.mockImplementation(
        (data: string, _e: string, cb: (...args: unknown[]) => void) => {
          cb();
          requestId = JSON.parse(data.trim()).id;
        },
      );

      const chatsPromise = client.chatsList();
      const response = JSON.stringify({ jsonrpc: '2.0', id: requestId, result: { chats: [] } });
      mockSocket.emit('data', Buffer.from('\n\n' + response + '\n'));

      const chats = await chatsPromise;
      expect(chats).toEqual([]);
    });
  });
});

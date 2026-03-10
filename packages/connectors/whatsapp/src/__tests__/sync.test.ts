/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-function-type, @typescript-eslint/no-unused-vars */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all Baileys imports before importing sync module
vi.mock('@whiskeysockets/baileys', () => ({
  makeWASocket: vi.fn(),
  useMultiFileAuthState: vi.fn(),
  makeCacheableSignalKeyStore: vi.fn(),
  fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 3000, 1] }),
  downloadContentFromMessage: vi.fn(),
  DisconnectReason: {
    loggedOut: 401,
    badSession: 500,
    multideviceMismatch: 411,
    restartRequired: 515,
    connectionClosed: 428,
    connectionReplaced: 440,
    timedOut: 408,
  },
}));

vi.mock('pino', () => ({
  default: vi.fn(() => ({
    level: 'silent',
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  })),
}));

const mockExistsSync = vi.fn().mockReturnValue(false);
const mockReadFileSync = vi.fn();
vi.mock('fs', () => ({
  mkdirSync: vi.fn(),
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
  writeFileSync: vi.fn(),
  existsSync: (...args: any[]) => mockExistsSync(...args),
}));

// We need to test the exported functions + internal helpers.
// Since many helpers are not exported, we test them via syncWhatsApp behavior
// and also test setDecryptFailureCallback directly.

describe('sync module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('setDecryptFailureCallback', () => {
    it('registers a callback', async () => {
      const { setDecryptFailureCallback } = await import('../sync.js');
      const cb = vi.fn();
      setDecryptFailureCallback(cb);
      // Callback is registered but only fires on decrypt failures — tested via integration
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('syncWhatsApp', () => {
    it('throws when no session dir', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const ctx = {
        accountId: 'a1',
        auth: { raw: {} },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: new AbortController().signal,
      };
      await expect(syncWhatsApp(ctx as any, vi.fn())).rejects.toThrow('No WhatsApp session found');
    });

    it('reuses existing socket when provided', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      // Create a mock socket with event system
      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(),
          removeAllListeners: vi.fn(),
        },
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(500),
      };

      // The socket is passed directly, so no createSyncSocket needed
      // It should use the existing socket and wait for history
      const promise = syncWhatsApp(ctx as any, emit, mockSock as any);

      // Advance timers to trigger idle timeout
      await vi.advanceTimersByTimeAsync(35_000);

      const result = await promise;
      expect(result.processed).toBe(0);
      expect(result.hasMore).toBe(false);
      expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining('Reusing auth socket'));
      expect(mockSock.ev.flush).toHaveBeenCalled();
    });

    it('processes history messages from messaging-history.set', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            // Simulate history arriving on flush
            const historyHandlers = eventHandlers.get('messaging-history.set') || [];
            for (const h of historyHandlers) {
              h({
                messages: [
                  {
                    key: { id: 'msg1', remoteJid: '5551234@s.whatsapp.net', fromMe: false },
                    message: { conversation: 'Hello from history' },
                    messageTimestamp: Math.floor(Date.now() / 1000),
                    pushName: 'Alice',
                  },
                ],
                chats: [{ id: '5551234@s.whatsapp.net', name: 'Alice' }],
                contacts: [{ id: '5551234@s.whatsapp.net', notify: 'Alice' }],
                progress: 100,
              });
            }
          }),
          removeAllListeners: vi.fn(),
        },
        groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      };

      const abortCtrl = new AbortController();
      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-hist' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: abortCtrl.signal,
      };

      const promise = syncWhatsApp(ctx as any, emit, mockSock as any);

      // Advance idle timeout
      await vi.advanceTimersByTimeAsync(35_000);

      const result = await promise;
      expect(result.processed).toBeGreaterThanOrEqual(1);
      // Check that emit was called with a message event
      const msgEmits = emit.mock.calls.filter(
        (c: any) => c[0].sourceType === 'message' && c[0].content.text === 'Hello from history',
      );
      expect(msgEmits.length).toBeGreaterThanOrEqual(1);
    });

    it('processes real-time messages from messages.upsert', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            // Simulate a real-time message arriving
            const upsertHandlers = eventHandlers.get('messages.upsert') || [];
            for (const h of upsertHandlers) {
              h({
                type: 'notify',
                messages: [
                  {
                    key: { id: 'rt1', remoteJid: '5559876@s.whatsapp.net', fromMe: false },
                    message: { conversation: 'Real-time message' },
                    messageTimestamp: Math.floor(Date.now() / 1000),
                    pushName: 'Bob',
                  },
                ],
              });
            }
          }),
          removeAllListeners: vi.fn(),
        },
        groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-rt' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(500),
      };

      const promise = syncWhatsApp(ctx as any, emit, mockSock as any);
      await vi.advanceTimersByTimeAsync(35_000);

      const result = await promise;
      expect(result.processed).toBeGreaterThanOrEqual(1);
    });

    it('handles disconnection during sync', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();
      const onDisconnect = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            // Simulate disconnection on flush
            const connHandlers = eventHandlers.get('connection.update') || [];
            for (const h of connHandlers) {
              h({
                connection: 'close',
                lastDisconnect: {
                  error: { output: { statusCode: 401 } }, // loggedOut
                },
              });
            }
          }),
          removeAllListeners: vi.fn(),
        },
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-dc' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: new AbortController().signal,
      };

      await expect(syncWhatsApp(ctx as any, emit, mockSock as any, onDisconnect)).rejects.toThrow(
        'WhatsApp session disconnected',
      );
      expect(onDisconnect).toHaveBeenCalledWith('Session logged out from phone', 401);
    });

    it('handles signal abort', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const abortCtrl = new AbortController();
      abortCtrl.abort();

      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(),
          removeAllListeners: vi.fn(),
        },
        groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-abort' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: abortCtrl.signal,
      };

      const result = await syncWhatsApp(ctx as any, emit, mockSock as any);
      expect(result.processed).toBe(0);
    });

    it('skips status@broadcast messages', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            const historyHandlers = eventHandlers.get('messaging-history.set') || [];
            for (const h of historyHandlers) {
              h({
                messages: [
                  {
                    key: { id: 'status1', remoteJid: 'status@broadcast', fromMe: false },
                    message: { conversation: 'Status post' },
                    messageTimestamp: Math.floor(Date.now() / 1000),
                  },
                ],
                chats: [],
                contacts: [],
              });
            }
          }),
          removeAllListeners: vi.fn(),
        },
        groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-status' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(500),
      };

      const promise = syncWhatsApp(ctx as any, emit, mockSock as any);
      await vi.advanceTimersByTimeAsync(35_000);

      const result = await promise;
      // Status messages should be skipped
      const statusEmits = emit.mock.calls.filter(
        (c: any) => c[0].content?.metadata?.chatId === 'status@broadcast',
      );
      expect(statusEmits.length).toBe(0);
    });

    it('processes group messages with participant resolution', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            const historyHandlers = eventHandlers.get('messaging-history.set') || [];
            for (const h of historyHandlers) {
              h({
                messages: [
                  {
                    key: {
                      id: 'grp1',
                      remoteJid: '120363@g.us',
                      fromMe: false,
                      participant: '5551234@s.whatsapp.net',
                    },
                    participant: '5551234@s.whatsapp.net',
                    message: { conversation: 'Group hello' },
                    messageTimestamp: Math.floor(Date.now() / 1000),
                    pushName: 'GroupMember',
                  },
                ],
                chats: [{ id: '120363@g.us', name: 'Test Group' }],
                contacts: [{ id: '5551234@s.whatsapp.net', notify: 'GroupMember' }],
              });
            }
          }),
          removeAllListeners: vi.fn(),
        },
        groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-grp' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(500),
      };

      const promise = syncWhatsApp(ctx as any, emit, mockSock as any);
      await vi.advanceTimersByTimeAsync(35_000);

      const result = await promise;
      expect(result.processed).toBeGreaterThanOrEqual(1);
      const groupMsg = emit.mock.calls.find(
        (c: any) => c[0].sourceType === 'message' && c[0].content?.metadata?.isGroup === true,
      );
      expect(groupMsg).toBeDefined();
      expect(groupMsg![0].content.metadata.chatName).toBe('Test Group');
    });

    it('handles image messages with caption', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            const historyHandlers = eventHandlers.get('messaging-history.set') || [];
            for (const h of historyHandlers) {
              h({
                messages: [
                  {
                    key: { id: 'img1', remoteJid: '5551234@s.whatsapp.net', fromMe: false },
                    message: {
                      imageMessage: {
                        caption: 'Check this out',
                        mimetype: 'image/jpeg',
                        // No mediaKey/directPath so media download skips
                      },
                    },
                    messageTimestamp: Math.floor(Date.now() / 1000),
                    pushName: 'Alice',
                  },
                ],
                chats: [],
                contacts: [],
              });
            }
          }),
          removeAllListeners: vi.fn(),
        },
        groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-img' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(500),
      };

      const promise = syncWhatsApp(ctx as any, emit, mockSock as any);
      await vi.advanceTimersByTimeAsync(35_000);

      await promise;
      const imgEmit = emit.mock.calls.find((c: any) => c[0].sourceId === 'img1');
      expect(imgEmit).toBeDefined();
      expect(imgEmit![0].content.text).toBe('Check this out');
      expect(imgEmit![0].content.metadata.messageType).toBe('image');
    });

    it('handles contact card messages', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            const historyHandlers = eventHandlers.get('messaging-history.set') || [];
            for (const h of historyHandlers) {
              h({
                messages: [
                  {
                    key: { id: 'cc1', remoteJid: '5551234@s.whatsapp.net', fromMe: false },
                    message: {
                      contactMessage: {
                        displayName: 'Carol',
                        vcard: 'BEGIN:VCARD\nFN:Carol Smith\nTEL;type=CELL:+15559876\nEND:VCARD',
                      },
                    },
                    messageTimestamp: Math.floor(Date.now() / 1000),
                  },
                ],
                chats: [],
                contacts: [],
              });
            }
          }),
          removeAllListeners: vi.fn(),
        },
        groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-cc' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(500),
      };

      const promise = syncWhatsApp(ctx as any, emit, mockSock as any);
      await vi.advanceTimersByTimeAsync(35_000);

      await promise;
      const ccEmit = emit.mock.calls.find((c: any) => c[0].sourceId === 'cc1');
      expect(ccEmit).toBeDefined();
      expect(ccEmit![0].content.text).toContain('shared contact');
      expect(ccEmit![0].content.text).toContain('Carol');
    });

    it('handles location messages', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            const historyHandlers = eventHandlers.get('messaging-history.set') || [];
            for (const h of historyHandlers) {
              h({
                messages: [
                  {
                    key: { id: 'loc1', remoteJid: '5551234@s.whatsapp.net', fromMe: true },
                    message: {
                      locationMessage: {
                        degreesLatitude: 25.2048,
                        degreesLongitude: 55.2708,
                        name: 'Burj Khalifa',
                      },
                    },
                    messageTimestamp: Math.floor(Date.now() / 1000),
                  },
                ],
                chats: [],
                contacts: [],
              });
            }
          }),
          removeAllListeners: vi.fn(),
        },
        groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-loc' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(500),
      };

      const promise = syncWhatsApp(ctx as any, emit, mockSock as any);
      await vi.advanceTimersByTimeAsync(35_000);

      await promise;
      const locEmit = emit.mock.calls.find((c: any) => c[0].sourceId === 'loc1');
      expect(locEmit).toBeDefined();
      expect(locEmit![0].content.text).toContain('shared location');
      expect(locEmit![0].content.text).toContain('Burj Khalifa');
      expect(locEmit![0].content.metadata.location).toEqual({
        lat: 25.2048,
        lng: 55.2708,
        name: 'Burj Khalifa',
        address: undefined,
      });
    });

    it('skips protocol and reaction messages', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            const historyHandlers = eventHandlers.get('messaging-history.set') || [];
            for (const h of historyHandlers) {
              h({
                messages: [
                  {
                    key: { id: 'proto1', remoteJid: '5551234@s.whatsapp.net', fromMe: false },
                    message: { protocolMessage: { type: 0 } },
                    messageTimestamp: Math.floor(Date.now() / 1000),
                  },
                  {
                    key: { id: 'react1', remoteJid: '5551234@s.whatsapp.net', fromMe: false },
                    message: { reactionMessage: { text: '👍' } },
                    messageTimestamp: Math.floor(Date.now() / 1000),
                  },
                ],
                chats: [],
                contacts: [],
              });
            }
          }),
          removeAllListeners: vi.fn(),
        },
        groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-skip' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(500),
      };

      const promise = syncWhatsApp(ctx as any, emit, mockSock as any);
      await vi.advanceTimersByTimeAsync(35_000);

      const result = await promise;
      expect(result.processed).toBe(0);
    });

    it('handles fromMe messages correctly', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            const historyHandlers = eventHandlers.get('messaging-history.set') || [];
            for (const h of historyHandlers) {
              h({
                messages: [
                  {
                    key: { id: 'me1', remoteJid: '5551234@s.whatsapp.net', fromMe: true },
                    message: { conversation: 'My sent message' },
                    messageTimestamp: Math.floor(Date.now() / 1000),
                  },
                ],
                chats: [],
                contacts: [],
              });
            }
          }),
          removeAllListeners: vi.fn(),
        },
        groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-me' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(500),
      };

      const promise = syncWhatsApp(ctx as any, emit, mockSock as any);
      await vi.advanceTimersByTimeAsync(35_000);

      await promise;
      const meEmit = emit.mock.calls.find((c: any) => c[0].sourceId === 'me1');
      expect(meEmit).toBeDefined();
      expect(meEmit![0].content.metadata.fromMe).toBe(true);
      expect(meEmit![0].content.metadata.senderPhone).toBe('1234567890');
    });

    it('emits contact events after sync', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            // Simulate contacts arriving with history
            const contactHandlers = eventHandlers.get('contacts.upsert') || [];
            for (const h of contactHandlers) {
              h([
                { id: '5551234@s.whatsapp.net', notify: 'Alice' },
                { id: '5559876@s.whatsapp.net', notify: 'Bob' },
              ]);
            }

            const historyHandlers = eventHandlers.get('messaging-history.set') || [];
            for (const h of historyHandlers) {
              h({
                messages: [
                  {
                    key: { id: 'c1', remoteJid: '5551234@s.whatsapp.net', fromMe: false },
                    message: { conversation: 'Hi' },
                    messageTimestamp: Math.floor(Date.now() / 1000),
                    pushName: 'Alice',
                  },
                ],
                chats: [],
                contacts: [],
              });
            }
          }),
          removeAllListeners: vi.fn(),
        },
        groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-contacts' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(500),
      };

      const promise = syncWhatsApp(ctx as any, emit, mockSock as any);
      await vi.advanceTimersByTimeAsync(35_000);

      await promise;
      // Should have contact events
      const contactEmits = emit.mock.calls.filter(
        (c: any) => c[0].content?.metadata?.type === 'contact',
      );
      expect(contactEmits.length).toBeGreaterThanOrEqual(1);
    });

    it('handles extended text messages', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            const historyHandlers = eventHandlers.get('messaging-history.set') || [];
            for (const h of historyHandlers) {
              h({
                messages: [
                  {
                    key: { id: 'ext1', remoteJid: '5551234@s.whatsapp.net', fromMe: false },
                    message: {
                      extendedTextMessage: {
                        text: 'Check out this link https://example.com',
                        contextInfo: {
                          mentionedJid: ['5559999@s.whatsapp.net'],
                        },
                      },
                    },
                    messageTimestamp: Math.floor(Date.now() / 1000),
                    pushName: 'Alice',
                  },
                ],
                chats: [],
                contacts: [{ id: '5559999@s.whatsapp.net', notify: 'MentionedUser' }],
              });
            }
          }),
          removeAllListeners: vi.fn(),
        },
        groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-ext' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(500),
      };

      const promise = syncWhatsApp(ctx as any, emit, mockSock as any);
      await vi.advanceTimersByTimeAsync(35_000);

      await promise;
      const extEmit = emit.mock.calls.find((c: any) => c[0].sourceId === 'ext1');
      expect(extEmit).toBeDefined();
      expect(extEmit![0].content.text).toContain('Check out this link');
      expect(extEmit![0].content.metadata.mentions).toBeDefined();
    });

    it('handles video message without caption', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            const historyHandlers = eventHandlers.get('messaging-history.set') || [];
            for (const h of historyHandlers) {
              h({
                messages: [
                  {
                    key: { id: 'vid1', remoteJid: '5551234@s.whatsapp.net', fromMe: false },
                    message: {
                      videoMessage: { mimetype: 'video/mp4' },
                    },
                    messageTimestamp: Math.floor(Date.now() / 1000),
                  },
                ],
                chats: [],
                contacts: [],
              });
            }
          }),
          removeAllListeners: vi.fn(),
        },
        groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-vid' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(500),
      };

      const promise = syncWhatsApp(ctx as any, emit, mockSock as any);
      await vi.advanceTimersByTimeAsync(35_000);

      await promise;
      const vidEmit = emit.mock.calls.find((c: any) => c[0].sourceId === 'vid1');
      expect(vidEmit).toBeDefined();
      expect(vidEmit![0].content.text).toBe('sent a video');
    });

    it('handles audio message', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            const historyHandlers = eventHandlers.get('messaging-history.set') || [];
            for (const h of historyHandlers) {
              h({
                messages: [
                  {
                    key: { id: 'aud1', remoteJid: '5551234@s.whatsapp.net', fromMe: false },
                    message: {
                      audioMessage: { mimetype: 'audio/ogg' },
                    },
                    messageTimestamp: Math.floor(Date.now() / 1000),
                  },
                ],
                chats: [],
                contacts: [],
              });
            }
          }),
          removeAllListeners: vi.fn(),
        },
        groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-aud' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(500),
      };

      const promise = syncWhatsApp(ctx as any, emit, mockSock as any);
      await vi.advanceTimersByTimeAsync(35_000);

      await promise;
      const audEmit = emit.mock.calls.find((c: any) => c[0].sourceId === 'aud1');
      expect(audEmit).toBeDefined();
      expect(audEmit![0].content.text).toBe('sent a voice message');
    });

    it('handles sticker message', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            const historyHandlers = eventHandlers.get('messaging-history.set') || [];
            for (const h of historyHandlers) {
              h({
                messages: [
                  {
                    key: { id: 'stk1', remoteJid: '5551234@s.whatsapp.net', fromMe: false },
                    message: {
                      stickerMessage: { mimetype: 'image/webp' },
                    },
                    messageTimestamp: Math.floor(Date.now() / 1000),
                  },
                ],
                chats: [],
                contacts: [],
              });
            }
          }),
          removeAllListeners: vi.fn(),
        },
        groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-stk' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(500),
      };

      const promise = syncWhatsApp(ctx as any, emit, mockSock as any);
      await vi.advanceTimersByTimeAsync(35_000);

      await promise;
      const stkEmit = emit.mock.calls.find((c: any) => c[0].sourceId === 'stk1');
      expect(stkEmit).toBeDefined();
      expect(stkEmit![0].content.text).toBe('sent a sticker');
    });

    it('handles document message with filename', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            const historyHandlers = eventHandlers.get('messaging-history.set') || [];
            for (const h of historyHandlers) {
              h({
                messages: [
                  {
                    key: { id: 'doc1', remoteJid: '5551234@s.whatsapp.net', fromMe: false },
                    message: {
                      documentMessage: {
                        mimetype: 'application/pdf',
                        fileName: 'report.pdf',
                      },
                    },
                    messageTimestamp: Math.floor(Date.now() / 1000),
                  },
                ],
                chats: [],
                contacts: [],
              });
            }
          }),
          removeAllListeners: vi.fn(),
        },
        groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-doc' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(500),
      };

      const promise = syncWhatsApp(ctx as any, emit, mockSock as any);
      await vi.advanceTimersByTimeAsync(35_000);

      await promise;
      const docEmit = emit.mock.calls.find((c: any) => c[0].sourceId === 'doc1');
      expect(docEmit).toBeDefined();
      expect(docEmit![0].content.text).toContain('report.pdf');
    });

    it('handles LID-based contacts resolution', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            // Simulate phone number share event
            const phoneShareHandlers = eventHandlers.get('chats.phoneNumberShare') || [];
            for (const h of phoneShareHandlers) {
              h({ lid: 'liduser123@lid', jid: '5557777@s.whatsapp.net' });
            }

            // Then deliver a message from that LID
            const historyHandlers = eventHandlers.get('messaging-history.set') || [];
            for (const h of historyHandlers) {
              h({
                messages: [
                  {
                    key: {
                      id: 'lid1',
                      remoteJid: '120363@g.us',
                      fromMe: false,
                      participant: 'liduser123@lid',
                    },
                    participant: 'liduser123@lid',
                    message: { conversation: 'Message from LID user' },
                    messageTimestamp: Math.floor(Date.now() / 1000),
                  },
                ],
                chats: [{ id: '120363@g.us', name: 'Test Group' }],
                contacts: [],
              });
            }
          }),
          removeAllListeners: vi.fn(),
        },
        groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-lid' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(500),
      };

      const promise = syncWhatsApp(ctx as any, emit, mockSock as any);
      await vi.advanceTimersByTimeAsync(35_000);

      await promise;
      const lidEmit = emit.mock.calls.find((c: any) => c[0].sourceId === 'lid1');
      expect(lidEmit).toBeDefined();
      // LID should resolve to phone 5557777
      expect(lidEmit![0].content.metadata.senderPhone).toBe('5557777');
    });

    it('handles contacts.update events', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            // Fire contacts.update
            const updateHandlers = eventHandlers.get('contacts.update') || [];
            for (const h of updateHandlers) {
              h([
                { id: '5551234@s.whatsapp.net', notify: 'UpdatedAlice' },
                { id: 'someLid@lid', notify: 'LidUser' },
                { id: '5552222@s.whatsapp.net', name: '' }, // empty name, should skip
              ]);
            }
          }),
          removeAllListeners: vi.fn(),
        },
        groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-cu' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(500),
      };

      const promise = syncWhatsApp(ctx as any, emit, mockSock as any);
      await vi.advanceTimersByTimeAsync(35_000);

      await promise;
      // Contacts should be emitted after sync
      const contactEmits = emit.mock.calls.filter(
        (c: any) => c[0].content?.metadata?.type === 'contact',
      );
      // At least Alice should have a contact event
      const aliceContact = contactEmits.find((c: any) =>
        c[0].content.text.includes('UpdatedAlice'),
      );
      expect(aliceContact).toBeDefined();
    });

    it('handles group-participants.update events', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            // Fire group-participants.update
            const gpHandlers = eventHandlers.get('group-participants.update') || [];
            for (const h of gpHandlers) {
              h({
                id: '120363@g.us',
                participants: ['5551234@s.whatsapp.net', '5559876@s.whatsapp.net'],
                action: 'add',
              });
            }
            // Fire remove action too
            for (const h of gpHandlers) {
              h({
                id: '120363@g.us',
                participants: ['5559876@s.whatsapp.net'],
                action: 'remove',
              });
            }
          }),
          removeAllListeners: vi.fn(),
        },
        groupFetchAllParticipating: vi.fn().mockResolvedValue({
          '120363@g.us': {
            subject: 'TestGroup',
            participants: [{ id: '5551234@s.whatsapp.net' }],
          },
        }),
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-gp' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(500),
      };

      const promise = syncWhatsApp(ctx as any, emit, mockSock as any);
      await vi.advanceTimersByTimeAsync(35_000);

      await promise;
      // Group metadata event should be emitted
      const groupEmits = emit.mock.calls.filter(
        (c: any) =>
          c[0].content?.metadata?.isGroup === true && c[0].content?.metadata?.type === 'contact',
      );
      expect(groupEmits.length).toBeGreaterThanOrEqual(1);
    });

    it('handles groupFetchAllParticipating failure gracefully', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(),
          removeAllListeners: vi.fn(),
        },
        groupFetchAllParticipating: vi.fn().mockRejectedValue(new Error('Not authorized')),
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-gfail' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(500),
      };

      const promise = syncWhatsApp(ctx as any, emit, mockSock as any);
      await vi.advanceTimersByTimeAsync(35_000);

      // Should not throw
      const result = await promise;
      expect(result.processed).toBe(0);
      expect(ctx.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('groupFetchAllParticipating failed'),
      );
    });

    it('handles documentWithCaptionMessage', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            const historyHandlers = eventHandlers.get('messaging-history.set') || [];
            for (const h of historyHandlers) {
              h({
                messages: [
                  {
                    key: { id: 'dwc1', remoteJid: '5551234@s.whatsapp.net', fromMe: false },
                    message: {
                      documentWithCaptionMessage: {
                        message: {
                          documentMessage: {
                            caption: 'Here is the file',
                            mimetype: 'application/pdf',
                            fileName: 'doc.pdf',
                          },
                        },
                      },
                    },
                    messageTimestamp: Math.floor(Date.now() / 1000),
                  },
                ],
                chats: [],
                contacts: [],
              });
            }
          }),
          removeAllListeners: vi.fn(),
        },
        groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-dwc' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(500),
      };

      const promise = syncWhatsApp(ctx as any, emit, mockSock as any);
      await vi.advanceTimersByTimeAsync(35_000);

      await promise;
      const dwcEmit = emit.mock.calls.find((c: any) => c[0].sourceId === 'dwc1');
      expect(dwcEmit).toBeDefined();
      expect(dwcEmit![0].content.text).toContain('doc.pdf');
      expect(dwcEmit![0].content.text).toContain('Here is the file');
    });

    it('handles contactsArrayMessage', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            const historyHandlers = eventHandlers.get('messaging-history.set') || [];
            for (const h of historyHandlers) {
              h({
                messages: [
                  {
                    key: { id: 'ca1', remoteJid: '5551234@s.whatsapp.net', fromMe: false },
                    message: {
                      contactsArrayMessage: {
                        contacts: [
                          {
                            displayName: 'Carol',
                            vcard: 'BEGIN:VCARD\nFN:Carol\nTEL:+15559876\nEND:VCARD',
                          },
                          {
                            displayName: 'Dave',
                            vcard: 'BEGIN:VCARD\nFN:Dave\nTEL:+15551111\nEND:VCARD',
                          },
                        ],
                      },
                    },
                    messageTimestamp: Math.floor(Date.now() / 1000),
                  },
                ],
                chats: [],
                contacts: [],
              });
            }
          }),
          removeAllListeners: vi.fn(),
        },
        groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-ca' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(500),
      };

      const promise = syncWhatsApp(ctx as any, emit, mockSock as any);
      await vi.advanceTimersByTimeAsync(35_000);

      await promise;
      const caEmit = emit.mock.calls.find((c: any) => c[0].sourceId === 'ca1');
      expect(caEmit).toBeDefined();
      expect(caEmit![0].content.text).toContain('shared contacts');
      expect(caEmit![0].content.text).toContain('Carol');
      expect(caEmit![0].content.text).toContain('Dave');
    });

    it('handles bad session disconnect code', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();
      const onDisconnect = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            const connHandlers = eventHandlers.get('connection.update') || [];
            for (const h of connHandlers) {
              h({
                connection: 'close',
                lastDisconnect: {
                  error: { output: { statusCode: 500 } }, // badSession
                },
              });
            }
          }),
          removeAllListeners: vi.fn(),
        },
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-bad' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: new AbortController().signal,
      };

      await expect(syncWhatsApp(ctx as any, emit, mockSock as any, onDisconnect)).rejects.toThrow(
        'WhatsApp session disconnected',
      );
      expect(onDisconnect).toHaveBeenCalledWith('Session expired or corrupted', 500);
    });

    it('handles multidevice mismatch disconnect', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();
      const onDisconnect = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            const connHandlers = eventHandlers.get('connection.update') || [];
            for (const h of connHandlers) {
              h({
                connection: 'close',
                lastDisconnect: {
                  error: { output: { statusCode: 411 } },
                },
              });
            }
          }),
          removeAllListeners: vi.fn(),
        },
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-multi' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: new AbortController().signal,
      };

      await expect(syncWhatsApp(ctx as any, emit, mockSock as any, onDisconnect)).rejects.toThrow(
        'WhatsApp session disconnected',
      );
      expect(onDisconnect).toHaveBeenCalledWith('Multi-device mismatch', 411);
    });

    it('handles non-fatal disconnect code', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();
      const onDisconnect = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            const connHandlers = eventHandlers.get('connection.update') || [];
            for (const h of connHandlers) {
              h({
                connection: 'close',
                lastDisconnect: {
                  error: { output: { statusCode: 428 } }, // connectionClosed
                },
              });
            }
          }),
          removeAllListeners: vi.fn(),
        },
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-nonfatal' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: new AbortController().signal,
      };

      await expect(syncWhatsApp(ctx as any, emit, mockSock as any, onDisconnect)).rejects.toThrow(
        'WhatsApp session disconnected',
      );
      expect(onDisconnect).toHaveBeenCalledWith('Connection lost during sync', 428);
    });

    it('handles contacts.upsert with LID-based contacts', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            const contactHandlers = eventHandlers.get('contacts.upsert') || [];
            for (const h of contactHandlers) {
              h([
                // Phone-based with LID cross-reference
                {
                  id: '5551234@s.whatsapp.net',
                  lid: 'lid123@lid',
                  notify: 'Alice',
                },
                // LID-based contact
                {
                  id: 'lid456@lid',
                  lid: '5559876@s.whatsapp.net', // non-LID lid field = phone
                  notify: 'Bob',
                },
                // LID-based contact with LID lid field (no phone resolution)
                {
                  id: 'lid789@lid',
                  lid: 'lid789@lid',
                  name: 'Charlie',
                },
              ]);
            }
          }),
          removeAllListeners: vi.fn(),
        },
        groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-cupsert' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(500),
      };

      const promise = syncWhatsApp(ctx as any, emit, mockSock as any);
      await vi.advanceTimersByTimeAsync(35_000);

      await promise;
      // Contact events should include Alice and Bob
      const contactEmits = emit.mock.calls.filter(
        (c: any) => c[0].content?.metadata?.type === 'contact',
      );
      expect(contactEmits.length).toBeGreaterThanOrEqual(2);
    });

    it('runs on-demand fetching phase when fetchMessageHistory available', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            const historyHandlers = eventHandlers.get('messaging-history.set') || [];
            for (const h of historyHandlers) {
              h({
                messages: [
                  {
                    key: { id: 'od1', remoteJid: '5551234@s.whatsapp.net', fromMe: false },
                    message: { conversation: 'First message' },
                    messageTimestamp: 1000000,
                  },
                ],
                chats: [{ id: '5551234@s.whatsapp.net', name: 'Alice' }],
                contacts: [],
              });
            }
          }),
          removeAllListeners: vi.fn(),
        },
        fetchMessageHistory: vi.fn().mockResolvedValue(undefined),
        groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-ondemand' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(500),
      };

      const promise = syncWhatsApp(ctx as any, emit, mockSock as any);
      // Advance past idle timeout (first sync = 30s)
      await vi.advanceTimersByTimeAsync(35_000);
      // Advance past on-demand jitter and wait times
      await vi.advanceTimersByTimeAsync(20_000);

      const result = await promise;
      expect(result.processed).toBeGreaterThanOrEqual(1);
      // fetchMessageHistory should have been called at least once
      expect(mockSock.fetchMessageHistory).toHaveBeenCalled();
    });

    it('handles fetchMessageHistory failure gracefully', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            const historyHandlers = eventHandlers.get('messaging-history.set') || [];
            for (const h of historyHandlers) {
              h({
                messages: [
                  {
                    key: { id: 'odf1', remoteJid: '5559999@s.whatsapp.net', fromMe: false },
                    message: { conversation: 'Test' },
                    messageTimestamp: 2000000,
                  },
                ],
                chats: [],
                contacts: [],
              });
            }
          }),
          removeAllListeners: vi.fn(),
        },
        fetchMessageHistory: vi.fn().mockRejectedValue(new Error('Rate limited')),
        groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-odfail' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(500),
      };

      const promise = syncWhatsApp(ctx as any, emit, mockSock as any);
      await vi.advanceTimersByTimeAsync(35_000);
      await vi.advanceTimersByTimeAsync(20_000);

      const result = await promise;
      // Should not throw — just log and continue
      expect(ctx.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('fetchMessageHistory failed'),
      );
    });

    it('handles liveLocationMessage', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            const historyHandlers = eventHandlers.get('messaging-history.set') || [];
            for (const h of historyHandlers) {
              h({
                messages: [
                  {
                    key: { id: 'lloc1', remoteJid: '5551234@s.whatsapp.net', fromMe: false },
                    message: {
                      liveLocationMessage: {
                        degreesLatitude: 40.7128,
                        degreesLongitude: -74.006,
                        address: 'New York',
                      },
                    },
                    messageTimestamp: Math.floor(Date.now() / 1000),
                  },
                ],
                chats: [],
                contacts: [],
              });
            }
          }),
          removeAllListeners: vi.fn(),
        },
        groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-lloc' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(500),
      };

      const promise = syncWhatsApp(ctx as any, emit, mockSock as any);
      await vi.advanceTimersByTimeAsync(35_000);

      await promise;
      const locEmit = emit.mock.calls.find((c: any) => c[0].sourceId === 'lloc1');
      expect(locEmit).toBeDefined();
      expect(locEmit![0].content.text).toContain('shared location');
      expect(locEmit![0].content.text).toContain('New York');
    });

    it('handles DM message with other party resolution', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            // Provide contact data first
            const contactHandlers = eventHandlers.get('contacts.upsert') || [];
            for (const h of contactHandlers) {
              h([{ id: '5557777@s.whatsapp.net', notify: 'Charlie' }]);
            }

            const historyHandlers = eventHandlers.get('messaging-history.set') || [];
            for (const h of historyHandlers) {
              h({
                messages: [
                  // fromMe=true DM — other party is remoteJid
                  {
                    key: { id: 'dm1', remoteJid: '5557777@s.whatsapp.net', fromMe: true },
                    message: { conversation: 'Sent to Charlie' },
                    messageTimestamp: Math.floor(Date.now() / 1000),
                  },
                  // fromMe=false DM — self is recipient
                  {
                    key: { id: 'dm2', remoteJid: '5557777@s.whatsapp.net', fromMe: false },
                    message: { conversation: 'From Charlie' },
                    messageTimestamp: Math.floor(Date.now() / 1000),
                  },
                ],
                chats: [],
                contacts: [],
              });
            }
          }),
          removeAllListeners: vi.fn(),
        },
        groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-dm' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(500),
      };

      const promise = syncWhatsApp(ctx as any, emit, mockSock as any);
      await vi.advanceTimersByTimeAsync(35_000);

      await promise;
      // Check fromMe DM has other party in participants
      const dm1 = emit.mock.calls.find((c: any) => c[0].sourceId === 'dm1');
      expect(dm1).toBeDefined();
      expect(dm1![0].content.participants).toContain('5557777');

      // Check received DM has self in participants
      const dm2 = emit.mock.calls.find((c: any) => c[0].sourceId === 'dm2');
      expect(dm2).toBeDefined();
      expect(dm2![0].content.participants).toContain('1234567890');
    });

    it('handles message with no key id (fallback sourceId)', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            const historyHandlers = eventHandlers.get('messaging-history.set') || [];
            for (const h of historyHandlers) {
              h({
                messages: [
                  {
                    key: { remoteJid: '5551234@s.whatsapp.net', fromMe: false },
                    message: { conversation: 'No key ID' },
                    messageTimestamp: Math.floor(Date.now() / 1000),
                  },
                ],
                chats: [],
                contacts: [],
              });
            }
          }),
          removeAllListeners: vi.fn(),
        },
        groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-noid' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(500),
      };

      const promise = syncWhatsApp(ctx as any, emit, mockSock as any);
      await vi.advanceTimersByTimeAsync(35_000);

      await promise;
      const noIdEmit = emit.mock.calls.find((c: any) => c[0].content?.text === 'No key ID');
      expect(noIdEmit).toBeDefined();
      expect(noIdEmit![0].sourceId).toMatch(/^wa:/);
    });

    it('loads saved identity maps when available', async () => {
      // Set up the mocks to simulate a saved identity map file
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          lidToPhone: { lid123: '5551234' },
          phoneToName: { '5551234': 'SavedAlice' },
          lidToName: { lid123: 'SavedAlice' },
        }),
      );

      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(),
          removeAllListeners: vi.fn(),
        },
        groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-saved' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(500),
      };

      const promise = syncWhatsApp(ctx as any, emit, mockSock as any);
      await vi.advanceTimersByTimeAsync(35_000);

      await promise;
      expect(ctx.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Loaded saved identity maps'),
      );
      // Reset mocks
      mockExistsSync.mockReturnValue(false);
      mockReadFileSync.mockReset();
    });

    it('handles image message without caption', async () => {
      const { syncWhatsApp } = await import('../sync.js');
      const emit = vi.fn();

      const eventHandlers = new Map<string, Function[]>();
      const mockSock = {
        user: { id: '1234567890@s.whatsapp.net' },
        ws: { close: vi.fn() },
        ev: {
          on: vi.fn((event: string, handler: Function) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, []);
            eventHandlers.get(event)!.push(handler);
          }),
          off: vi.fn(),
          buffer: vi.fn(),
          flush: vi.fn(() => {
            const historyHandlers = eventHandlers.get('messaging-history.set') || [];
            for (const h of historyHandlers) {
              h({
                messages: [
                  {
                    key: { id: 'imgnocap1', remoteJid: '5551234@s.whatsapp.net', fromMe: false },
                    message: {
                      imageMessage: { mimetype: 'image/jpeg' },
                    },
                    messageTimestamp: Math.floor(Date.now() / 1000),
                  },
                ],
                chats: [],
                contacts: [],
              });
            }
          }),
          removeAllListeners: vi.fn(),
        },
        groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      };

      const ctx = {
        accountId: 'a1',
        auth: { raw: { sessionDir: '/tmp/test-session-imgnocap' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(500),
      };

      const promise = syncWhatsApp(ctx as any, emit, mockSock as any);
      await vi.advanceTimersByTimeAsync(35_000);

      await promise;
      const imgEmit = emit.mock.calls.find((c: any) => c[0].sourceId === 'imgnocap1');
      expect(imgEmit).toBeDefined();
      expect(imgEmit![0].content.text).toBe('sent an image');
    });
  });
});

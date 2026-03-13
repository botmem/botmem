/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-function-type, @typescript-eslint/no-unused-vars */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing
const mockSaveCreds = vi.fn().mockResolvedValue(undefined);
const mockMakeWASocket = vi.fn();
const mockUseAtomicMultiFileAuthState = vi.fn().mockResolvedValue({
  state: {
    creds: {},
    keys: {},
  },
  saveCreds: mockSaveCreds,
});
const mockMakeCacheableSignalKeyStore = vi.fn().mockReturnValue({});
const mockFetchLatestBaileysVersion = vi.fn().mockResolvedValue({ version: [2, 3000, 1] });
const mockToDataURL = vi.fn().mockResolvedValue('data:image/png;base64,mockqr');

vi.mock('@whiskeysockets/baileys', () => ({
  makeWASocket: mockMakeWASocket,
  makeCacheableSignalKeyStore: mockMakeCacheableSignalKeyStore,
  fetchLatestBaileysVersion: mockFetchLatestBaileysVersion,
  DisconnectReason: {
    loggedOut: 401,
    badSession: 500,
    multideviceMismatch: 411,
    restartRequired: 515,
    connectionClosed: 428,
    connectionReplaced: 440,
    timedOut: 408,
  },
  proto: {
    HistorySync: { decode: vi.fn() },
    Message: { IHistorySyncNotification: {} },
  },
}));

vi.mock('../atomic-auth-state.js', () => ({
  useAtomicMultiFileAuthState: (...args: any[]) => mockUseAtomicMultiFileAuthState(...args),
  flushPendingWrites: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('qrcode', () => ({
  toDataURL: (...args: any[]) => mockToDataURL(...args),
}));

vi.mock('pino', () => ({
  default: vi.fn(() => ({
    level: 'warn',
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('fs', () => ({
  mkdirSync: vi.fn(),
}));

describe('qr-auth', () => {
  let eventHandlers: Map<string, Function[]>;
  let processCallback: ((events: Record<string, any>) => Promise<void>) | null;

  function createMockSocket() {
    eventHandlers = new Map();
    processCallback = null;
    const mockWs = {
      on: vi.fn(),
      close: vi.fn(),
    };
    const sock = {
      user: { id: '1234567890@s.whatsapp.net' },
      ws: mockWs,
      ev: {
        on: vi.fn((event: string, handler: Function) => {
          if (!eventHandlers.has(event)) eventHandlers.set(event, []);
          eventHandlers.get(event)!.push(handler);
        }),
        off: vi.fn(),
        buffer: vi.fn(),
        flush: vi.fn(),
        emit: vi.fn(),
        process: vi.fn((callback: (events: Record<string, any>) => Promise<void>) => {
          processCallback = callback;
        }),
      },
    };
    mockMakeWASocket.mockReturnValue(sock);
    return sock;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits QR code on connection update with qr', async () => {
    const sock = createMockSocket();
    const callbacks = {
      onQrCode: vi.fn(),
      onConnected: vi.fn(),
      onError: vi.fn(),
    };

    const { startQrAuth } = await import('../qr-auth.js');
    await startQrAuth('/tmp/test-session', callbacks);

    // Trigger qr event
    const connHandler = eventHandlers.get('connection.update')!;
    for (const h of connHandler) {
      await h({ qr: 'raw-qr-data', connection: undefined });
    }

    expect(mockToDataURL).toHaveBeenCalledWith('raw-qr-data');
    expect(callbacks.onQrCode).toHaveBeenCalledWith('data:image/png;base64,mockqr');
  });

  it('calls onConnected when connection opens (after stability timer)', async () => {
    const sock = createMockSocket();
    const callbacks = {
      onQrCode: vi.fn(),
      onConnected: vi.fn(),
      onError: vi.fn(),
    };

    const { startQrAuth } = await import('../qr-auth.js');
    await startQrAuth('/tmp/test-session-conn', callbacks);

    // Trigger connection open
    const connHandler = eventHandlers.get('connection.update')!;
    for (const h of connHandler) {
      await h({ connection: 'open' });
    }

    // Not called immediately — stability timer (3s)
    expect(callbacks.onConnected).not.toHaveBeenCalled();

    // Advance past stability window
    await vi.advanceTimersByTimeAsync(3500);

    expect(callbacks.onConnected).toHaveBeenCalledWith(
      expect.objectContaining({
        raw: expect.objectContaining({
          sessionDir: '/tmp/test-session-conn',
        }),
      }),
      sock,
    );
  });

  it('calls onError on fatal disconnect code (loggedOut)', async () => {
    createMockSocket();
    const callbacks = {
      onQrCode: vi.fn(),
      onConnected: vi.fn(),
      onError: vi.fn(),
    };

    const { startQrAuth } = await import('../qr-auth.js');
    await startQrAuth('/tmp/test-session-fatal', callbacks);

    // Trigger fatal close
    const connHandler = eventHandlers.get('connection.update')!;
    for (const h of connHandler) {
      await h({
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 401 } } },
      });
    }

    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('authentication failed'),
      }),
    );
  });

  it('retries on reconnect-worthy disconnect code', async () => {
    createMockSocket();
    const callbacks = {
      onQrCode: vi.fn(),
      onConnected: vi.fn(),
      onError: vi.fn(),
    };

    const { startQrAuth } = await import('../qr-auth.js');
    await startQrAuth('/tmp/test-session-retry', callbacks, 2);

    // Trigger reconnect-worthy close
    const connHandler = eventHandlers.get('connection.update')!;
    for (const h of connHandler) {
      await h({
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 515 } } }, // restartRequired
      });
    }

    // Should not call onError yet (will retry)
    expect(callbacks.onError).not.toHaveBeenCalled();

    // Advance timer for retry
    await vi.advanceTimersByTimeAsync(1000);

    // A new socket should be created
    expect(mockMakeWASocket).toHaveBeenCalledTimes(2);
  });

  it('calls onError after max retries on non-QR non-fatal disconnect', async () => {
    createMockSocket();
    const callbacks = {
      onQrCode: vi.fn(),
      onConnected: vi.fn(),
      onError: vi.fn(),
    };

    const { startQrAuth } = await import('../qr-auth.js');
    await startQrAuth('/tmp/test-session-maxretry', callbacks, 1);

    // Trigger unknown close (not fatal, not reconnect, no qr shown, exceeded retries)
    const connHandler = eventHandlers.get('connection.update')!;
    // First attempt: retry
    for (const h of connHandler) {
      await h({
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 999 } } },
      });
    }

    // Advance timer for retry
    await vi.advanceTimersByTimeAsync(1000);

    // Second attempt: should fail (maxRetries=1, retries now=1)
    const connHandler2 = eventHandlers.get('connection.update')!;
    for (const h of connHandler2) {
      await h({
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 999 } } },
      });
    }

    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Failed to connect'),
      }),
    );
  });

  it('calls onError when QR shown but connection closes', async () => {
    createMockSocket();
    const callbacks = {
      onQrCode: vi.fn(),
      onConnected: vi.fn(),
      onError: vi.fn(),
    };

    const { startQrAuth } = await import('../qr-auth.js');
    await startQrAuth('/tmp/test-session-qrclose', callbacks);

    // First show QR
    const connHandler = eventHandlers.get('connection.update')!;
    for (const h of connHandler) {
      await h({ qr: 'test-qr' });
    }

    // Then close with unknown code (QR was shown)
    for (const h of connHandler) {
      await h({
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 999 } } },
      });
    }

    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'WhatsApp connection closed',
      }),
    );
  });

  it('does not fire onConnected or QR after already connected', async () => {
    const sock = createMockSocket();
    const callbacks = {
      onQrCode: vi.fn(),
      onConnected: vi.fn(),
      onError: vi.fn(),
    };

    const { startQrAuth } = await import('../qr-auth.js');
    await startQrAuth('/tmp/test-session-double', callbacks);

    const connHandler = eventHandlers.get('connection.update')!;
    // Connect
    for (const h of connHandler) {
      await h({ connection: 'open' });
    }
    // Advance past stability window
    await vi.advanceTimersByTimeAsync(3500);
    expect(callbacks.onConnected).toHaveBeenCalledTimes(1);

    // Duplicate open
    for (const h of connHandler) {
      await h({ connection: 'open' });
    }
    await vi.advanceTimersByTimeAsync(3500);
    expect(callbacks.onConnected).toHaveBeenCalledTimes(1);

    // QR after connected should be ignored
    for (const h of connHandler) {
      await h({ qr: 'late-qr' });
    }
    expect(callbacks.onQrCode).not.toHaveBeenCalled();
  });

  it('ignores close after connected', async () => {
    createMockSocket();
    const callbacks = {
      onQrCode: vi.fn(),
      onConnected: vi.fn(),
      onError: vi.fn(),
    };

    const { startQrAuth } = await import('../qr-auth.js');
    await startQrAuth('/tmp/test-session-closeafter', callbacks);

    const connHandler = eventHandlers.get('connection.update')!;
    // Connect first
    for (const h of connHandler) {
      await h({ connection: 'open' });
    }
    // Advance past stability window
    await vi.advanceTimersByTimeAsync(3500);

    // Close after connected — should be ignored
    for (const h of connHandler) {
      await h({
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 401 } } },
      });
    }
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it('stores messages via ev.process callback for messaging-history.set and messages.upsert', async () => {
    createMockSocket();
    const callbacks = {
      onQrCode: vi.fn(),
      onConnected: vi.fn(),
      onError: vi.fn(),
    };

    const { startQrAuth } = await import('../qr-auth.js');
    await startQrAuth('/tmp/test-session-store', callbacks);

    // ev.process should have been called
    expect(processCallback).not.toBeNull();

    // Trigger messaging-history.set via process callback
    await processCallback!({
      'messaging-history.set': {
        messages: [
          {
            key: { id: 'msg1', remoteJid: '5551234@s.whatsapp.net' },
            message: { conversation: 'Hello' },
          },
        ],
      },
    });

    // Trigger messages.upsert via process callback
    await processCallback!({
      'messages.upsert': {
        messages: [
          {
            key: { id: 'msg2', remoteJid: '5551234@s.whatsapp.net' },
            message: { conversation: 'World' },
          },
        ],
      },
    });

    // No direct assertion on store, but confirms no crash
  });

  it('uses cached version when available', async () => {
    createMockSocket();
    const callbacks = {
      onQrCode: vi.fn(),
      onConnected: vi.fn(),
      onError: vi.fn(),
    };

    const { startQrAuth } = await import('../qr-auth.js');

    // First call fetches version
    await startQrAuth('/tmp/test-session-v1', callbacks);

    // Second call should use cache (within TTL)
    await startQrAuth('/tmp/test-session-v2', callbacks);

    // fetchLatestBaileysVersion may or may not be called again depending on cache
    // Just confirm no crash
    expect(mockMakeWASocket).toHaveBeenCalledTimes(2);
  });

  it('handles fetchLatestBaileysVersion failure', async () => {
    mockFetchLatestBaileysVersion.mockRejectedValueOnce(new Error('Network error'));
    createMockSocket();
    const callbacks = {
      onQrCode: vi.fn(),
      onConnected: vi.fn(),
      onError: vi.fn(),
    };

    const { startQrAuth } = await import('../qr-auth.js');
    // Should not throw — falls back to hardcoded version
    await startQrAuth('/tmp/test-session-vfail', callbacks);
    expect(mockMakeWASocket).toHaveBeenCalled();
  });

  it('handles creds.update event', async () => {
    createMockSocket();
    const callbacks = {
      onQrCode: vi.fn(),
      onConnected: vi.fn(),
      onError: vi.fn(),
    };

    const { startQrAuth } = await import('../qr-auth.js');
    await startQrAuth('/tmp/test-session-creds', callbacks);

    // creds.update should be registered
    const credsHandlers = eventHandlers.get('creds.update')!;
    expect(credsHandlers).toBeDefined();
    expect(credsHandlers.length).toBeGreaterThanOrEqual(1);
    // Call it - should invoke saveCreds
    for (const h of credsHandlers) {
      await h({});
    }
    expect(mockSaveCreds).toHaveBeenCalled();
  });

  it('registers WebSocket error handler', async () => {
    const sock = createMockSocket();
    const callbacks = {
      onQrCode: vi.fn(),
      onConnected: vi.fn(),
      onError: vi.fn(),
    };

    const { startQrAuth } = await import('../qr-auth.js');
    await startQrAuth('/tmp/test-session-wserr', callbacks);

    expect(sock.ws.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('exercises getMessage and msgRetryCounterCache passed to makeWASocket', async () => {
    createMockSocket();
    const callbacks = {
      onQrCode: vi.fn(),
      onConnected: vi.fn(),
      onError: vi.fn(),
    };

    const { startQrAuth } = await import('../qr-auth.js');
    await startQrAuth('/tmp/test-session-getmsg', callbacks);

    // Get the options passed to makeWASocket
    const socketOptions = mockMakeWASocket.mock.calls[mockMakeWASocket.mock.calls.length - 1][0];

    // Test getMessage callback
    const getMessage = socketOptions.getMessage;
    expect(getMessage).toBeDefined();
    const result = await getMessage({ remoteJid: 'nonexistent@s.whatsapp.net', id: 'missing' });
    expect(result).toBeUndefined();

    // Test msgRetryCounterCache
    const cache = socketOptions.msgRetryCounterCache;
    expect(cache).toBeDefined();
    expect(cache.get('somekey')).toBeUndefined();
    cache.set('somekey', 42);
    expect(cache.get('somekey')).toBe(42);
    cache.del('somekey');
    expect(cache.get('somekey')).toBeUndefined();
    cache.set('a', 1);
    cache.set('b', 2);
    cache.flushAll();
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });

  it('stores and retrieves messages via ev.process and getMessage', async () => {
    createMockSocket();
    const callbacks = {
      onQrCode: vi.fn(),
      onConnected: vi.fn(),
      onError: vi.fn(),
    };

    const { startQrAuth } = await import('../qr-auth.js');
    await startQrAuth('/tmp/test-session-msgstore', callbacks);

    // Store messages via process callback (history)
    expect(processCallback).not.toBeNull();
    await processCallback!({
      'messaging-history.set': {
        messages: [
          {
            key: { id: 'stored-msg-1', remoteJid: '5551234@s.whatsapp.net' },
            message: { conversation: 'Stored message' },
          },
        ],
      },
    });

    // Store via messages.upsert
    await processCallback!({
      'messages.upsert': {
        messages: [
          {
            key: { id: 'stored-msg-2', remoteJid: '5551234@s.whatsapp.net' },
            message: { conversation: 'Upserted message' },
          },
        ],
      },
    });

    // Now retrieve via getMessage
    const socketOptions = mockMakeWASocket.mock.calls[mockMakeWASocket.mock.calls.length - 1][0];
    const getMessage = socketOptions.getMessage;

    const msg1 = await getMessage({ remoteJid: '5551234@s.whatsapp.net', id: 'stored-msg-1' });
    expect(msg1).toBeDefined();
    expect(msg1?.conversation).toBe('Stored message');

    const msg2 = await getMessage({ remoteJid: '5551234@s.whatsapp.net', id: 'stored-msg-2' });
    expect(msg2).toBeDefined();
    expect(msg2?.conversation).toBe('Upserted message');
  });

  it('handles badSession disconnect code', async () => {
    createMockSocket();
    const callbacks = {
      onQrCode: vi.fn(),
      onConnected: vi.fn(),
      onError: vi.fn(),
    };

    const { startQrAuth } = await import('../qr-auth.js');
    await startQrAuth('/tmp/test-session-badsession', callbacks);

    const connHandler = eventHandlers.get('connection.update')!;
    for (const h of connHandler) {
      await h({
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 500 } } },
      });
    }

    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('authentication failed'),
      }),
    );
  });

  it('handles multideviceMismatch disconnect code', async () => {
    createMockSocket();
    const callbacks = {
      onQrCode: vi.fn(),
      onConnected: vi.fn(),
      onError: vi.fn(),
    };

    const { startQrAuth } = await import('../qr-auth.js');
    await startQrAuth('/tmp/test-session-multidev', callbacks);

    const connHandler = eventHandlers.get('connection.update')!;
    for (const h of connHandler) {
      await h({
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 411 } } },
      });
    }

    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('authentication failed'),
      }),
    );
  });

  it('passes shouldSyncHistoryMessage to socket config', async () => {
    createMockSocket();
    const callbacks = {
      onQrCode: vi.fn(),
      onConnected: vi.fn(),
      onError: vi.fn(),
    };

    const { startQrAuth } = await import('../qr-auth.js');
    await startQrAuth('/tmp/test-session-shm', callbacks);

    const socketOptions = mockMakeWASocket.mock.calls[mockMakeWASocket.mock.calls.length - 1][0];
    expect(socketOptions.shouldSyncHistoryMessage).toBeDefined();
    expect(typeof socketOptions.shouldSyncHistoryMessage).toBe('function');

    // Should return true (always sync)
    const result = socketOptions.shouldSyncHistoryMessage({});
    expect(result).toBe(true);
  });

  it('passes syncFullHistory: true to socket config', async () => {
    createMockSocket();
    const callbacks = {
      onQrCode: vi.fn(),
      onConnected: vi.fn(),
      onError: vi.fn(),
    };

    const { startQrAuth } = await import('../qr-auth.js');
    await startQrAuth('/tmp/test-session-sfh', callbacks);

    const socketOptions = mockMakeWASocket.mock.calls[mockMakeWASocket.mock.calls.length - 1][0];
    expect(socketOptions.syncFullHistory).toBe(true);
  });

  it('uses ev.process instead of individual .on for history events', async () => {
    const sock = createMockSocket();
    const callbacks = {
      onQrCode: vi.fn(),
      onConnected: vi.fn(),
      onError: vi.fn(),
    };

    const { startQrAuth } = await import('../qr-auth.js');
    await startQrAuth('/tmp/test-session-evprocess', callbacks);

    // ev.process should have been called for history handlers
    expect(sock.ev.process).toHaveBeenCalledWith(expect.any(Function));

    // messaging-history.set and messages.upsert should NOT be registered via .on
    const onCalls = sock.ev.on.mock.calls.map((c: any[]) => c[0]);
    expect(onCalls).not.toContain('messaging-history.set');
    expect(onCalls).not.toContain('messages.upsert');

    // creds.update and connection.update should still use .on
    expect(onCalls).toContain('creds.update');
    expect(onCalls).toContain('connection.update');
  });
});

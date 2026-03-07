import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WhatsAppConnector } from '../index.js';

vi.mock('../qr-auth.js', () => ({
  startQrAuth: vi.fn((_dir: string, callbacks: any) => {
    callbacks.onQrCode('data:image/png;base64,qrcode');
    return Promise.resolve();
  }),
}));

vi.mock('../sync.js', () => ({
  syncWhatsApp: vi.fn().mockResolvedValue({ cursor: null, hasMore: false, processed: 5 }),
}));

describe('WhatsAppConnector', () => {
  let connector: WhatsAppConnector;

  beforeEach(() => {
    connector = new WhatsAppConnector();
    vi.clearAllMocks();
  });

  describe('manifest', () => {
    it('has correct id', () => {
      expect(connector.manifest.id).toBe('whatsapp');
    });

    it('has qr-code auth type', () => {
      expect(connector.manifest.authType).toBe('qr-code');
    });
  });

  describe('initiateAuth', () => {
    it('returns qr-code result', async () => {
      const result = await connector.initiateAuth({});
      expect(result.type).toBe('qr-code');
      if (result.type === 'qr-code') {
        expect(result.qrData).toContain('data:image');
        expect(result.wsChannel).toContain('auth:');
      }
    });
  });

  describe('completeAuth', () => {
    it('returns auth context with session info', async () => {
      const auth = await connector.completeAuth({
        sessionDir: '/data/wa-session',
        jid: '1234@s.whatsapp.net',
      });
      expect(auth.raw?.sessionDir).toBe('/data/wa-session');
      expect(auth.raw?.jid).toBe('1234@s.whatsapp.net');
    });
  });

  describe('validateAuth', () => {
    it('returns true when session dir exists', async () => {
      expect(await connector.validateAuth({ raw: { sessionDir: '/data/session' } })).toBe(true);
    });

    it('returns false when no session dir', async () => {
      expect(await connector.validateAuth({})).toBe(false);
    });
  });

  describe('revokeAuth', () => {
    it('does not throw', async () => {
      await expect(connector.revokeAuth({ raw: { sessionDir: '/data/session' } })).resolves.toBeUndefined();
    });
  });

  describe('sync', () => {
    it('calls syncWhatsApp and emits progress', async () => {
      const progressListener = vi.fn();
      connector.on('progress', progressListener);

      const ctx = {
        accountId: 'acc-1',
        auth: { raw: { sessionDir: '/data/session' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(5000),
      };

      const result = await connector.sync(ctx);
      expect(result.processed).toBe(5);
      expect(progressListener).toHaveBeenCalledWith({ processed: 5 });
    });
  });
});

describe('default export', () => {
  it('exports factory function', async () => {
    const mod = await import('../index.js');
    expect(typeof mod.default).toBe('function');
    expect(mod.default()).toBeInstanceOf(WhatsAppConnector);
  });
});

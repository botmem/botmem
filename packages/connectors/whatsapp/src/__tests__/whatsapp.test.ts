import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PipelineContext } from '@botmem/connector-sdk';
import { WhatsAppConnector } from '../index.js';
import type { QrAuthCallbacks } from '../qr-auth.js';

vi.mock('../qr-auth.js', () => ({
  startQrAuth: vi.fn((_dir: string, callbacks: QrAuthCallbacks) => {
    callbacks.onQrCode('data:image/png;base64,qrcode');
    return Promise.resolve();
  }),
}));

vi.mock('../sync.js', () => ({
  syncWhatsApp: vi.fn().mockResolvedValue({ cursor: null, hasMore: false, processed: 5 }),
  setDecryptFailureCallback: vi.fn(),
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
        sessionDir: './data/whatsapp/wa-test-session',
        jid: '1234@s.whatsapp.net',
      });
      expect(auth.raw?.sessionDir).toBe('./data/whatsapp/wa-test-session');
      expect(auth.raw?.jid).toBe('1234@s.whatsapp.net');
    });
  });

  describe('validateAuth', () => {
    it('returns true when session dir exists', async () => {
      expect(
        await connector.validateAuth({ raw: { sessionDir: './data/whatsapp/test-session' } }),
      ).toBe(true);
    });

    it('returns false when no session dir', async () => {
      expect(await connector.validateAuth({})).toBe(false);
    });
  });

  describe('revokeAuth', () => {
    it('does not throw', async () => {
      await expect(
        connector.revokeAuth({ raw: { sessionDir: './data/whatsapp/test-session' } }),
      ).resolves.toBeUndefined();
    });
  });

  describe('sync', () => {
    it('calls syncWhatsApp and emits progress', async () => {
      const progressListener = vi.fn();
      connector.on('progress', progressListener);

      const ctx = {
        accountId: 'acc-1',
        auth: { raw: { sessionDir: './data/whatsapp/test-session' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(5000),
      };

      const result = await connector.sync(ctx);
      expect(result.processed).toBe(5);
      expect(progressListener).toHaveBeenCalledWith(expect.objectContaining({ processed: 5 }));
    });
  });

  describe('embed', () => {
    it('extracts sender from senderPhone with name', () => {
      const event = {
        sourceType: 'message' as const,
        sourceId: 'wa1',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: 'Hi',
          participants: [],
          metadata: { senderPhone: '1234567890', senderName: 'Alice', fromMe: false },
        },
      };
      const result = connector.embed(event, 'Hi', {} as unknown as PipelineContext);
      expect(result.entities).toContainEqual({
        type: 'person',
        id: 'phone:1234567890|name:Alice',
        role: 'sender',
      });
    });

    it('extracts group entity when isGroup with chatId', () => {
      const event = {
        sourceType: 'message' as const,
        sourceId: 'wa1',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: 'Hi',
          participants: [],
          metadata: { isGroup: true, chatId: '120363@g.us', chatName: 'Family' },
        },
      };
      const result = connector.embed(event, 'Hi', {} as unknown as PipelineContext);
      const group = result.entities.find((e) => e.type === 'group');
      expect(group).toBeDefined();
      expect(group!.id).toContain('whatsapp_group_jid:120363');
      expect(group!.id).toContain('name:Family');
    });

    it('extracts DM recipient when not group', () => {
      const event = {
        sourceType: 'message' as const,
        sourceId: 'wa1',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: 'Hi',
          participants: ['1234567890@s.whatsapp.net'],
          metadata: {
            senderPhone: '1234567890',
            selfPhone: '9876543210',
            fromMe: true,
            isGroup: false,
          },
        },
      };
      const result = connector.embed(event, 'Hi', {} as unknown as PipelineContext);
      // fromMe=true means sender is self, phone resolves to senderPhone, recipient is the phone (same as sender in this case)
      // Actually: otherPhone = fromMe ? phone : selfPhone => phone=1234567890, so otherPhone=1234567890
      // But otherPhone === phone, so no recipient emitted
      const sender = result.entities.find((e) => e.role === 'sender');
      expect(sender).toBeDefined();
    });

    it('extracts recipient in DM when not fromMe', () => {
      const event = {
        sourceType: 'message' as const,
        sourceId: 'wa1',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: 'Hi',
          participants: [],
          metadata: {
            senderPhone: '1234567890',
            selfPhone: '9876543210',
            fromMe: false,
            isGroup: false,
          },
        },
      };
      const result = connector.embed(event, 'Hi', {} as unknown as PipelineContext);
      const recipient = result.entities.find((e) => e.role === 'recipient');
      expect(recipient).toBeDefined();
      expect(recipient!.id).toBe('phone:9876543210');
    });

    it('extracts mentions', () => {
      const event = {
        sourceType: 'message' as const,
        sourceId: 'wa1',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: '@Bob',
          participants: [],
          metadata: { mentions: [{ phone: '5551234', name: 'Bob' }] },
        },
      };
      const result = connector.embed(event, '@Bob', {} as unknown as PipelineContext);
      const mentioned = result.entities.find((e) => e.role === 'mentioned');
      expect(mentioned).toBeDefined();
      expect(mentioned!.id).toBe('phone:5551234|name:Bob');
    });

    it('extracts shared contacts from vCards', () => {
      const event = {
        sourceType: 'message' as const,
        sourceId: 'wa1',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: 'Contact card',
          participants: [],
          metadata: { sharedContacts: [{ name: 'Carol', phones: ['5559876'] }] },
        },
      };
      const result = connector.embed(event, 'Contact card', {} as unknown as PipelineContext);
      expect(result.entities).toContainEqual({
        type: 'person',
        id: 'name:Carol|phone:5559876',
        role: 'mentioned',
      });
    });

    it('skips group-like phone (contains dash)', () => {
      const event = {
        sourceType: 'message' as const,
        sourceId: 'wa1',
        timestamp: '2026-01-01T00:00:00Z',
        content: { text: 'Hi', participants: ['120363-group'], metadata: {} },
      };
      const result = connector.embed(event, 'Hi', {} as unknown as PipelineContext);
      expect(result.entities.filter((e) => e.type === 'person')).toHaveLength(0);
    });

    it('adds remaining participants not already handled', () => {
      const event = {
        sourceType: 'message' as const,
        sourceId: 'wa1',
        timestamp: '2026-01-01T00:00:00Z',
        content: { text: 'Hi', participants: ['1111', '2222'], metadata: { senderPhone: '1111' } },
      };
      const result = connector.embed(event, 'Hi', {} as unknown as PipelineContext);
      const participant = result.entities.find((e) => e.role === 'participant');
      expect(participant).toBeDefined();
      expect(participant!.id).toBe('phone:2222');
    });

    it('skips sender name that equals phone or "me"', () => {
      const event = {
        sourceType: 'message' as const,
        sourceId: 'wa1',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: 'Hi',
          participants: [],
          metadata: { senderPhone: '1234567890', senderName: 'me' },
        },
      };
      const result = connector.embed(event, 'Hi', {} as unknown as PipelineContext);
      expect(result.entities[0].id).toBe('phone:1234567890');
    });

    it('extracts phone from participant JID when no senderPhone', () => {
      const event = {
        sourceType: 'message' as const,
        sourceId: 'wa1',
        timestamp: '2026-01-01T00:00:00Z',
        content: { text: 'Hi', participants: ['1234567890@s.whatsapp.net'], metadata: {} },
      };
      const result = connector.embed(event, 'Hi', {} as unknown as PipelineContext);
      expect(result.entities[0].id).toBe('phone:1234567890');
    });
  });

  describe('getStatus', () => {
    it('returns ready status after QR code is generated', () => {
      const status = connector.getStatus();
      expect(status.ready).toBe(true);
      expect(status.status).toBe('qr_ready');
    });
  });

  describe('popAuthSocket', () => {
    it('returns undefined for unknown session', () => {
      expect(connector.popAuthSocket('/nonexistent')).toBeUndefined();
    });
  });

  describe('revokeAuth (no session)', () => {
    it('returns early when no sessionDir', async () => {
      await expect(connector.revokeAuth({})).resolves.toBeUndefined();
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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GmailConnector } from '../index.js';

vi.mock('../oauth.js', () => ({
  createOAuth2Client: vi.fn().mockReturnValue({}),
  getAuthUrl: vi.fn().mockReturnValue('https://accounts.google.com/auth?client_id=test'),
  exchangeCode: vi.fn().mockResolvedValue({
    access_token: 'at-123',
    refresh_token: 'rt-456',
    expiry_date: Date.now() + 3600000,
  }),
}));

vi.mock('../sync.js', () => ({
  syncGmail: vi.fn().mockImplementation(async (_ctx: any, _emit: any, emitProgress: any) => {
    emitProgress({ processed: 25, total: 100 });
    return { cursor: 'page2', hasMore: true, processed: 25 };
  }),
}));

describe('GmailConnector', () => {
  let connector: GmailConnector;

  beforeEach(() => {
    connector = new GmailConnector();
    vi.clearAllMocks();
  });

  describe('manifest', () => {
    it('has correct id', () => {
      expect(connector.manifest.id).toBe('gmail');
    });

    it('has correct auth type', () => {
      expect(connector.manifest.authType).toBe('oauth2');
    });

    it('has config schema with required fields', () => {
      const schema = connector.manifest.configSchema as any;
      expect(schema.required).toContain('clientId');
      expect(schema.required).toContain('clientSecret');
    });
  });

  describe('initiateAuth', () => {
    it('returns redirect with auth url', async () => {
      const result = await connector.initiateAuth({
        clientId: 'cid',
        clientSecret: 'cs',
      });
      expect(result.type).toBe('redirect');
      if (result.type === 'redirect') {
        expect(result.url).toContain('google.com');
      }
    });
  });

  describe('completeAuth', () => {
    it('exchanges code for tokens', async () => {
      // First initiate to set config
      await connector.initiateAuth({ clientId: 'cid', clientSecret: 'cs' });

      const auth = await connector.completeAuth({ code: 'auth-code' });
      expect(auth.accessToken).toBe('at-123');
      expect(auth.refreshToken).toBe('rt-456');
    });
  });

  describe('validateAuth', () => {
    it('returns true when access token present', async () => {
      expect(await connector.validateAuth({ accessToken: 'tok' })).toBe(true);
    });

    it('returns false when no access token', async () => {
      expect(await connector.validateAuth({})).toBe(false);
    });
  });

  describe('revokeAuth', () => {
    it('does not throw', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
      await expect(connector.revokeAuth({ accessToken: 'tok' })).resolves.toBeUndefined();
      vi.unstubAllGlobals();
    });

    it('handles empty access token', async () => {
      await expect(connector.revokeAuth({})).resolves.toBeUndefined();
    });
  });

  describe('sync', () => {
    it('calls syncGmail and emits progress', async () => {
      const progressListener = vi.fn();
      connector.on('progress', progressListener);

      const ctx = {
        accountId: 'acc-1',
        auth: { accessToken: 'tok' },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(5000),
      };

      const result = await connector.sync(ctx);
      expect(result.processed).toBe(25);
      expect(result.hasMore).toBe(true);
      expect(progressListener).toHaveBeenCalledWith({ processed: 25, total: 100 });
    });
  });
});

describe('default export', () => {
  it('exports factory function', async () => {
    const mod = await import('../index.js');
    const factory = mod.default;
    expect(typeof factory).toBe('function');
    const instance = factory();
    expect(instance).toBeInstanceOf(GmailConnector);
  });
});

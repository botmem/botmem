import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackConnector } from '../index.js';

vi.mock('../oauth.js', () => ({
  getSlackAuthUrl: vi.fn().mockReturnValue('https://slack.com/oauth/v2/authorize?client_id=test'),
  exchangeSlackCode: vi.fn().mockResolvedValue({
    ok: true,
    access_token: 'xoxb-test',
    team: { id: 'T123', name: 'test-workspace' },
  }),
}));

vi.mock('../sync.js', () => ({
  syncSlack: vi.fn().mockResolvedValue({ cursor: '{"channels":{}}', hasMore: false, processed: 15 }),
}));

describe('SlackConnector', () => {
  let connector: SlackConnector;

  beforeEach(() => {
    connector = new SlackConnector();
    vi.clearAllMocks();
  });

  describe('manifest', () => {
    it('has correct id', () => {
      expect(connector.manifest.id).toBe('slack');
    });

    it('has correct auth type', () => {
      expect(connector.manifest.authType).toBe('oauth2');
    });

    it('has config fields for token and OAuth', () => {
      const schema = connector.manifest.configSchema as any;
      expect(schema.properties.token).toBeDefined();
      expect(schema.properties.clientId).toBeDefined();
      expect(schema.properties.clientSecret).toBeDefined();
    });
  });

  describe('initiateAuth', () => {
    it('returns redirect with slack auth url for OAuth flow', async () => {
      const result = await connector.initiateAuth({ clientId: 'cid', clientSecret: 'cs' });
      expect(result.type).toBe('redirect');
      if (result.type === 'redirect') {
        expect(result.url).toContain('slack.com');
      }
    });

    it('returns complete with token and fetches identity', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: true, user: 'testuser', team: 'myteam' }),
      }));
      const result = await connector.initiateAuth({ token: 'xoxp-test-token' });
      expect(result.type).toBe('complete');
      if (result.type === 'complete') {
        expect(result.auth.accessToken).toBe('xoxp-test-token');
        expect(result.auth.identifier).toBe('testuser@myteam');
      }
      vi.unstubAllGlobals();
    });
  });

  describe('completeAuth', () => {
    it('exchanges code and returns auth context with identity', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: true, user: 'testuser', team: 'myteam' }),
      }));
      await connector.initiateAuth({ clientId: 'cid', clientSecret: 'cs' });
      const auth = await connector.completeAuth({ code: 'slack-code' });
      expect(auth.accessToken).toBe('xoxb-test');
      expect(auth.raw?.teamId).toBe('T123');
      expect(auth.identifier).toBe('testuser@myteam');
      vi.unstubAllGlobals();
    });
  });

  describe('validateAuth', () => {
    it('calls slack API to validate', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: true }),
      }));
      const result = await connector.validateAuth({ accessToken: 'xoxb-test' });
      expect(result).toBe(true);
      vi.unstubAllGlobals();
    });

    it('returns false on API error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
      const result = await connector.validateAuth({ accessToken: 'bad' });
      expect(result).toBe(false);
      vi.unstubAllGlobals();
    });
  });

  describe('revokeAuth', () => {
    it('does not throw', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
      await expect(connector.revokeAuth({ accessToken: 'tok' })).resolves.toBeUndefined();
      vi.unstubAllGlobals();
    });
  });

  describe('sync', () => {
    it('calls syncSlack and emits progress', async () => {
      const progressListener = vi.fn();
      connector.on('progress', progressListener);

      const ctx = {
        accountId: 'acc-1',
        auth: { accessToken: 'xoxb-test' },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(5000),
      };

      const result = await connector.sync(ctx);
      expect(result.processed).toBe(15);
      expect(progressListener).toHaveBeenCalledWith({ processed: 15 });
    });
  });
});

describe('default export', () => {
  it('exports factory function', async () => {
    const mod = await import('../index.js');
    expect(typeof mod.default).toBe('function');
    expect(mod.default()).toBeInstanceOf(SlackConnector);
  });
});

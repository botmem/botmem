import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getSlackAuthUrl, exchangeSlackCode } from '../oauth.js';

describe('getSlackAuthUrl', () => {
  it('generates correct URL with params', () => {
    const url = getSlackAuthUrl('client-123', 'http://localhost:3001/callback');
    expect(url).toContain('slack.com/oauth/v2/authorize');
    expect(url).toContain('client_id=client-123');
    expect(url).toContain('redirect_uri=');
    expect(url).toContain('scope=');
  });
});

describe('exchangeSlackCode', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('exchanges code for access token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        ok: true,
        access_token: 'xoxb-result',
        team: { id: 'T1', name: 'ws' },
      }),
    }));

    const result = await exchangeSlackCode('cid', 'cs', 'code-123', 'http://localhost/cb');
    expect(result.access_token).toBe('xoxb-result');
    expect(result.ok).toBe(true);
    vi.unstubAllGlobals();
  });

  it('throws on OAuth error response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: false, error: 'invalid_code' }),
    }));

    await expect(
      exchangeSlackCode('cid', 'cs', 'bad-code', 'http://localhost/cb')
    ).rejects.toThrow('Slack OAuth error');
    vi.unstubAllGlobals();
  });
});

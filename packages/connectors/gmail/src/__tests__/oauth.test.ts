import { describe, it, expect, vi } from 'vitest';

vi.mock('googleapis', () => {
  const mockClient = {
    generateAuthUrl: vi.fn().mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth?scope=gmail.readonly'),
    getToken: vi.fn().mockResolvedValue({
      tokens: { access_token: 'at', refresh_token: 'rt', expiry_date: 9999999999 },
    }),
  };
  return {
    google: {
      auth: {
        OAuth2: vi.fn().mockReturnValue(mockClient),
      },
    },
  };
});

import { createOAuth2Client, getAuthUrl, exchangeCode } from '../oauth.js';

describe('createOAuth2Client', () => {
  it('creates OAuth2 client', () => {
    const client = createOAuth2Client('cid', 'cs', 'http://localhost/callback');
    expect(client).toBeDefined();
  });
});

describe('getAuthUrl', () => {
  it('generates auth URL', () => {
    const client = createOAuth2Client('cid', 'cs', 'http://localhost/callback');
    const url = getAuthUrl(client);
    expect(url).toContain('google.com');
  });
});

describe('exchangeCode', () => {
  it('exchanges code for tokens', async () => {
    const client = createOAuth2Client('cid', 'cs', 'http://localhost/callback');
    const tokens = await exchangeCode(client, 'auth-code');
    expect(tokens.access_token).toBe('at');
    expect(tokens.refresh_token).toBe('rt');
  });
});

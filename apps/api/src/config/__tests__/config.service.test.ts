import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigService } from '../config.service';

describe('ConfigService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns default port 12412', () => {
    const config = new ConfigService();
    expect(config.port).toBe(12412);
  });

  it('returns custom port from env', () => {
    process.env.PORT = '4000';
    const config = new ConfigService();
    expect(config.port).toBe(4000);
  });

  it('returns default redis url', () => {
    const config = new ConfigService();
    expect(config.redisUrl).toBe('redis://localhost:6379');
  });

  it('returns custom redis url from env', () => {
    process.env.REDIS_URL = 'redis://custom:6380';
    const config = new ConfigService();
    expect(config.redisUrl).toBe('redis://custom:6380');
  });

  it('returns default plugins dir', () => {
    const config = new ConfigService();
    expect(config.pluginsDir).toBe('./plugins');
  });

  it('returns default frontend url', () => {
    const config = new ConfigService();
    expect(config.frontendUrl).toBe('http://localhost:12412');
  });

  it('returns custom frontend url from env', () => {
    process.env.FRONTEND_URL = 'https://app.example.com';
    const config = new ConfigService();
    expect(config.frontendUrl).toBe('https://app.example.com');
  });

  describe('Gmail OAuth server-side creds', () => {
    it('returns empty gmailClientId by default', () => {
      const config = new ConfigService();
      expect(config.gmailClientId).toBe('');
    });

    it('returns gmailClientId from GMAIL_CLIENT_ID env', () => {
      process.env.GMAIL_CLIENT_ID = 'server-cid';
      const config = new ConfigService();
      expect(config.gmailClientId).toBe('server-cid');
    });

    it('returns empty gmailClientSecret by default', () => {
      const config = new ConfigService();
      expect(config.gmailClientSecret).toBe('');
    });

    it('returns gmailClientSecret from GMAIL_CLIENT_SECRET env', () => {
      process.env.GMAIL_CLIENT_SECRET = 'server-csec';
      const config = new ConfigService();
      expect(config.gmailClientSecret).toBe('server-csec');
    });
  });
});

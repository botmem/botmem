import { describe, it, expect, vi, afterEach } from 'vitest';

async function loadUrls(origin?: string) {
  vi.resetModules();
  if (origin) {
    vi.stubEnv('VITE_API_ORIGIN', origin);
  } else {
    vi.stubEnv('VITE_API_ORIGIN', '');
  }
  return import('../urls');
}

describe('appleTunnelUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('rewrites the app host to the api host (prod config)', async () => {
    const { appleTunnelUrl } = await loadUrls('https://app.botmem.xyz');
    expect(appleTunnelUrl()).toBe('wss://api.botmem.xyz/apple-tunnel');
  });

  it('rewrites the apex botmem.xyz host to the api host', async () => {
    const { appleTunnelUrl } = await loadUrls('https://botmem.xyz');
    expect(appleTunnelUrl()).toBe('wss://api.botmem.xyz/apple-tunnel');
  });

  it('leaves the api host untouched', async () => {
    const { appleTunnelUrl } = await loadUrls('https://api.botmem.xyz');
    expect(appleTunnelUrl()).toBe('wss://api.botmem.xyz/apple-tunnel');
  });

  it('leaves localhost untouched', async () => {
    const { appleTunnelUrl } = await loadUrls('http://localhost:12412');
    expect(appleTunnelUrl()).toBe('ws://localhost:12412/apple-tunnel');
  });
});

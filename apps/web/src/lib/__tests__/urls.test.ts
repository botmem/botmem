import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadUrls(origin: string, env: Record<string, string> = {}) {
  vi.resetModules();
  vi.stubGlobal('window', { location: { origin } });

  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }

  return import('../urls');
}

describe('url helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('uses relative API paths when the API origin is the current app origin', async () => {
    const urls = await loadUrls('http://localhost:12412');

    expect(urls.API_ORIGIN).toBe('http://localhost:12412');
    expect(urls.API_BASE).toBe('/api');
    expect(urls.appUrl('/memory')).toBe('http://localhost:12412/memory');
    expect(urls.landingUrl('pricing')).toBe('http://localhost:12412/pricing');
    expect(urls.wsUrl('/events')).toBe('ws://localhost:12412/events');
  });

  it('infers the production API host from app and landing hosts', async () => {
    const appUrls = await loadUrls('https://app.botmem.xyz');
    expect(appUrls.API_ORIGIN).toBe('https://api.botmem.xyz');
    expect(appUrls.API_BASE).toBe('https://api.botmem.xyz');
    expect(appUrls.wsUrl('/events')).toBe('wss://api.botmem.xyz/events');

    const landingUrls = await loadUrls('https://botmem.xyz');
    expect(landingUrls.API_ORIGIN).toBe('https://api.botmem.xyz');
  });

  it('honors configured origins and appends /api for non-API hosts', async () => {
    const urls = await loadUrls('http://localhost:12412', {
      VITE_API_ORIGIN: 'https://backend.example.com/',
      VITE_APP_URL: 'https://app.example.com',
      VITE_LANDING_URL: 'https://example.com',
    });

    expect(urls.API_ORIGIN).toBe('https://backend.example.com/');
    expect(urls.API_BASE).toBe('https://backend.example.com/api');
    expect(urls.appUrl('/settings')).toBe('https://app.example.com/settings');
    expect(urls.landingUrl('/')).toBe('https://example.com/');
  });

  it('uses an explicit API base URL without normalizing it', async () => {
    const urls = await loadUrls('http://localhost:12412', {
      VITE_API_ORIGIN: 'https://backend.example.com',
      VITE_API_BASE_URL: 'https://gateway.example.com/custom',
    });

    expect(urls.API_ORIGIN).toBe('https://backend.example.com');
    expect(urls.API_BASE).toBe('https://gateway.example.com/custom');
  });

  it('falls back to string joining when a configured API origin is not URL-parseable', async () => {
    const urls = await loadUrls('http://localhost:12412', {
      VITE_API_ORIGIN: 'not a valid origin',
    });

    expect(urls.API_BASE).toBe('not a valid origin/api');
  });
});

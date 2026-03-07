import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ImmichConnector } from '../index.js';

function makeSyncCtx(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acc-1',
    auth: { accessToken: 'test-key', raw: { host: 'http://localhost:2283' } },
    cursor: null as string | null,
    jobId: 'j1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    signal: AbortSignal.timeout(5000),
    ...overrides,
  };
}

function makeAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: 'asset-1',
    type: 'IMAGE',
    originalFileName: 'sunset.jpg',
    originalMimeType: 'image/jpeg',
    fileCreatedAt: '2026-01-15T18:30:00.000Z',
    fileModifiedAt: '2026-01-15T18:30:00.000Z',
    localDateTime: '2026-01-15T18:30:00.000Z',
    createdAt: '2026-01-16T10:00:00.000Z',
    isFavorite: false,
    isArchived: false,
    isTrashed: false,
    exifInfo: {
      city: 'Santa Monica',
      state: 'California',
      country: 'US',
      latitude: 34.0195,
      longitude: -118.4912,
      make: 'Sony',
      model: 'A7III',
      lensModel: '24-70mm f/2.8',
      focalLength: 35,
      fNumber: 8,
      exposureTime: '1/250',
      iso: 100,
      exifImageWidth: 6000,
      exifImageHeight: 4000,
      description: 'Beautiful sunset at the beach',
    },
    people: [
      { id: 'p1', name: 'John Doe', birthDate: null },
      { id: 'p2', name: 'Jane Smith', birthDate: null },
    ],
    tags: [
      { id: 't1', name: 'vacation', value: 'vacation' },
      { id: 't2', name: 'summer', value: 'summer' },
    ],
    ...overrides,
  };
}

/** Build a mock fetch that returns stats + search results */
function mockFetchForSync(
  assets: unknown[],
  opts: { nextPage?: string; imageCount?: number } = {},
) {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : '';

    if (urlStr.includes('/api/assets/statistics')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ images: opts.imageCount ?? assets.length }),
      });
    }

    if (urlStr.includes('/api/search/metadata')) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            assets: {
              items: assets,
              nextPage: opts.nextPage ?? null,
            },
          }),
      });
    }

    // Fallback (ping, etc.)
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

describe('ImmichConnector', () => {
  let connector: ImmichConnector;

  beforeEach(() => {
    connector = new ImmichConnector();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ─── Manifest ────────────────────────────────────────────
  describe('manifest', () => {
    it('has correct id', () => {
      expect(connector.manifest.id).toBe('photos');
    });

    it('has api-key auth type', () => {
      expect(connector.manifest.authType).toBe('api-key');
    });

    it('requires host and apiKey', () => {
      const schema = connector.manifest.configSchema as any;
      expect(schema.required).toContain('host');
      expect(schema.required).toContain('apiKey');
    });
  });

  // ─── Auth ────────────────────────────────────────────────
  describe('initiateAuth', () => {
    it('validates and returns complete auth', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
      const result = await connector.initiateAuth({
        host: 'http://localhost:2283',
        apiKey: 'test-key',
      });
      expect(result.type).toBe('complete');
      if (result.type === 'complete') {
        expect(result.auth.accessToken).toBe('test-key');
        expect(result.auth.raw?.host).toBe('http://localhost:2283');
      }
    });

    it('strips trailing slash from host', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
      const result = await connector.initiateAuth({
        host: 'http://localhost:2283/',
        apiKey: 'key',
      });
      if (result.type === 'complete') {
        expect(result.auth.raw?.host).toBe('http://localhost:2283');
      }
    });

    it('throws when server unreachable', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
      await expect(
        connector.initiateAuth({ host: 'http://bad', apiKey: 'bad' }),
      ).rejects.toThrow('Failed to connect');
    });
  });

  describe('completeAuth', () => {
    it('returns auth context', async () => {
      const auth = await connector.completeAuth({ apiKey: 'key', host: 'http://host' });
      expect(auth.accessToken).toBe('key');
      expect(auth.raw?.host).toBe('http://host');
    });
  });

  describe('validateAuth', () => {
    it('returns true when server responds ok', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
      const result = await connector.validateAuth({
        accessToken: 'key',
        raw: { host: 'http://localhost:2283' },
      });
      expect(result).toBe(true);
    });

    it('returns false on failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fail')));
      const result = await connector.validateAuth({
        accessToken: 'key',
        raw: { host: 'http://bad' },
      });
      expect(result).toBe(false);
    });
  });

  describe('revokeAuth', () => {
    it('does not throw', async () => {
      await expect(connector.revokeAuth({})).resolves.toBeUndefined();
    });
  });

  // ─── Sync ────────────────────────────────────────────────
  describe('sync', () => {
    it('calls POST /search/metadata with correct body for full sync', async () => {
      const mockFetch = mockFetchForSync([makeAsset()]);
      vi.stubGlobal('fetch', mockFetch);

      connector.on('data', () => {});
      await connector.sync(makeSyncCtx());

      // Find the search call
      const searchCall = mockFetch.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('/api/search/metadata'),
      );
      expect(searchCall).toBeDefined();
      const body = JSON.parse(searchCall![1].body);
      expect(body.order).toBe('desc');
      expect(body.type).toBe('IMAGE');
      expect(body.page).toBe(1);
      expect(body.size).toBe(100);
      expect(body.withExif).toBe(true);
      expect(body.withPeople).toBe(true);
      expect(body.takenAfter).toBeUndefined();
    });

    it('sends takenAfter from cursor for incremental sync', async () => {
      const mockFetch = mockFetchForSync([makeAsset()]);
      vi.stubGlobal('fetch', mockFetch);

      const cursor = JSON.stringify({ takenAfter: '2026-01-01T00:00:00.000Z', page: 1 });
      connector.on('data', () => {});
      await connector.sync(makeSyncCtx({ cursor }));

      const searchCall = mockFetch.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('/api/search/metadata'),
      );
      const body = JSON.parse(searchCall![1].body);
      expect(body.takenAfter).toBe('2026-01-01T00:00:00.000Z');
      expect(body.page).toBe(1);
    });

    it('emits rich data events with location, camera, people', async () => {
      vi.stubGlobal('fetch', mockFetchForSync([makeAsset()]));

      const dataListener = vi.fn();
      connector.on('data', dataListener);

      await connector.sync(makeSyncCtx());

      expect(dataListener).toHaveBeenCalledTimes(1);
      const event = dataListener.mock.calls[0][0];

      expect(event.sourceType).toBe('file');
      expect(event.sourceId).toBe('asset-1');
      expect(event.content.text).toContain('Photo: sunset.jpg');
      expect(event.content.text).toContain('Santa Monica');
      expect(event.content.text).toContain('Sony A7III');
      expect(event.content.text).toContain('John Doe');
      expect(event.content.text).toContain('vacation');
      expect(event.content.participants).toEqual(['John Doe', 'Jane Smith']);
      expect(event.content.metadata.people).toHaveLength(2);
      expect(event.content.metadata.people[0].id).toBe('p1');
      expect(event.content.metadata.latitude).toBe(34.0195);
    });

    it('reports progress from statistics endpoint', async () => {
      vi.stubGlobal('fetch', mockFetchForSync([makeAsset()], { imageCount: 500 }));

      const progressListener = vi.fn();
      connector.on('data', () => {});
      connector.on('progress', progressListener);

      await connector.sync(makeSyncCtx());

      expect(progressListener).toHaveBeenCalledWith(
        expect.objectContaining({ processed: 0, total: 500 }),
      );
    });

    it('returns hasMore=true and advances page when nextPage exists', async () => {
      vi.stubGlobal(
        'fetch',
        mockFetchForSync([makeAsset()], { nextPage: 'some-cursor-token' }),
      );

      connector.on('data', () => {});
      const result = await connector.sync(makeSyncCtx());

      expect(result.hasMore).toBe(true);
      expect(result.processed).toBe(1);

      const nextCursor = JSON.parse(result.cursor!);
      expect(nextCursor.page).toBe(2);
      expect(nextCursor.takenAfter).toBeUndefined();
    });

    it('returns hasMore=false and stores timestamp when sweep completes', async () => {
      vi.stubGlobal('fetch', mockFetchForSync([makeAsset()]));

      connector.on('data', () => {});
      const result = await connector.sync(makeSyncCtx());

      expect(result.hasMore).toBe(false);
      expect(result.processed).toBe(1);

      const nextCursor = JSON.parse(result.cursor!);
      expect(nextCursor.page).toBe(1);
      expect(nextCursor.takenAfter).toBe('2026-01-15T18:30:00.000Z');
    });

    it('continues pagination from cursor page > 1', async () => {
      const mockFetch = mockFetchForSync([makeAsset()], { nextPage: 'more' });
      vi.stubGlobal('fetch', mockFetch);

      const cursor = JSON.stringify({ takenAfter: '2026-01-01T00:00:00.000Z', page: 3 });
      connector.on('data', () => {});
      const result = await connector.sync(makeSyncCtx({ cursor }));

      // Should have sent page=3
      const searchCall = mockFetch.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('/api/search/metadata'),
      );
      const body = JSON.parse(searchCall![1].body);
      expect(body.page).toBe(3);

      // Next cursor should be page 4
      expect(result.hasMore).toBe(true);
      const nextCursor = JSON.parse(result.cursor!);
      expect(nextCursor.page).toBe(4);
      expect(nextCursor.takenAfter).toBe('2026-01-01T00:00:00.000Z');
    });

    it('handles asset with minimal EXIF (no location, no people, no tags)', async () => {
      const minimalAsset = makeAsset({
        id: 'min-1',
        originalFileName: 'IMG_0001.jpg',
        exifInfo: {},
        people: [],
        tags: [],
      });
      vi.stubGlobal('fetch', mockFetchForSync([minimalAsset]));

      const dataListener = vi.fn();
      connector.on('data', dataListener);

      await connector.sync(makeSyncCtx());

      const event = dataListener.mock.calls[0][0];
      expect(event.content.text).toContain('Photo: IMG_0001.jpg');
      expect(event.content.text).not.toContain('Location:');
      expect(event.content.text).not.toContain('Camera:');
      expect(event.content.text).not.toContain('People:');
      expect(event.content.text).not.toContain('Tags:');
      expect(event.content.participants).toEqual([]);
    });

    it('handles empty results page', async () => {
      vi.stubGlobal('fetch', mockFetchForSync([]));

      connector.on('data', () => {});
      const result = await connector.sync(makeSyncCtx());

      expect(result.processed).toBe(0);
      expect(result.hasMore).toBe(false);
    });

    it('throws on API error', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((url: string) => {
          if (url.includes('/api/assets/statistics')) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ images: 0 }) });
          }
          if (url.includes('/api/search/metadata')) {
            return Promise.resolve({ ok: false, status: 500 });
          }
          return Promise.resolve({ ok: true });
        }),
      );

      const ctx = makeSyncCtx();
      await expect(connector.sync(ctx)).rejects.toThrow('Immich API error');
    });

    it('continues gracefully when statistics endpoint fails', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((url: string) => {
          if (url.includes('/api/assets/statistics')) {
            return Promise.resolve({ ok: false, status: 500 });
          }
          if (url.includes('/api/search/metadata')) {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve({ assets: { items: [makeAsset()], nextPage: null } }),
            });
          }
          return Promise.resolve({ ok: true });
        }),
      );

      connector.on('data', () => {});
      const result = await connector.sync(makeSyncCtx());
      expect(result.processed).toBe(1);
    });
  });
});

describe('default export', () => {
  it('exports factory function', async () => {
    const mod = await import('../index.js');
    expect(typeof mod.default).toBe('function');
    expect(mod.default()).toBeInstanceOf(ImmichConnector);
  });
});

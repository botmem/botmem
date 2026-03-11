import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ImmichConnector } from '../index.js';
import type { PipelineContext } from '@botmem/connector-sdk';

const pipelineCtx: PipelineContext = {
  accountId: 'acc-1',
  auth: { accessToken: 'test' },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
};

function makeSyncCtx(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acc-1',
    auth: { accessToken: 'test-key', raw: { host: 'http://immich.example.com' } },
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
  return vi.fn().mockImplementation((url: string, _init?: RequestInit) => {
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
      const schema = connector.manifest.configSchema as { required: string[] };
      expect(schema.required).toContain('host');
      expect(schema.required).toContain('apiKey');
    });
  });

  // ─── Auth ────────────────────────────────────────────────
  describe('initiateAuth', () => {
    it('validates and returns complete auth', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
      const result = await connector.initiateAuth({
        host: 'http://immich.example.com',
        apiKey: 'test-key',
      });
      expect(result.type).toBe('complete');
      if (result.type === 'complete') {
        expect(result.auth.accessToken).toBe('test-key');
        expect(result.auth.raw?.host).toBe('http://immich.example.com');
      }
    });

    it('strips trailing slash from host', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
      const result = await connector.initiateAuth({
        host: 'http://immich.example.com/',
        apiKey: 'key',
      });
      if (result.type === 'complete') {
        expect(result.auth.raw?.host).toBe('http://immich.example.com');
      }
    });

    it('throws when server unreachable', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
      await expect(connector.initiateAuth({ host: 'http://bad', apiKey: 'bad' })).rejects.toThrow(
        'Failed to connect',
      );
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
        raw: { host: 'http://immich.example.com' },
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
        (c: [string, RequestInit]) =>
          typeof c[0] === 'string' && c[0].includes('/api/search/metadata'),
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
        (c: [string, RequestInit]) =>
          typeof c[0] === 'string' && c[0].includes('/api/search/metadata'),
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

      expect(event.sourceType).toBe('photo');
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
      vi.stubGlobal('fetch', mockFetchForSync([makeAsset()], { nextPage: 'some-cursor-token' }));

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
        (c: [string, RequestInit]) =>
          typeof c[0] === 'string' && c[0].includes('/api/search/metadata'),
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
      await expect(connector.sync(ctx)).rejects.toThrow('Immich search/metadata returned 500');
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

  // ─── Embed ────────────────────────────────────────────
  describe('embed', () => {
    it('extracts person entities from people metadata', () => {
      const event = {
        sourceType: 'photo' as const,
        sourceId: 'a1',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: 'Photo: test.jpg',
          participants: ['John Doe'],
          metadata: {
            people: [
              { id: 'p1', name: 'John Doe' },
              { id: 'p2', name: '' },
            ],
          },
        },
      };
      const result = connector.embed(event, 'Photo: test.jpg', pipelineCtx);
      // Should only include named people, skip empty name
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0]).toEqual({
        type: 'person',
        id: 'immich_person_id:p1|name:John Doe',
        role: 'participant',
      });
    });

    it('extracts pet entities when person type is pet', () => {
      const event = {
        sourceType: 'photo' as const,
        sourceId: 'a1',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: 'Photo: cat.jpg',
          participants: [],
          metadata: {
            people: [{ id: 'p1', name: 'Whiskers', type: 'pet' }],
          },
        },
      };
      const result = connector.embed(event, 'Photo: cat.jpg', pipelineCtx);
      expect(result.entities[0].type).toBe('pet');
    });

    it('extracts location entity from lat/lon', () => {
      const event = {
        sourceType: 'photo' as const,
        sourceId: 'a1',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: 'Photo: test.jpg',
          participants: [],
          metadata: { latitude: 34.0195, longitude: -118.4912, people: [] },
        },
      };
      const result = connector.embed(event, 'Photo: test.jpg', pipelineCtx);
      expect(result.entities).toContainEqual({
        type: 'location',
        id: 'geo:34.0195,-118.4912',
        role: 'location',
      });
    });

    it('does not extract location when lat/lon missing', () => {
      const event = {
        sourceType: 'photo' as const,
        sourceId: 'a1',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: 'Photo: test.jpg',
          participants: [],
          metadata: { people: [] },
        },
      };
      const result = connector.embed(event, 'Photo: test.jpg', pipelineCtx);
      expect(result.entities.filter((e) => e.type === 'location')).toHaveLength(0);
    });

    it('includes participants not already in people array', () => {
      const event = {
        sourceType: 'photo' as const,
        sourceId: 'a1',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: 'Photo: test.jpg',
          participants: ['John Doe', 'Extra Person'],
          metadata: {
            people: [{ id: 'p1', name: 'John Doe' }],
          },
        },
      };
      const result = connector.embed(event, 'Photo: test.jpg', pipelineCtx);
      // p1 from people, Extra Person as additional participant
      expect(result.entities).toHaveLength(2);
      expect(result.entities[1]).toEqual({
        type: 'person',
        id: 'name:Extra Person',
        role: 'participant',
      });
    });

    it('handles empty content metadata gracefully', () => {
      const event = {
        sourceType: 'photo' as const,
        sourceId: 'a1',
        timestamp: '2026-01-01T00:00:00Z',
        content: { text: 'Photo: test.jpg', metadata: {} },
      };
      const result = connector.embed(event, 'Photo: test.jpg', pipelineCtx);
      expect(result.entities).toEqual([]);
    });

    it('skips empty participant names', () => {
      const event = {
        sourceType: 'photo' as const,
        sourceId: 'a1',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: 'Photo: test.jpg',
          participants: ['', 'Alice'],
          metadata: { people: [] },
        },
      };
      const result = connector.embed(event, 'Photo: test.jpg', pipelineCtx);
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].id).toBe('name:Alice');
    });
  });

  // ─── initiateAuth server info branch ──────────────────
  describe('initiateAuth (server info)', () => {
    it('uses server name from /api/server/about when available', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((url: string) => {
          if (url.includes('/api/server/ping')) return Promise.resolve({ ok: true });
          if (url.includes('/api/server/about'))
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve({ name: 'My Immich' }),
            });
          return Promise.resolve({ ok: true });
        }),
      );
      const result = await connector.initiateAuth({
        host: 'http://immich.example.com',
        apiKey: 'k',
      });
      if (result.type === 'complete') {
        expect(result.auth.identifier).toBe('My Immich');
      }
    });

    it('falls back to host when /api/server/about fails', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((url: string) => {
          if (url.includes('/api/server/ping')) return Promise.resolve({ ok: true });
          if (url.includes('/api/server/about')) return Promise.reject(new Error('fail'));
          return Promise.resolve({ ok: true });
        }),
      );
      const result = await connector.initiateAuth({
        host: 'http://immich.example.com',
        apiKey: 'k',
      });
      if (result.type === 'complete') {
        expect(result.auth.identifier).toBe('http://immich.example.com');
      }
    });

    it('falls back to host when /api/server/about returns not ok', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((url: string) => {
          if (url.includes('/api/server/ping')) return Promise.resolve({ ok: true });
          if (url.includes('/api/server/about')) return Promise.resolve({ ok: false });
          return Promise.resolve({ ok: true });
        }),
      );
      const result = await connector.initiateAuth({
        host: 'http://immich.example.com',
        apiKey: 'k',
      });
      if (result.type === 'complete') {
        expect(result.auth.identifier).toBe('http://immich.example.com');
      }
    });

    it('strips /api suffix from host', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
      const result = await connector.initiateAuth({
        host: 'http://immich.example.com/api',
        apiKey: 'k',
      });
      if (result.type === 'complete') {
        expect(result.auth.raw?.host).toBe('http://immich.example.com');
      }
    });
  });

  // ─── Sync edge cases ─────────────────────────────────
  describe('sync (edge cases)', () => {
    it('returns original cursor when no assets and no lastTimestamp', async () => {
      vi.stubGlobal('fetch', mockFetchForSync([]));
      connector.on('data', () => {});
      const cursor = JSON.stringify({ takenAfter: '2026-01-01T00:00:00.000Z', page: 1 });
      const result = await connector.sync(makeSyncCtx({ cursor }));
      expect(result.cursor).toBe(cursor);
      expect(result.hasMore).toBe(false);
    });

    it('provides 404 hint in error message', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((url: string) => {
          if (url.includes('/api/assets/statistics'))
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ images: 0 }) });
          if (url.includes('/api/search/metadata'))
            return Promise.resolve({ ok: false, status: 404 });
          return Promise.resolve({ ok: true });
        }),
      );
      await expect(connector.sync(makeSyncCtx())).rejects.toThrow('check that the host URL');
    });

    it('handles statistics returning total instead of images', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((url: string) => {
          if (url.includes('/api/assets/statistics'))
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ total: 300 }) });
          if (url.includes('/api/search/metadata'))
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve({ assets: { items: [], nextPage: null } }),
            });
          return Promise.resolve({ ok: true });
        }),
      );
      const progressListener = vi.fn();
      connector.on('data', () => {});
      connector.on('progress', progressListener);
      await connector.sync(makeSyncCtx());
      expect(progressListener).toHaveBeenCalledWith(expect.objectContaining({ total: 300 }));
    });

    it('composeText handles asset with model only (no make)', async () => {
      const asset = makeAsset({ exifInfo: { model: 'iPhone 15 Pro' } });
      vi.stubGlobal('fetch', mockFetchForSync([asset]));
      const dataListener = vi.fn();
      connector.on('data', dataListener);
      await connector.sync(makeSyncCtx());
      expect(dataListener.mock.calls[0][0].content.text).toContain('iPhone 15 Pro');
    });

    it('respects abort signal', async () => {
      const ac = new AbortController();
      ac.abort(); // pre-abort
      const assets = [makeAsset(), makeAsset({ id: 'asset-2' })];
      vi.stubGlobal('fetch', mockFetchForSync(assets));
      const dataListener = vi.fn();
      connector.on('data', dataListener);
      await connector.sync(makeSyncCtx({ signal: ac.signal }));
      // Should have stopped before processing assets
      expect(dataListener).not.toHaveBeenCalled();
    });
  });

  // ─── composeText branches ─────────────────────────────
  describe('composeText branches', () => {
    it('handles asset with only localDateTime (no fileCreatedAt)', async () => {
      const asset = makeAsset({ fileCreatedAt: '', localDateTime: '2026-06-01T12:00:00.000Z' });
      vi.stubGlobal('fetch', mockFetchForSync([asset]));
      const dataListener = vi.fn();
      connector.on('data', dataListener);
      await connector.sync(makeSyncCtx());
      expect(dataListener.mock.calls[0][0].content.text).toContain('2026-06-01');
    });

    it('handles asset with no exifInfo', async () => {
      const asset = makeAsset({ exifInfo: undefined });
      vi.stubGlobal('fetch', mockFetchForSync([asset]));
      const dataListener = vi.fn();
      connector.on('data', dataListener);
      await connector.sync(makeSyncCtx());
      const text = dataListener.mock.calls[0][0].content.text;
      expect(text).toContain('Photo:');
      expect(text).not.toContain('Location:');
      expect(text).not.toContain('Camera:');
    });

    it('handles location without GPS coords', async () => {
      const asset = makeAsset({ exifInfo: { city: 'Tokyo', country: 'Japan' } });
      vi.stubGlobal('fetch', mockFetchForSync([asset]));
      const dataListener = vi.fn();
      connector.on('data', dataListener);
      await connector.sync(makeSyncCtx());
      const text = dataListener.mock.calls[0][0].content.text;
      expect(text).toContain('Location: Tokyo, Japan');
      expect(text).not.toContain('('); // no coords
    });

    it('handles tags with name fallback (no value)', async () => {
      const asset = makeAsset({
        tags: [
          { id: 't1', name: 'nature', value: '' },
          { id: 't2', name: 'outdoor', value: null },
        ],
      });
      vi.stubGlobal('fetch', mockFetchForSync([asset]));
      const dataListener = vi.fn();
      connector.on('data', dataListener);
      await connector.sync(makeSyncCtx());
      const text = dataListener.mock.calls[0][0].content.text;
      expect(text).toContain('Tags: nature, outdoor');
    });

    it('handles people with unnamed entries filtered', async () => {
      const asset = makeAsset({
        people: [
          { id: 'p1', name: 'Alice' },
          { id: 'p2', name: '' },
        ],
      });
      vi.stubGlobal('fetch', mockFetchForSync([asset]));
      const dataListener = vi.fn();
      connector.on('data', dataListener);
      await connector.sync(makeSyncCtx());
      const text = dataListener.mock.calls[0][0].content.text;
      expect(text).toContain('People: Alice');
      expect(dataListener.mock.calls[0][0].content.participants).toEqual(['Alice']);
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

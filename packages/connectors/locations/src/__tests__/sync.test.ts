import { describe, it, expect, vi, beforeEach } from 'vitest';
import { syncLocations } from '../sync.js';
import type { SyncContext, ConnectorDataEvent } from '@botmem/connector-sdk';

function createMockContext(overrides?: Partial<SyncContext>): SyncContext {
  return {
    cursor: null,
    signal: new AbortController().signal,
    auth: {
      raw: {
        host: 'http://localhost:8083',
        user: 'testuser',
        device: 'testdevice',
      },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    ...overrides,
  };
}

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('syncLocations', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('emits location events without geocoding', async () => {
    const now = Math.floor(Date.now() / 1000);

    // Mock getLocations (user/device are provided in auth, so no listUsers/listDevices)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            {
              tst: now,
              lat: 25.197,
              lon: 55.274,
              acc: 10,
              alt: 5,
              vel: 0,
              batt: 85,
              conn: 'w',
            },
          ],
        }),
    });

    const ctx = createMockContext();
    const events: ConnectorDataEvent[] = [];
    const emit = (e: ConnectorDataEvent) => events.push(e);
    const emitProgress = vi.fn();

    const result = await syncLocations(ctx, emit, emitProgress);

    expect(result.processed).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0].sourceType).toBe('location');
    expect(events[0].content?.metadata?.lat).toBe(25.197);
    expect(events[0].content?.metadata?.lon).toBe(55.274);
    // No address/addressLocal — geocoding removed from sync
    expect(events[0].content?.metadata?.address).toBeUndefined();
    expect(events[0].content?.metadata?.addressLocal).toBeUndefined();
  });

  it('produces text without address data', async () => {
    const now = Math.floor(Date.now() / 1000);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            {
              tst: now,
              lat: 40.7128,
              lon: -74.006,
              acc: 5,
            },
          ],
        }),
    });

    const ctx = createMockContext();
    const events: ConnectorDataEvent[] = [];
    await syncLocations(ctx, (e) => events.push(e), vi.fn());

    const text = events[0].content?.text || '';
    // Should have coordinates, no "At Some City" prefix from Nominatim
    expect(text).toContain('40.71280, -74.00600');
    expect(text).not.toContain('nominatim');
    expect(text).not.toContain('Nominatim');
  });

  it('does not make any external geocoding HTTP calls', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [{ tst: Math.floor(Date.now() / 1000), lat: 25.0, lon: 55.0, acc: 10 }],
        }),
    });

    const ctx = createMockContext();
    await syncLocations(ctx, vi.fn(), vi.fn());

    // Only 1 call: getLocations (user/device specified in auth) — no Nominatim calls
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const urls = mockFetch.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(urls.every((u: string) => !u.includes('nominatim'))).toBe(true);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { GeoService } from '../geo.service';
import type { DbService } from '../../db/db.service';

// Mock DbService with just the connectionPool getter
function createMockDb(
  queryFn?: (text: string, params?: unknown[]) => { rows: unknown[] },
): Pick<DbService, 'connectionPool'> {
  const defaultQuery = () => ({ rows: [] });
  const query = queryFn || defaultQuery;
  const client = { query, release: vi.fn() };
  return {
    connectionPool: { connect: vi.fn().mockResolvedValue(client) } as never,
  };
}

function createService(mockDb: Pick<DbService, 'connectionPool'>, ready = true): GeoService {
  const service = new GeoService(mockDb as DbService);
  // Skip init (would try to download files)
  Object.defineProperty(service, 'ready', { value: ready, writable: true });
  return service;
}

describe('GeoService', () => {
  describe('reverseGeocode', () => {
    it('returns city/state/country for known coordinates', async () => {
      const mockDb = createMockDb((text) => {
        if (text.includes('earth_box')) {
          return {
            rows: [{ name: 'Dubai', admin1_name: 'Dubai', country_code: 'AE' }],
          };
        }
        return { rows: [] };
      });

      const service = createService(mockDb);
      const result = await service.reverseGeocode(25.197, 55.274);
      expect(result.city).toBe('Dubai');
      expect(result.state).toBe('Dubai');
      expect(result.country).toBe('United Arab Emirates');
      expect(result.countryCode).toBe('AE');
    });

    it('returns empty result when no city within radius', async () => {
      const mockDb = createMockDb((text) => {
        if (text.includes('earth_box')) return { rows: [] };
        return { rows: [] };
      });

      const service = createService(mockDb);
      const result = await service.reverseGeocode(0, 0);
      expect(result.city).toBeNull();
      expect(result.state).toBeNull();
      expect(result.country).toBeNull();
    });

    it('returns empty result when service not ready', async () => {
      const mockDb = createMockDb();
      const service = createService(mockDb, false);

      const result = await service.reverseGeocode(25.197, 55.274);
      expect(result.city).toBeNull();
    });

    it('caches results for same truncated coordinates', async () => {
      let queryCount = 0;
      const mockDb = createMockDb((text) => {
        if (text.includes('earth_box')) {
          queryCount++;
          return { rows: [{ name: 'Tokyo', admin1_name: 'Tokyo', country_code: 'JP' }] };
        }
        return { rows: [] };
      });

      const service = createService(mockDb);

      // Same truncated coords (35.68, 139.69)
      await service.reverseGeocode(35.6812, 139.6917);
      await service.reverseGeocode(35.6845, 139.6923);

      expect(queryCount).toBe(1); // Second call should hit cache
    });

    it('resolves country code to full name', async () => {
      const mockDb = createMockDb((text) => {
        if (text.includes('earth_box')) {
          return {
            rows: [{ name: 'New York', admin1_name: 'New York', country_code: 'US' }],
          };
        }
        return { rows: [] };
      });

      const service = createService(mockDb);
      const result = await service.reverseGeocode(40.7128, -74.006);
      expect(result.country).toBe('United States of America');
      expect(result.countryCode).toBe('US');
    });
  });
});

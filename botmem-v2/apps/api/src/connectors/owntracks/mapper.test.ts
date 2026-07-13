import { describe, expect, it } from 'vitest';
import { mapOwnTracksLocation, type OwnTracksHashPort } from './index.js';

const hash: OwnTracksHashPort = {
  sha256Hex: async (value) => {
    const normalized = value.includes('48.856826') ? 'a' : 'b';
    return normalized.repeat(64);
  },
};

const point = {
  _type: 'location',
  topic: 'owntracks/jane/phone',
  tid: 'JJ',
  tst: 1_706_858_149,
  lat: 48.856826,
  lon: 2.292713,
  acc: 6,
  alt: 154,
  vel: 0,
  batt: 53,
  SSID: 'mywifi',
  addr: '11 Av de Suffren, Paris',
} as const;

describe('mapOwnTracksLocation', () => {
  it('map_validPoint_preservesProviderPayloadAndProducesStableIdentityAndRevision', async () => {
    const first = await mapOwnTracksLocation(point, hash);
    const second = await mapOwnTracksLocation({ ...point }, hash);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      sourceEventId: 'tst:1706858149',
      sourceRevision: `sha256:${'a'.repeat(64)}`,
      contentHash: 'a'.repeat(64),
      kind: 'location',
      occurredAt: '2024-02-02T07:15:49.000Z',
      payload: {
        schema: 'owntracks.location.v1',
        location: {
          latitude: 48.856826,
          longitude: 2.292713,
          accuracyMeters: 6,
          altitudeMeters: 154,
          velocityKilometersPerHour: 0,
        },
        provider: point,
      },
    });
  });

  it('map_sameProviderIdWithChangedContent_keepsEventIdentityAndChangesRevision', async () => {
    const original = await mapOwnTracksLocation({ ...point, _id: 'recorder-row-7' }, hash);
    const changed = await mapOwnTracksLocation(
      { ...point, _id: 'recorder-row-7', lat: 48.9 },
      hash,
    );

    expect(original?.sourceEventId).toBe('id:recorder-row-7');
    expect(changed?.sourceEventId).toBe('id:recorder-row-7');
    expect(changed?.sourceRevision).not.toBe(original?.sourceRevision);
  });

  it.each([
    null,
    {},
    { ...point, _type: 'transition' },
    { ...point, tst: -1 },
    { ...point, lat: 91 },
    { ...point, lon: 181 },
  ])('map_invalidOrNonLocationPoint_skipsItWithoutInventingData', async (invalid) => {
    await expect(mapOwnTracksLocation(invalid, hash)).resolves.toBeNull();
  });
});

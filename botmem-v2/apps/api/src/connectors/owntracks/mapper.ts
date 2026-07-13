import type { JsonValue, ProviderEventRevisionInput } from '@botmem-v2/connector-domain';
import type { OwnTracksHashPort } from './ports.js';

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key] ?? null)}`)
    .join(',')}}`;
}

function finiteNumber(value: JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function locationRecord(value: JsonValue): { readonly [key: string]: JsonValue } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as { readonly [key: string]: JsonValue };
  const latitude = finiteNumber(record.lat);
  const longitude = finiteNumber(record.lon);
  const timestamp = finiteNumber(record.tst);
  if (
    record._type !== 'location' ||
    latitude === null ||
    latitude < -90 ||
    latitude > 90 ||
    longitude === null ||
    longitude < -180 ||
    longitude > 180 ||
    timestamp === null ||
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0 ||
    timestamp > 8_640_000_000
  ) {
    return null;
  }
  return record;
}

export function ownTracksTimestamp(value: JsonValue): number | null {
  const record = locationRecord(value);
  return record ? (record.tst as number) : null;
}

export async function mapOwnTracksLocation(
  value: JsonValue,
  hash: OwnTracksHashPort,
): Promise<ProviderEventRevisionInput | null> {
  const record = locationRecord(value);
  if (!record) return null;
  const timestamp = record.tst as number;
  const latitude = record.lat as number;
  const longitude = record.lon as number;
  const normalizedLocation: Record<string, JsonValue> = {
    latitude,
    longitude,
  };
  const optionalFields: readonly (readonly [string, string])[] = [
    ['accuracyMeters', 'acc'],
    ['altitudeMeters', 'alt'],
    ['velocityKilometersPerHour', 'vel'],
    ['courseDegrees', 'cog'],
  ];
  for (const [target, source] of optionalFields) {
    const candidate = finiteNumber(record[source]);
    if (candidate !== null) normalizedLocation[target] = candidate;
  }
  const payload: JsonValue = {
    schema: 'owntracks.location.v1',
    location: normalizedLocation,
    provider: record,
  };
  const contentHash = await hash.sha256Hex(canonicalJson(payload));
  const providerId = record._id;
  const sourceEventId =
    (typeof providerId === 'string' && providerId.length > 0 && providerId.length <= 1024) ||
    (typeof providerId === 'number' && Number.isSafeInteger(providerId))
      ? `id:${String(providerId)}`
      : `tst:${timestamp}`;
  return Object.freeze({
    sourceEventId,
    sourceRevision: `sha256:${contentHash}`,
    kind: 'location',
    occurredAt: new Date(timestamp * 1000).toISOString(),
    contentHash,
    payload,
  });
}

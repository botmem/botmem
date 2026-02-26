import type { SyncContext, SyncResult, ConnectorDataEvent } from '@botmem/connector-sdk';
import { OwnTracksClient, reverseGeocode, NOMINATIM_DELAY } from './owntracks.js';
import type { CursorState, OwnTracksLocation } from './types.js';

type EmitFn = (event: ConnectorDataEvent) => void;

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function locationText(loc: OwnTracksLocation, address?: string | null): string {
  const dt = new Date(loc.tst * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const coords = `${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}`;
  const resolvedAddr = address || loc.addr;

  const parts: string[] = [];

  // Region label from OwnTracks waypoints (e.g. "Home", "Office")
  if (loc.inregions?.length) {
    parts.push(`At ${loc.inregions.join(', ')}`);
    if (resolvedAddr) parts.push(`(${resolvedAddr})`);
  } else if (resolvedAddr) {
    parts.push(`At ${resolvedAddr}`);
  }

  // Always include coordinates
  if (parts.length) {
    parts.push(`[${coords}]`);
  } else {
    parts.push(`Location (${coords})`);
  }

  parts.push(`on ${dt}`);

  // Motion activity
  if (loc.motionactivities?.length) {
    parts.push(`activity: ${loc.motionactivities.join(', ')}`);
  }

  if (loc.alt != null) parts.push(`altitude ${Math.round(loc.alt)}m`);
  if (loc.vel != null && loc.vel > 0) parts.push(`speed ${loc.vel} km/h`);
  if (loc.batt != null) parts.push(`battery ${loc.batt}%`);

  // Connection type
  if (loc.conn === 'w') parts.push('wifi');
  else if (loc.conn === 'm') parts.push('mobile');

  return parts.join(', ');
}

export async function syncLocations(
  ctx: SyncContext,
  emit: EmitFn,
  emitProgress: (p: { processed: number; total?: number }) => void,
): Promise<SyncResult> {
  const host = ctx.auth.raw?.host as string;
  const username = ctx.auth.raw?.username as string | undefined;
  const password = ctx.auth.raw?.password as string | undefined;
  const filterUser = ctx.auth.raw?.user as string | undefined;
  const filterDevice = ctx.auth.raw?.device as string | undefined;

  const client = new OwnTracksClient(host, username, password);

  // Parse cursor state
  let state: CursorState = ctx.cursor
    ? JSON.parse(ctx.cursor)
    : { pairs: {}, pairIndex: 0 };

  // Discover user/device pairs
  const users = filterUser ? [filterUser] : await client.listUsers(ctx.signal);
  const allPairs: Array<{ user: string; device: string }> = [];

  for (const user of users) {
    if (ctx.signal.aborted) break;
    const devices = filterDevice ? [filterDevice] : await client.listDevices(user, ctx.signal);
    for (const device of devices) {
      allPairs.push({ user, device });
    }
  }

  if (allPairs.length === 0) {
    ctx.logger.info('No user/device pairs found');
    return { cursor: null, hasMore: false, processed: 0 };
  }

  // Process one pair per sync call for manageable batches
  const idx = state.pairIndex;
  if (idx >= allPairs.length) {
    // All pairs done, reset for next full sync
    return { cursor: JSON.stringify({ ...state, pairIndex: 0 }), hasMore: false, processed: 0 };
  }

  const pair = allPairs[idx];
  const pairKey = `${pair.user}/${pair.device}`;

  ctx.logger.info(`Syncing locations for ${pairKey} (pair ${idx + 1}/${allPairs.length})`);

  // Determine date range: from last cursor date, or all history (default to epoch)
  const lastTst = state.pairs[pairKey];
  const from = lastTst ? formatDate(new Date((lastTst + 1) * 1000)) : '2000-01-01';
  const to = formatDate(new Date());

  const locations = await client.getLocations(pair.user, pair.device, from, to, ctx.signal);

  ctx.logger.info(`Fetched ${locations.length} location points for ${pairKey}`);

  // Batch reverse geocode unique geohashes to avoid duplicate lookups
  // Group locations by geohash (nearby points share the same address)
  const newLocations = locations.filter((loc) => !lastTst || loc.tst > lastTst);
  const geoCache = new Map<string, string | null>();

  // Pre-fetch addresses for unique geohashes (rate-limited)
  const uniqueGeos = new Map<string, { lat: number; lon: number }>();
  for (const loc of newLocations) {
    const key = loc.ghash || `${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}`;
    if (!loc.addr && !loc.inregions?.length && !uniqueGeos.has(key)) {
      uniqueGeos.set(key, { lat: loc.lat, lon: loc.lon });
    }
  }

  if (uniqueGeos.size > 0) {
    ctx.logger.info(`Reverse geocoding ${uniqueGeos.size} unique locations`);
    for (const [key, { lat, lon }] of uniqueGeos) {
      if (ctx.signal.aborted) break;
      const addr = await reverseGeocode(lat, lon);
      geoCache.set(key, addr);
      // Rate limit: Nominatim allows 1 req/sec
      if (uniqueGeos.size > 1) await new Promise((r) => setTimeout(r, NOMINATIM_DELAY));
    }
  }

  let processed = 0;
  let maxTst = lastTst ?? 0;

  for (const loc of newLocations) {
    if (ctx.signal.aborted) break;

    // Resolve address: OwnTracks addr > geocache > null
    const geoKey = loc.ghash || `${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}`;
    const address = loc.addr || geoCache.get(geoKey) || null;
    const text = locationText(loc, address);

    emit({
      sourceType: 'location',
      sourceId: `${pair.user}/${pair.device}/${loc.tst}`,
      timestamp: new Date(loc.tst * 1000).toISOString(),
      content: {
        text,
        metadata: {
          lat: loc.lat,
          lon: loc.lon,
          accuracy: loc.acc,
          altitude: loc.alt,
          velocity: loc.vel,
          course: loc.cog,
          battery: loc.batt,
          address,
          countryCode: loc.cc,
          geohash: loc.ghash,
          regions: loc.inregions,
          activity: loc.motionactivities,
          connection: loc.conn,
          user: pair.user,
          device: pair.device,
        },
      },
    });

    if (loc.tst > maxTst) maxTst = loc.tst;
    processed++;

    if (processed % 50 === 0) {
      emitProgress({ processed, total: newLocations.length });
    }
  }

  emitProgress({ processed });

  // Update cursor state
  if (maxTst > 0) state.pairs[pairKey] = maxTst;
  state.pairIndex = idx + 1;
  const hasMore = state.pairIndex < allPairs.length;

  return {
    cursor: JSON.stringify(state),
    hasMore,
    processed,
  };
}

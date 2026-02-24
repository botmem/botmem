import type { SyncContext, SyncResult, ConnectorDataEvent } from '@botmem/connector-sdk';
import { OwnTracksClient } from './owntracks.js';
import type { CursorState, OwnTracksLocation } from './types.js';

type EmitFn = (event: ConnectorDataEvent) => void;

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function locationText(loc: OwnTracksLocation): string {
  const dt = new Date(loc.tst * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const coords = `${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}`;

  const parts: string[] = [];
  if (loc.addr) {
    parts.push(`At ${loc.addr} (${coords})`);
  } else {
    parts.push(`Location (${coords})`);
  }

  parts.push(`on ${dt}`);

  if (loc.alt != null) parts.push(`altitude ${Math.round(loc.alt)}m`);
  if (loc.vel != null && loc.vel > 0) parts.push(`speed ${loc.vel} km/h`);
  if (loc.batt != null) parts.push(`battery ${loc.batt}%`);

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

  // Determine date range: from last cursor date, or all history
  const lastTst = state.pairs[pairKey];
  const from = lastTst ? formatDate(new Date((lastTst + 1) * 1000)) : undefined;
  // OwnTracks returns 416 if `to` is set without `from`, so only pass `to` when we have a `from`
  const to = from ? formatDate(new Date()) : undefined;

  const locations = await client.getLocations(pair.user, pair.device, from, to, ctx.signal);

  ctx.logger.info(`Fetched ${locations.length} location points for ${pairKey}`);

  let processed = 0;
  let maxTst = lastTst ?? 0;

  for (const loc of locations) {
    if (ctx.signal.aborted) break;

    // Skip already-seen timestamps
    if (lastTst && loc.tst <= lastTst) continue;

    const text = locationText(loc);

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
          address: loc.addr,
          countryCode: loc.cc,
          geohash: loc.ghash,
          user: pair.user,
          device: pair.device,
        },
      },
    });

    if (loc.tst > maxTst) maxTst = loc.tst;
    processed++;

    if (processed % 50 === 0) {
      emitProgress({ processed, total: locations.length });
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

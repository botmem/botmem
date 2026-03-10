import type { OwnTracksLocation } from './types.js';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';
export const NOMINATIM_DELAY = 1100; // Nominatim rate limit: 1 req/sec

export interface GeoAddress {
  en: string | null;
  local: string | null;
}

interface NominatimResponse {
  address?: Record<string, string>;
  display_name?: string;
}

function buildAddress(data: NominatimResponse): string | null {
  if (!data.address) return null;
  const a = data.address;
  const parts: string[] = [];
  const road = a.road || a.pedestrian || a.neighbourhood || a.residential;
  if (road) parts.push(road);
  const area = a.suburb || a.city_district || a.town || a.city || a.village;
  if (area && area !== road) parts.push(area);
  const region = a.state || a.county;
  if (region) parts.push(region);
  const country = a.country;
  if (country) parts.push(country);
  return parts.length ? parts.join(', ') : data.display_name || null;
}

/** Reverse geocode via Nominatim (OSM). Returns addresses in English and local language. */
export async function reverseGeocode(lat: number, lon: number): Promise<GeoAddress> {
  const base = `${NOMINATIM_URL}?lat=${lat}&lon=${lon}&format=json&zoom=18&addressdetails=1`;
  const headers = { 'User-Agent': 'botmem/1.0', Accept: 'application/json' };
  const result: GeoAddress = { en: null, local: null };

  try {
    // First call: English
    const enRes = await fetch(`${base}&accept-language=en`, { headers });
    if (enRes.ok) {
      const enData = await enRes.json();
      result.en = buildAddress(enData);
    }

    // Rate limit between calls
    await new Promise((r) => setTimeout(r, NOMINATIM_DELAY));

    // Second call: local/native language (no accept-language = server default = local)
    const localRes = await fetch(base, { headers });
    if (localRes.ok) {
      const localData = await localRes.json();
      result.local = buildAddress(localData);
    }

    // If both are identical, drop the duplicate
    if (result.en && result.local && result.en === result.local) {
      result.local = null;
    }
  } catch {
    // Best-effort
  }

  return result;
}

export class OwnTracksClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(host: string, username?: string, password?: string) {
    this.baseUrl = host.replace(/\/+$/, '');
    this.headers = { Accept: 'application/json' };

    if (username && password) {
      const encoded = Buffer.from(`${username}:${password}`).toString('base64');
      this.headers['Authorization'] = `Basic ${encoded}`;
    }
  }

  async getVersion(signal?: AbortSignal): Promise<{ version: string }> {
    const res = await fetch(`${this.baseUrl}/api/0/version`, {
      headers: this.headers,
      signal,
    });
    if (!res.ok) throw new Error(`OwnTracks version check failed: ${res.status}`);
    return res.json();
  }

  async listUsers(signal?: AbortSignal): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/api/0/list`, {
      headers: this.headers,
      signal,
    });
    if (!res.ok) throw new Error(`OwnTracks list users failed: ${res.status}`);
    const data = await res.json();
    return data.results ?? data;
  }

  async listDevices(user: string, signal?: AbortSignal): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/api/0/list?user=${encodeURIComponent(user)}`, {
      headers: this.headers,
      signal,
    });
    if (!res.ok) throw new Error(`OwnTracks list devices failed: ${res.status}`);
    const data = await res.json();
    return data.results ?? data;
  }

  async getLocations(
    user: string,
    device: string,
    from?: string,
    to?: string,
    signal?: AbortSignal,
  ): Promise<OwnTracksLocation[]> {
    const params = new URLSearchParams({
      user,
      device,
      format: 'json',
    });
    if (from) params.set('from', from);
    if (to) params.set('to', to);

    const res = await fetch(`${this.baseUrl}/api/0/locations?${params}`, {
      headers: this.headers,
      signal,
    });
    if (!res.ok) throw new Error(`OwnTracks locations failed: ${res.status}`);
    const data = await res.json();
    return data.data ?? data;
  }
}

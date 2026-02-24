import type { OwnTracksLocation } from './types.js';

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

import { BaseConnector } from '@botmem/connector-sdk';
import type { ConnectorManifest, AuthContext, AuthInitResult, SyncContext, SyncResult } from '@botmem/connector-sdk';

interface ImmichAsset {
  id: string;
  type: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'OTHER';
  originalFileName: string;
  originalMimeType?: string;
  fileCreatedAt: string;
  fileModifiedAt: string;
  localDateTime: string;
  createdAt: string;
  isFavorite: boolean;
  isArchived: boolean;
  isTrashed: boolean;
  exifInfo?: {
    city?: string;
    state?: string;
    country?: string;
    description?: string;
    dateTimeOriginal?: string;
    exifImageWidth?: number;
    exifImageHeight?: number;
    latitude?: number;
    longitude?: number;
    make?: string;
    model?: string;
    lensModel?: string;
    focalLength?: number;
    fNumber?: number;
    exposureTime?: string;
    iso?: number;
    rating?: number;
    timeZone?: string;
  };
  people?: Array<{ id: string; name: string; birthDate?: string }>;
  tags?: Array<{ id: string; name: string; value?: string }>;
}

interface CursorState {
  takenAfter?: string;
  page: number;
}

export class ImmichConnector extends BaseConnector {
  readonly manifest: ConnectorManifest = {
    id: 'photos',
    name: 'Photos (Immich)',
    description: 'Import photo metadata from Immich',
    color: '#FFE66D',
    icon: 'camera',
    authType: 'api-key',
    configSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', title: 'Immich Server URL', description: 'e.g. http://localhost:2283' },
        apiKey: { type: 'string', title: 'API Key', description: 'Immich API key from Account Settings' },
      },
      required: ['host', 'apiKey'],
    },
  };

  async initiateAuth(config: Record<string, unknown>): Promise<AuthInitResult> {
    const host = (config.host as string).replace(/\/+$/, '');
    const apiKey = config.apiKey as string;

    const res = await fetch(`${host}/api/server/ping`, {
      headers: { 'x-api-key': apiKey },
    });

    if (!res.ok) throw new Error('Failed to connect to Immich server');

    return {
      type: 'complete',
      auth: { accessToken: apiKey, raw: { host } },
    };
  }

  async completeAuth(params: Record<string, unknown>): Promise<AuthContext> {
    const host = (params.host as string).replace(/\/+$/, '');
    return { accessToken: params.apiKey as string, raw: { host } };
  }

  async validateAuth(auth: AuthContext): Promise<boolean> {
    const host = auth.raw?.host as string;
    try {
      const res = await fetch(`${host}/api/server/ping`, {
        headers: { 'x-api-key': auth.accessToken! },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async revokeAuth(): Promise<void> {
    // API keys can't be revoked remotely
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const host = ctx.auth.raw?.host as string;
    const apiKey = ctx.auth.accessToken!;
    const pageSize = 100;
    let processed = 0;

    // Parse cursor
    const cursor: CursorState = ctx.cursor
      ? JSON.parse(ctx.cursor)
      : { page: 1 };

    ctx.logger.info(
      `Starting Immich sync (page ${cursor.page}${cursor.takenAfter ? `, after ${cursor.takenAfter}` : ', full sync'})`,
    );

    // Report total for progress tracking
    try {
      const statsRes = await fetch(`${host}/api/assets/statistics`, {
        headers: { 'x-api-key': apiKey },
        signal: ctx.signal,
      });
      if (statsRes.ok) {
        const stats = await statsRes.json();
        this.emitProgress({ processed: 0, total: stats.images ?? stats.total ?? 0 });
      }
    } catch {
      // Non-fatal — progress reporting is best-effort
    }

    // Build search body
    const searchBody: Record<string, unknown> = {
      page: cursor.page,
      size: pageSize,
      order: 'asc',
      type: 'IMAGE',
      withExif: true,
      withPeople: true,
    };
    if (cursor.takenAfter) {
      searchBody.takenAfter = cursor.takenAfter;
    }

    const res = await fetch(`${host}/api/search/metadata`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(searchBody),
      signal: ctx.signal,
    });

    if (!res.ok) throw new Error(`Immich API error: ${res.status}`);

    const searchResponse = await res.json();
    const assets: ImmichAsset[] = searchResponse.assets?.items ?? [];
    const nextPage: string | null = searchResponse.assets?.nextPage ?? null;

    let lastTimestamp: string | null = null;

    for (const asset of assets) {
      if (ctx.signal.aborted) break;

      const text = this.composeText(asset);
      const timestamp = asset.fileCreatedAt || asset.localDateTime || asset.createdAt;

      this.emitData({
        sourceType: 'photo',
        sourceId: asset.id,
        timestamp,
        content: {
          text,
          participants: (asset.people ?? [])
            .filter((p) => p.name)
            .map((p) => p.name),
          attachments: [{
            uri: `${host}/api/assets/${asset.id}/thumbnail?size=preview`,
            mimeType: asset.originalMimeType ?? 'image/jpeg',
          }],
          metadata: {
            originalFileName: asset.originalFileName,
            isFavorite: asset.isFavorite,
            // EXIF
            width: asset.exifInfo?.exifImageWidth,
            height: asset.exifInfo?.exifImageHeight,
            latitude: asset.exifInfo?.latitude,
            longitude: asset.exifInfo?.longitude,
            city: asset.exifInfo?.city,
            state: asset.exifInfo?.state,
            country: asset.exifInfo?.country,
            description: asset.exifInfo?.description,
            cameraMake: asset.exifInfo?.make,
            cameraModel: asset.exifInfo?.model,
            lensModel: asset.exifInfo?.lensModel,
            focalLength: asset.exifInfo?.focalLength,
            fNumber: asset.exifInfo?.fNumber,
            exposureTime: asset.exifInfo?.exposureTime,
            iso: asset.exifInfo?.iso,
            rating: asset.exifInfo?.rating,
            timeZone: asset.exifInfo?.timeZone,
            // People (with Immich IDs for contact resolution)
            people: (asset.people ?? []).map((p) => ({
              id: p.id,
              name: p.name,
              birthDate: p.birthDate,
            })),
            // Tags
            tags: (asset.tags ?? []).map((t) => t.value || t.name).filter(Boolean),
          },
        },
      });

      processed++;
      lastTimestamp = timestamp;
    }

    this.emitProgress({ processed });
    ctx.logger.info(`Synced ${processed} assets (page ${cursor.page})`);

    // Determine next cursor and hasMore
    const hasMore = nextPage != null;
    let nextCursor: string | null;

    if (hasMore) {
      // More pages in current sweep — advance page
      nextCursor = JSON.stringify({
        takenAfter: cursor.takenAfter,
        page: cursor.page + 1,
      } satisfies CursorState);
    } else if (lastTimestamp) {
      // Sweep complete — store final timestamp for next incremental sync
      nextCursor = JSON.stringify({
        takenAfter: lastTimestamp,
        page: 1,
      } satisfies CursorState);
    } else {
      nextCursor = ctx.cursor;
    }

    return {
      cursor: nextCursor,
      hasMore,
      processed,
    };
  }

  private composeText(asset: ImmichAsset): string {
    const parts: string[] = [];

    parts.push(`Photo: ${asset.originalFileName}`);

    // Date
    const date = asset.fileCreatedAt || asset.localDateTime;
    if (date) {
      parts.push(`Date: ${new Date(date).toISOString().replace('T', ' ').slice(0, 16)}`);
    }

    // Location
    const exif = asset.exifInfo;
    if (exif) {
      const locationParts = [exif.city, exif.state, exif.country].filter(Boolean);
      if (locationParts.length) {
        let loc = `Location: ${locationParts.join(', ')}`;
        if (exif.latitude != null && exif.longitude != null) {
          loc += ` (${exif.latitude.toFixed(4)}, ${exif.longitude.toFixed(4)})`;
        }
        parts.push(loc);
      }

      // Camera info
      const cameraParts: string[] = [];
      if (exif.make && exif.model) cameraParts.push(`${exif.make} ${exif.model}`);
      else if (exif.model) cameraParts.push(exif.model);
      if (exif.lensModel) cameraParts.push(exif.lensModel);
      if (exif.focalLength) cameraParts.push(`${exif.focalLength}mm`);
      if (exif.fNumber) cameraParts.push(`f/${exif.fNumber}`);
      if (exif.exposureTime) cameraParts.push(`${exif.exposureTime}s`);
      if (exif.iso) cameraParts.push(`ISO${exif.iso}`);
      if (cameraParts.length) {
        parts.push(`Camera: ${cameraParts.join(', ')}`);
      }

      // Description
      if (exif.description) {
        parts.push(`Description: ${exif.description}`);
      }
    }

    // People
    const people = (asset.people ?? []).filter((p) => p.name).map((p) => p.name);
    if (people.length) {
      parts.push(`People: ${people.join(', ')}`);
    }

    // Tags
    const tags = (asset.tags ?? []).map((t) => t.value || t.name).filter(Boolean);
    if (tags.length) {
      parts.push(`Tags: ${tags.join(', ')}`);
    }

    return parts.join('\n');
  }
}

export default () => new ImmichConnector();

import type {
  ConnectorAccountSnapshot,
  HostedIngestionUseCase,
  JsonValue,
  ProviderEventRevisionInput,
} from '@botmem-v2/connector-domain';
import {
  OwnTracksConnectorError,
  OwnTracksInvalidCursorError,
  OwnTracksPageLimitError,
  OwnTracksProviderError,
} from './errors.js';
import { mapOwnTracksLocation, ownTracksTimestamp } from './mapper.js';
import type {
  OwnTracksClockPort,
  OwnTracksCredentialVaultPort,
  OwnTracksHashPort,
  OwnTracksLocationApiPort,
  ValidatedOwnTracksEndpoint,
} from './ports.js';

const INITIAL_WINDOW_SECONDS = 30 * 24 * 60 * 60;
const MIN_WINDOW_SECONDS = 60 * 60;
const RECONCILIATION_SECONDS = 24 * 60 * 60;
const MAX_PROVIDER_PAGES = 10_000;

export type OwnTracksCursor =
  | {
      readonly connector: 'owntracks';
      readonly version: 1;
      readonly mode: 'steady';
      readonly scannedThrough: number;
      readonly highWaterTst: number | null;
      readonly windowSeconds: number;
    }
  | {
      readonly connector: 'owntracks';
      readonly version: 1;
      readonly mode: 'window';
      readonly nextFrom: number;
      readonly targetTo: number;
      readonly highWaterTst: number | null;
      readonly windowSeconds: number;
    };

function integer(value: JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function nullableInteger(value: JsonValue | undefined): number | null | undefined {
  return value === null ? null : (integer(value) ?? undefined);
}

export function parseOwnTracksCursor(value: JsonValue): OwnTracksCursor | null {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  ) {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OwnTracksInvalidCursorError();
  }
  const record = value as { readonly [key: string]: JsonValue };
  if (record.connector !== 'owntracks' || record.version !== 1) {
    throw new OwnTracksInvalidCursorError();
  }
  const highWaterTst = nullableInteger(record.highWaterTst);
  const windowSeconds = integer(record.windowSeconds);
  if (
    highWaterTst === undefined ||
    windowSeconds === null ||
    windowSeconds < MIN_WINDOW_SECONDS ||
    windowSeconds > INITIAL_WINDOW_SECONDS
  ) {
    throw new OwnTracksInvalidCursorError();
  }
  if (record.mode === 'steady') {
    const scannedThrough = integer(record.scannedThrough);
    if (scannedThrough === null) throw new OwnTracksInvalidCursorError();
    return Object.freeze({
      connector: 'owntracks',
      version: 1,
      mode: 'steady',
      scannedThrough,
      highWaterTst,
      windowSeconds,
    });
  }
  if (record.mode === 'window') {
    const nextFrom = integer(record.nextFrom);
    const targetTo = integer(record.targetTo);
    if (nextFrom === null || targetTo === null || nextFrom > targetTo + 1) {
      throw new OwnTracksInvalidCursorError();
    }
    return Object.freeze({
      connector: 'owntracks',
      version: 1,
      mode: 'window',
      nextFrom,
      targetTo,
      highWaterTst,
      windowSeconds,
    });
  }
  throw new OwnTracksInvalidCursorError();
}

function epochSeconds(timestamp: string): number {
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) throw new OwnTracksInvalidCursorError();
  return Math.floor(milliseconds / 1000);
}

function openWindow(
  cursor: OwnTracksCursor | null,
  targetTo: number,
): Extract<OwnTracksCursor, { mode: 'window' }> {
  if (cursor?.mode === 'window') return cursor;
  if (!cursor) {
    return Object.freeze({
      connector: 'owntracks',
      version: 1,
      mode: 'window',
      nextFrom: Math.max(0, targetTo - INITIAL_WINDOW_SECONDS + 1),
      targetTo,
      highWaterTst: null,
      windowSeconds: INITIAL_WINDOW_SECONDS,
    });
  }
  return Object.freeze({
    connector: 'owntracks',
    version: 1,
    mode: 'window',
    nextFrom: Math.max(0, cursor.scannedThrough - RECONCILIATION_SECONDS),
    targetTo: Math.max(targetTo, cursor.scannedThrough),
    highWaterTst: cursor.highWaterTst,
    windowSeconds: cursor.windowSeconds,
  });
}

export class OwnTracksSyncService {
  public constructor(
    private readonly ingestion: HostedIngestionUseCase,
    private readonly locations: OwnTracksLocationApiPort,
    private readonly vault: OwnTracksCredentialVaultPort,
    private readonly hash: OwnTracksHashPort,
    private readonly clock: OwnTracksClockPort,
  ) {}

  public async run(input: {
    readonly tenantId: Parameters<HostedIngestionUseCase['startSync']>[0]['tenantId'];
    readonly accountId: Parameters<HostedIngestionUseCase['startSync']>[0]['accountId'];
    readonly syncId: Parameters<HostedIngestionUseCase['startSync']>[0]['syncId'];
    readonly endpoint: ValidatedOwnTracksEndpoint;
    readonly startedAt: string;
    readonly leaseExpiresAt: string;
    readonly signal?: AbortSignal;
  }): Promise<ConnectorAccountSnapshot> {
    let account = await this.ingestion.startSync({
      tenantId: input.tenantId,
      accountId: input.accountId,
      syncId: input.syncId,
      startedAt: input.startedAt,
      leaseExpiresAt: input.leaseExpiresAt,
    });
    try {
      const credentials = await this.vault.read(
        { tenantId: input.tenantId, accountId: input.accountId },
        account.credentialRef,
      );
      let cursor = openWindow(parseOwnTracksCursor(account.cursor), epochSeconds(this.clock.now()));
      for (let page = 0; ; page += 1) {
        if (page >= MAX_PROVIDER_PAGES) throw new OwnTracksPageLimitError();
        const pageTo = Math.min(cursor.targetTo, cursor.nextFrom + cursor.windowSeconds - 1);
        let providerPage;
        try {
          providerPage = await this.locations.listLocations(
            input.endpoint,
            credentials,
            { fromEpochSeconds: cursor.nextFrom, toEpochSeconds: pageTo },
            input.signal,
          );
        } catch (error) {
          if (
            error instanceof OwnTracksProviderError &&
            error.failure === 'response_too_large' &&
            cursor.windowSeconds > MIN_WINDOW_SECONDS
          ) {
            cursor = Object.freeze({
              ...cursor,
              windowSeconds: Math.max(MIN_WINDOW_SECONDS, Math.floor(cursor.windowSeconds / 2)),
            });
            continue;
          }
          throw error;
        }
        const mapped = await Promise.all(
          providerPage.points.map((point) => mapOwnTracksLocation(point, this.hash)),
        );
        const events = mapped.filter(
          (event): event is ProviderEventRevisionInput => event !== null,
        );
        const observedHighWater = providerPage.points.reduce<number | null>((highest, point) => {
          const timestamp = ownTracksTimestamp(point);
          return timestamp === null || (highest !== null && timestamp <= highest)
            ? highest
            : timestamp;
        }, cursor.highWaterTst);
        const nextFrom = pageTo + 1;
        const nextCursor: OwnTracksCursor =
          nextFrom > cursor.targetTo
            ? Object.freeze({
                connector: 'owntracks',
                version: 1,
                mode: 'steady',
                scannedThrough: cursor.targetTo,
                highWaterTst: observedHighWater,
                windowSeconds: cursor.windowSeconds,
              })
            : Object.freeze({
                ...cursor,
                nextFrom,
                highWaterTst: observedHighWater,
              });
        const committed = await this.ingestion.commitPage({
          tenantId: input.tenantId,
          accountId: input.accountId,
          syncId: input.syncId,
          expectedCursorVersion: account.cursorVersion,
          nextCursor,
          events,
          observedAt: this.clock.now(),
        });
        account = committed.account;
        if (nextCursor.mode === 'steady') {
          return await this.ingestion.closeSync({
            tenantId: input.tenantId,
            accountId: input.accountId,
            syncId: input.syncId,
            outcome: 'completed',
            closedAt: this.clock.now(),
          });
        }
        cursor = nextCursor;
      }
    } catch (error) {
      const mapped = this.mapFailure(error);
      await this.ingestion
        .closeSync({
          tenantId: input.tenantId,
          accountId: input.accountId,
          syncId: input.syncId,
          outcome: 'failed',
          reasonCode: mapped.code,
          closedAt: this.clock.now(),
        })
        .catch(() => undefined);
      throw mapped;
    }
  }

  private mapFailure(error: unknown): OwnTracksConnectorError {
    if (error instanceof OwnTracksConnectorError) return error;
    if (error instanceof OwnTracksProviderError) {
      if (error.failure === 'auth_failed') {
        return new OwnTracksConnectorError(
          'OWNTRACKS_AUTH_FAILED',
          'OwnTracks credentials were rejected and must be updated',
          false,
        );
      }
      if (error.failure === 'response_too_large') {
        return new OwnTracksConnectorError(
          'OWNTRACKS_RESPONSE_TOO_LARGE',
          'OwnTracks returned too much data for the minimum safe time window',
          false,
        );
      }
      if (error.failure === 'invalid_response') {
        return new OwnTracksConnectorError(
          'OWNTRACKS_INVALID_RESPONSE',
          'OwnTracks returned an invalid bounded response; no partial page was committed',
          false,
        );
      }
      return new OwnTracksConnectorError(
        'OWNTRACKS_PROVIDER_UNAVAILABLE',
        'OwnTracks provider request failed without committing a partial page',
        error.retryable,
      );
    }
    return new OwnTracksConnectorError(
      'OWNTRACKS_SYNC_FAILED',
      'OwnTracks sync failed without committing an incomplete provider page',
      false,
    );
  }
}

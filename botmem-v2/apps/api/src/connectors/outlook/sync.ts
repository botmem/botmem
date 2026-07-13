import type {
  ConnectorAccountSnapshot,
  HostedIngestionUseCase,
  JsonValue,
} from '@botmem-v2/connector-domain';
import {
  OutlookConnectorError,
  OutlookFullResyncRequiredError,
  OutlookInvalidCursorError,
  OutlookPageLimitError,
  OutlookProviderError,
  OutlookReconnectRequiredError,
} from './errors.js';
import { mapOutlookMessage } from './mapper.js';
import type {
  OutlookAuthorizationSession,
  OutlookClockPort,
  OutlookCredentialVaultPort,
  OutlookCryptoPort,
  OutlookGraphApiPort,
  OutlookOAuthTokenSet,
} from './ports.js';

const MAX_PAGES_PER_SYNC = 10_000;
const LIST_POLICY = Object.freeze({ timeoutMs: 20_000, maxResponseBytes: 16 * 1024 * 1024 });

export type OutlookFolderCursor = {
  readonly folderId: string;
  readonly kind: 'next' | 'delta';
  readonly link: string;
};

export type OutlookCursor = {
  readonly connector: 'outlook';
  readonly version: 1;
  readonly folders: readonly OutlookFolderCursor[];
};

export const OUTLOOK_INITIAL_CURSOR: OutlookCursor = Object.freeze({
  connector: 'outlook',
  version: 1,
  folders: Object.freeze([]),
});

export function parseOutlookCursor(value: JsonValue): OutlookCursor {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  ) {
    return OUTLOOK_INITIAL_CURSOR;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OutlookInvalidCursorError();
  }
  const cursor = value as { readonly [key: string]: JsonValue };
  if (
    cursor.connector !== 'outlook' ||
    cursor.version !== 1 ||
    !Array.isArray(cursor.folders) ||
    cursor.folders.length > 10_000
  ) {
    throw new OutlookInvalidCursorError();
  }
  const seenFolderIds = new Set<string>();
  const folders: OutlookFolderCursor[] = [];
  for (const value of cursor.folders) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new OutlookInvalidCursorError();
    }
    const folder = value as { readonly [key: string]: JsonValue };
    if (
      typeof folder.folderId !== 'string' ||
      folder.folderId.length === 0 ||
      folder.folderId.length > 2048 ||
      (folder.kind !== 'next' && folder.kind !== 'delta') ||
      typeof folder.link !== 'string' ||
      folder.link.length === 0 ||
      folder.link.length > 32_768 ||
      seenFolderIds.has(folder.folderId)
    ) {
      throw new OutlookInvalidCursorError();
    }
    seenFolderIds.add(folder.folderId);
    folders.push(
      Object.freeze({
        folderId: folder.folderId,
        kind: folder.kind,
        link: folder.link,
      }),
    );
  }
  return Object.freeze({
    connector: 'outlook',
    version: 1,
    folders: Object.freeze(
      folders.sort((left, right) => left.folderId.localeCompare(right.folderId)),
    ),
  });
}

function cursorFrom(folders: ReadonlyMap<string, OutlookFolderCursor>): OutlookCursor {
  return Object.freeze({
    connector: 'outlook',
    version: 1,
    folders: Object.freeze(
      [...folders.values()].sort((left, right) => left.folderId.localeCompare(right.folderId)),
    ),
  });
}

export class OutlookSyncService {
  public constructor(
    private readonly ingestion: HostedIngestionUseCase,
    private readonly graph: OutlookGraphApiPort,
    private readonly vault: OutlookCredentialVaultPort,
    private readonly crypto: Pick<OutlookCryptoPort, 'sha256Hex'>,
    private readonly clock: OutlookClockPort,
  ) {}

  public async run(input: {
    readonly tenantId: Parameters<HostedIngestionUseCase['startSync']>[0]['tenantId'];
    readonly accountId: Parameters<HostedIngestionUseCase['startSync']>[0]['accountId'];
    readonly syncId: Parameters<HostedIngestionUseCase['startSync']>[0]['syncId'];
    readonly credentialRef: string;
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
      const credentialOwner = { tenantId: input.tenantId, accountId: input.accountId };
      let tokens = await this.vault.read(credentialOwner, input.credentialRef);
      const authorization: OutlookAuthorizationSession = {
        getTokens: () => tokens,
        onTokenRotation: async (rotated) => {
          await this.vault.rotate(credentialOwner, input.credentialRef, rotated);
          tokens = rotated;
        },
      };
      const cursor = parseOutlookCursor(account.cursor);
      const discovered = await this.graph.discoverMailFolders(authorization, {
        ...LIST_POLICY,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const discoveredIds = [...new Set(discovered.map((folder) => folder.id))].sort();
      const prior = new Map(cursor.folders.map((folder) => [folder.folderId, folder]));
      const folderCursors = new Map<string, OutlookFolderCursor>();
      for (const folderId of discoveredIds) {
        const existing = prior.get(folderId);
        if (existing) folderCursors.set(folderId, existing);
      }

      let pageNumber = 0;
      for (const folderId of discoveredIds) {
        let link = folderCursors.get(folderId)?.link ?? null;
        const seenLinks = new Set<string>();
        for (;;) {
          if (pageNumber >= MAX_PAGES_PER_SYNC) throw new OutlookPageLimitError();
          pageNumber += 1;
          const cursorKey = link ?? '__initial__';
          if (seenLinks.has(cursorKey)) throw new OutlookPageLimitError();
          seenLinks.add(cursorKey);

          const page = await this.graph.listMessageDelta(authorization, folderId, link, {
            ...LIST_POLICY,
            ...(input.signal ? { signal: input.signal } : {}),
          });
          const hasMore = page.nextLink !== null;
          const nextLink = page.nextLink ?? page.deltaLink;
          if (!nextLink || (page.nextLink !== null && page.deltaLink !== null)) {
            throw new OutlookProviderError('invalid_response');
          }
          if (hasMore && seenLinks.has(nextLink)) throw new OutlookPageLimitError();
          folderCursors.set(
            folderId,
            Object.freeze({
              folderId,
              kind: hasMore ? 'next' : 'delta',
              link: nextLink,
            }),
          );
          const nextCursor = cursorFrom(folderCursors);
          // The whole provider page is mapped before the single atomic ingest call.
          const events = await Promise.all(
            page.messages.map((message) => mapOutlookMessage(message, this.crypto)),
          );
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
          if (!hasMore) break;
          link = nextLink;
        }
      }
      if (discoveredIds.length === 0) {
        const committed = await this.ingestion.commitPage({
          tenantId: input.tenantId,
          accountId: input.accountId,
          syncId: input.syncId,
          expectedCursorVersion: account.cursorVersion,
          nextCursor: cursorFrom(folderCursors),
          events: [],
          observedAt: this.clock.now(),
        });
        account = committed.account;
      }
      return await this.ingestion.closeSync({
        tenantId: input.tenantId,
        accountId: input.accountId,
        syncId: input.syncId,
        outcome: 'completed',
        closedAt: this.clock.now(),
      });
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

  private mapFailure(error: unknown): OutlookConnectorError {
    if (error instanceof OutlookConnectorError) return error;
    if (error instanceof OutlookProviderError) {
      if (error.failure === 'invalid_delta') return new OutlookFullResyncRequiredError();
      if (error.failure === 'revoked') return new OutlookReconnectRequiredError();
      return new OutlookConnectorError(
        'OUTLOOK_PROVIDER_UNAVAILABLE',
        'Outlook provider request failed without committing a partial page',
        error.failure === 'rate_limited' || error.failure === 'unavailable',
      );
    }
    return new OutlookConnectorError(
      'OUTLOOK_SYNC_FAILED',
      'Outlook sync failed without committing an incomplete provider page',
      false,
    );
  }
}

export function createOutlookAuthorizationSession(
  initialTokens: OutlookOAuthTokenSet,
  onRotation: (tokens: OutlookOAuthTokenSet) => Promise<void>,
): OutlookAuthorizationSession {
  let tokens = initialTokens;
  return {
    getTokens: () => tokens,
    onTokenRotation: async (rotated) => {
      await onRotation(rotated);
      tokens = rotated;
    },
  };
}

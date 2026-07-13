import type {
  ConnectorAccountSnapshot,
  HostedIngestionUseCase,
  JsonValue,
  ProviderEventRevisionInput,
} from '@botmem-v2/connector-domain';
import {
  GmailConnectorError,
  GmailFullResyncRequiredError,
  GmailInvalidCursorError,
  GmailPageLimitError,
  GmailProviderError,
  GmailReconnectRequiredError,
} from './errors.js';
import { mapGmailMessage, mapGmailTombstone } from './mapper.js';
import type {
  GmailApiPort,
  GmailAuthorizationSession,
  GmailClockPort,
  GmailCredentialVaultPort,
  GmailCryptoPort,
  GmailHistoryRecord,
  OAuthTokenSet,
} from './ports.js';

const PAGE_SIZE = 100;
const MAX_PAGES_PER_SYNC = 10_000;
const MESSAGE_CONCURRENCY = 8;
const LIST_POLICY = Object.freeze({ timeoutMs: 15_000, maxResponseBytes: 2 * 1024 * 1024 });
const MESSAGE_POLICY = Object.freeze({ timeoutMs: 20_000, maxResponseBytes: 16 * 1024 * 1024 });
const PROFILE_POLICY = Object.freeze({ timeoutMs: 15_000, maxResponseBytes: 64 * 1024 });

export type GmailCursor =
  | {
      readonly connector: 'gmail';
      readonly version: 1;
      readonly mode: 'full';
      readonly pageToken: string | null;
      readonly anchorHistoryId: string | null;
    }
  | {
      readonly connector: 'gmail';
      readonly version: 1;
      readonly mode: 'history';
      readonly historyId: string;
      readonly pageToken: string | null;
      readonly targetHistoryId: string | null;
    };

const INITIAL_CURSOR: GmailCursor = Object.freeze({
  connector: 'gmail',
  version: 1,
  mode: 'full',
  pageToken: null,
  anchorHistoryId: null,
});

function optionalString(value: unknown): string | null | undefined {
  return value === null ? null : typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function parseGmailCursor(value: JsonValue): GmailCursor {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  ) {
    return INITIAL_CURSOR;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GmailInvalidCursorError();
  }
  const object = value as { readonly [key: string]: JsonValue };
  if (object.connector !== 'gmail' || object.version !== 1) {
    throw new GmailInvalidCursorError();
  }
  const pageToken = optionalString(object.pageToken);
  if (pageToken === undefined) {
    throw new GmailInvalidCursorError();
  }
  if (object.mode === 'full') {
    const anchorHistoryId = optionalString(object.anchorHistoryId);
    if (anchorHistoryId === undefined) {
      throw new GmailInvalidCursorError();
    }
    return Object.freeze({
      connector: 'gmail',
      version: 1,
      mode: 'full',
      pageToken,
      anchorHistoryId,
    });
  }
  if (object.mode === 'history' && typeof object.historyId === 'string' && object.historyId) {
    const targetHistoryId = optionalString(object.targetHistoryId);
    if (targetHistoryId === undefined) {
      throw new GmailInvalidCursorError();
    }
    return Object.freeze({
      connector: 'gmail',
      version: 1,
      mode: 'history',
      historyId: object.historyId,
      pageToken,
      targetHistoryId,
    });
  }
  throw new GmailInvalidCursorError();
}

interface PageResult {
  readonly events: readonly ProviderEventRevisionInput[];
  readonly nextCursor: GmailCursor;
  readonly hasMore: boolean;
}

export class GmailSyncService {
  public constructor(
    private readonly ingestion: HostedIngestionUseCase,
    private readonly gmail: GmailApiPort,
    private readonly vault: GmailCredentialVaultPort,
    private readonly crypto: Pick<GmailCryptoPort, 'sha256Hex'>,
    private readonly clock: GmailClockPort,
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
      const authorization: GmailAuthorizationSession = {
        getTokens: () => tokens,
        onTokenRotation: async (rotated) => {
          await this.vault.rotate(credentialOwner, input.credentialRef, rotated);
          tokens = rotated;
        },
      };
      let cursor = parseGmailCursor(account.cursor);
      const seenCursors = new Set<string>();
      for (let pageNumber = 0; ; pageNumber += 1) {
        if (pageNumber >= MAX_PAGES_PER_SYNC) {
          throw new GmailPageLimitError();
        }
        const cursorKey = JSON.stringify(cursor);
        if (seenCursors.has(cursorKey)) {
          throw new GmailPageLimitError();
        }
        seenCursors.add(cursorKey);

        const page = await this.readPage(cursor, authorization, input.signal);
        const committed = await this.ingestion.commitPage({
          tenantId: input.tenantId,
          accountId: input.accountId,
          syncId: input.syncId,
          expectedCursorVersion: account.cursorVersion,
          nextCursor: page.nextCursor,
          events: page.events,
          observedAt: this.clock.now(),
        });
        account = committed.account;
        if (!page.hasMore) {
          return await this.ingestion.closeSync({
            tenantId: input.tenantId,
            accountId: input.accountId,
            syncId: input.syncId,
            outcome: 'completed',
            closedAt: this.clock.now(),
          });
        }
        cursor = page.nextCursor;
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

  private async readPage(
    cursor: GmailCursor,
    authorization: GmailAuthorizationSession,
    signal?: AbortSignal,
  ): Promise<PageResult> {
    const listPolicy = { ...LIST_POLICY, ...(signal ? { signal } : {}) };
    if (cursor.mode === 'full') {
      const anchorHistoryId =
        cursor.anchorHistoryId ??
        (
          await this.gmail.getProfile(authorization, {
            ...PROFILE_POLICY,
            ...(signal ? { signal } : {}),
          })
        ).historyId;
      const response = await this.gmail.listMessages(
        authorization,
        { pageToken: cursor.pageToken, maxResults: PAGE_SIZE, includeSpamTrash: true },
        listPolicy,
      );
      const events = await this.fetchCurrentMessages(
        response.messages.map((message) => message.id),
        `full:${anchorHistoryId}`,
        authorization,
        signal,
      );
      const nextCursor: GmailCursor = response.nextPageToken
        ? Object.freeze({
            connector: 'gmail',
            version: 1,
            mode: 'full',
            pageToken: response.nextPageToken,
            anchorHistoryId,
          })
        : Object.freeze({
            connector: 'gmail',
            version: 1,
            mode: 'history',
            historyId: anchorHistoryId,
            pageToken: null,
            targetHistoryId: null,
          });
      return Object.freeze({ events, nextCursor, hasMore: response.nextPageToken !== null });
    }

    const response = await this.gmail.listHistory(
      authorization,
      {
        startHistoryId: cursor.historyId,
        pageToken: cursor.pageToken,
        maxResults: PAGE_SIZE,
      },
      listPolicy,
    );
    const changes = collectHistoryChanges(response.history);
    const currentIds = [...changes.entries()]
      .filter(([, change]) => !change.deleted)
      .map(([messageId]) => messageId);
    const events = [
      ...(await this.fetchCurrentMessages(
        currentIds,
        response.historyId ?? cursor.historyId,
        authorization,
        signal,
      )),
      ...(await Promise.all(
        [...changes.entries()]
          .filter(([, change]) => change.deleted)
          .map(([messageId, change]) =>
            mapGmailTombstone(messageId, change.historyRecordId, this.crypto),
          ),
      )),
    ];
    const targetHistoryId = response.historyId ?? cursor.targetHistoryId ?? cursor.historyId;
    const nextCursor: GmailCursor = response.nextPageToken
      ? Object.freeze({
          connector: 'gmail',
          version: 1,
          mode: 'history',
          historyId: cursor.historyId,
          pageToken: response.nextPageToken,
          targetHistoryId,
        })
      : Object.freeze({
          connector: 'gmail',
          version: 1,
          mode: 'history',
          historyId: targetHistoryId,
          pageToken: null,
          targetHistoryId: null,
        });
    return Object.freeze({ events, nextCursor, hasMore: response.nextPageToken !== null });
  }

  private async fetchCurrentMessages(
    messageIds: readonly string[],
    missingRevision: string,
    authorization: GmailAuthorizationSession,
    signal?: AbortSignal,
  ): Promise<readonly ProviderEventRevisionInput[]> {
    const uniqueIds = [...new Set(messageIds)];
    const events: ProviderEventRevisionInput[] = [];
    for (let offset = 0; offset < uniqueIds.length; offset += MESSAGE_CONCURRENCY) {
      const batch = uniqueIds.slice(offset, offset + MESSAGE_CONCURRENCY);
      const messages = await Promise.all(
        batch.map(async (messageId) => {
          try {
            return await this.gmail.getMessage(authorization, messageId, {
              ...MESSAGE_POLICY,
              ...(signal ? { signal } : {}),
            });
          } catch (error) {
            if (error instanceof GmailProviderError && error.failure === 'response_too_large') {
              return null;
            }
            throw error;
          }
        }),
      );
      const mapped = await Promise.all(
        messages.map((message, index) =>
          message
            ? mapGmailMessage(message, this.crypto)
            : mapGmailTombstone(batch[index]!, missingRevision, this.crypto),
        ),
      );
      events.push(...mapped);
    }
    return Object.freeze(events);
  }

  private mapFailure(error: unknown): GmailConnectorError {
    if (error instanceof GmailConnectorError) {
      return error;
    }
    if (error instanceof GmailProviderError) {
      if (error.failure === 'history_expired') {
        return new GmailFullResyncRequiredError();
      }
      if (error.failure === 'revoked') {
        return new GmailReconnectRequiredError();
      }
      return new GmailConnectorError(
        'GMAIL_PROVIDER_UNAVAILABLE',
        'Gmail provider request failed without committing a partial page',
        error.failure === 'rate_limited' || error.failure === 'unavailable',
      );
    }
    return new GmailConnectorError(
      'GMAIL_SYNC_FAILED',
      'Gmail sync failed without committing an incomplete provider page',
      false,
    );
  }
}

interface HistoryChange {
  readonly deleted: boolean;
  readonly historyRecordId: string;
}

function collectHistoryChanges(records: readonly GmailHistoryRecord[]): Map<string, HistoryChange> {
  const changes = new Map<string, HistoryChange>();
  for (const record of records) {
    const markCurrent = (messageId: string | undefined) => {
      if (messageId) {
        changes.set(messageId, { deleted: false, historyRecordId: record.id });
      }
    };
    record.messages?.forEach((message) => markCurrent(message.id));
    record.messagesAdded?.forEach((entry) => markCurrent(entry.message?.id));
    record.labelsAdded?.forEach((entry) => markCurrent(entry.message?.id));
    record.labelsRemoved?.forEach((entry) => markCurrent(entry.message?.id));
    record.messagesDeleted?.forEach((entry) => {
      const messageId = entry.message?.id;
      if (messageId) {
        changes.set(messageId, { deleted: true, historyRecordId: record.id });
      }
    });
  }
  return changes;
}

export function createAuthorizationSession(
  initialTokens: OAuthTokenSet,
  onRotation: (tokens: OAuthTokenSet) => Promise<void>,
): GmailAuthorizationSession {
  let tokens = initialTokens;
  return {
    getTokens: () => tokens,
    onTokenRotation: async (rotated) => {
      await onRotation(rotated);
      tokens = rotated;
    },
  };
}

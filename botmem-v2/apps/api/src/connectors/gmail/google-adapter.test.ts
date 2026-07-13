import { describe, expect, it, vi } from 'vitest';
import {
  GMAIL_OAUTH_SCOPE,
  GmailProviderError,
  GoogleGmailAdapter,
  type BoundedHttpClientPort,
  type BoundedHttpRequest,
  type BoundedHttpResponse,
  type GmailAuthorizationSession,
  type OAuthTokenSet,
} from './index.js';

const NOW = '2026-07-13T10:00:00.000Z';
const FUTURE_TOKENS: OAuthTokenSet = Object.freeze({
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: '2026-07-13T11:00:00.000Z',
  grantedScopes: GMAIL_OAUTH_SCOPE.split(' '),
  tokenType: 'Bearer',
});

class FixtureHttp implements BoundedHttpClientPort {
  public readonly requests: BoundedHttpRequest[] = [];
  public readonly responses: (BoundedHttpResponse | Error)[] = [];

  public async request(request: BoundedHttpRequest) {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error('missing fixture response');
    if (response instanceof Error) throw response;
    return response;
  }
}

function response(status: number, body: unknown): BoundedHttpResponse {
  return { status, headers: {}, body: JSON.stringify(body) };
}

function authorization(initial = FUTURE_TOKENS) {
  let tokens = initial;
  const onTokenRotation = vi.fn(async (rotated: OAuthTokenSet) => {
    tokens = rotated;
  });
  const session: GmailAuthorizationSession = {
    getTokens: () => tokens,
    onTokenRotation,
  };
  return { session, onTokenRotation };
}

function harness() {
  const http = new FixtureHttp();
  const adapter = new GoogleGmailAdapter(
    { clientId: 'server-client-id', clientSecret: 'server-client-secret' },
    http,
    { now: () => NOW },
  );
  return { adapter, http };
}

describe('GoogleGmailAdapter', () => {
  it('getIdentity_readsImmutableVerifiedOpenIdSubject', async () => {
    const { adapter, http } = harness();
    http.responses.push(
      response(200, {
        sub: 'google-subject-123',
        email: 'owner@example.test',
        email_verified: true,
      }),
    );

    const identity = await adapter.getIdentity(authorization().session, {
      timeoutMs: 15_000,
      maxResponseBytes: 64_000,
    });

    expect(identity).toEqual({
      subject: 'google-subject-123',
      emailAddress: 'owner@example.test',
      emailVerified: true,
    });
    expect(http.requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://openidconnect.googleapis.com/v1/userinfo',
      headers: { authorization: 'Bearer access-1' },
    });
  });

  it('listAdapters_forwardPaginationAndBoundsWithoutHistoryFiltering', async () => {
    const { adapter, http } = harness();
    const { session } = authorization();
    http.responses.push(
      response(200, { messages: [{ id: 'm1' }], nextPageToken: 'MESSAGE-NEXT' }),
      response(200, {
        history: [{ id: 'H101', messagesAdded: [{ message: { id: 'm1' } }] }],
        historyId: 'H110',
        nextPageToken: 'HISTORY-NEXT',
      }),
    );

    await adapter.listMessages(
      session,
      { pageToken: 'MESSAGE-PAGE', maxResults: 100, includeSpamTrash: true },
      { timeoutMs: 12_345, maxResponseBytes: 123_456 },
    );
    await adapter.listHistory(
      session,
      { startHistoryId: 'H100', pageToken: 'HISTORY-PAGE', maxResults: 100 },
      { timeoutMs: 12_345, maxResponseBytes: 123_456 },
    );

    const messageUrl = new URL(http.requests[0]!.url);
    expect(messageUrl.searchParams.get('includeSpamTrash')).toBe('true');
    expect(messageUrl.searchParams.get('pageToken')).toBe('MESSAGE-PAGE');
    expect(http.requests[0]).toMatchObject({
      timeoutMs: 12_345,
      maxResponseBytes: 123_456,
      headers: { authorization: 'Bearer access-1' },
    });
    const historyUrl = new URL(http.requests[1]!.url);
    expect(historyUrl.searchParams.get('startHistoryId')).toBe('H100');
    expect(historyUrl.searchParams.get('pageToken')).toBe('HISTORY-PAGE');
    expect(historyUrl.searchParams.has('historyTypes')).toBe(false);
  });

  it('listHistory_whenGoogleReturns404_mapsToExpiredHistorySignal', async () => {
    const { adapter, http } = harness();
    http.responses.push(response(404, { error: { code: 404 } }));

    await expect(
      adapter.listHistory(
        authorization().session,
        { startHistoryId: 'expired', pageToken: null, maxResults: 100 },
        { timeoutMs: 15_000, maxResponseBytes: 100_000 },
      ),
    ).rejects.toMatchObject({ failure: 'history_expired', status: 404 });
  });

  it('getProfile_whenAccessExpires_rotatesTokenBeforeAuthorizedRequest', async () => {
    const { adapter, http } = harness();
    const expired: OAuthTokenSet = { ...FUTURE_TOKENS, expiresAt: '2026-07-13T09:59:00.000Z' };
    const { session, onTokenRotation } = authorization(expired);
    http.responses.push(
      response(200, {
        access_token: 'access-2',
        expires_in: 3600,
        scope: GMAIL_OAUTH_SCOPE,
        token_type: 'Bearer',
      }),
      response(200, { emailAddress: 'owner@example.test', historyId: 'H100', messagesTotal: 1 }),
    );

    await adapter.getProfile(session, { timeoutMs: 15_000, maxResponseBytes: 64_000 });

    expect(http.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://oauth2.googleapis.com/token',
      timeoutMs: 15_000,
      maxResponseBytes: 65_536,
    });
    expect(http.requests[0]?.body).toContain('grant_type=refresh_token');
    expect(onTokenRotation).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'access-2', refreshToken: 'refresh-1' }),
    );
    expect(http.requests[1]?.headers).toEqual({ authorization: 'Bearer access-2' });
  });

  it('getProfile_whenRefreshGrantRevoked_neverCallsGmailWithStaleToken', async () => {
    const { adapter, http } = harness();
    const expired: OAuthTokenSet = { ...FUTURE_TOKENS, expiresAt: '2026-07-13T09:59:00.000Z' };
    http.responses.push(response(400, { error: 'invalid_grant' }));

    await expect(
      adapter.getProfile(authorization(expired).session, {
        timeoutMs: 15_000,
        maxResponseBytes: 64_000,
      }),
    ).rejects.toEqual(expect.objectContaining<GmailProviderError>({ failure: 'revoked' }));
    expect(http.requests).toHaveLength(1);
  });

  it('getMessage_whenFullResponseIsTooLarge_fallsBackToSearchableMetadata', async () => {
    const { adapter, http } = harness();
    http.responses.push(
      new GmailProviderError('response_too_large', 200),
      response(200, {
        id: 'message-large',
        threadId: 'thread-large',
        historyId: 'H200',
        internalDate: '1718447400000',
        snippet: 'The searchable message preview',
        payload: {
          mimeType: 'multipart/mixed',
          headers: [
            { name: 'Subject', value: 'Large attachment' },
            { name: 'From', value: 'sender@example.test' },
          ],
        },
      }),
    );

    const message = await adapter.getMessage(authorization().session, 'message-large', {
      timeoutMs: 20_000,
      maxResponseBytes: 16 * 1024 * 1024,
    });

    expect(message).toMatchObject({
      id: 'message-large',
      historyId: 'H200',
      snippet: 'The searchable message preview',
    });
    expect(new URL(http.requests[0]!.url).searchParams.get('format')).toBe('full');
    const metadataUrl = new URL(http.requests[1]!.url);
    expect(metadataUrl.searchParams.get('format')).toBe('metadata');
    expect(metadataUrl.searchParams.getAll('metadataHeaders')).toEqual(
      expect.arrayContaining(['Subject', 'From', 'To', 'Date']),
    );
  });

  it('getMessage_whenMetadataIsStillTooLarge_preservesTheEventWithMinimalMetadata', async () => {
    const { adapter, http } = harness();
    http.responses.push(
      new GmailProviderError('response_too_large', 200),
      new GmailProviderError('response_too_large', 200),
      response(200, {
        id: 'message-extreme',
        threadId: 'thread-extreme',
        historyId: 'H201',
        labelIds: ['INBOX'],
      }),
    );

    const message = await adapter.getMessage(authorization().session, 'message-extreme', {
      timeoutMs: 20_000,
      maxResponseBytes: 16 * 1024 * 1024,
    });

    expect(message).toMatchObject({ id: 'message-extreme', historyId: 'H201' });
    expect(http.requests.map((request) => new URL(request.url).searchParams.get('format'))).toEqual([
      'full',
      'metadata',
      'minimal',
    ]);
  });
});

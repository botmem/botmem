import { describe, expect, it, vi } from 'vitest';
import {
  MICROSOFT_TOKEN_ENDPOINT,
  OUTLOOK_SCOPE,
  OUTLOOK_SCOPES,
  MicrosoftGraphOutlookAdapter,
  OutlookProviderError,
  type OutlookAuthorizationSession,
  type OutlookBoundedHttpClientPort,
  type OutlookBoundedHttpRequest,
  type OutlookBoundedHttpResponse,
  type OutlookOAuthTokenSet,
} from './index.js';

const NOW = '2026-07-13T10:00:00.000Z';
const FUTURE_TOKENS: OutlookOAuthTokenSet = Object.freeze({
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: '2026-07-13T11:00:00.000Z',
  grantedScopes: OUTLOOK_SCOPES,
  tokenType: 'Bearer',
});
const FOLDER_ID = 'folder-1';
const NEXT_LINK = `https://graph.microsoft.com/v1.0/me/mailFolders/${FOLDER_ID}/messages/delta?$skiptoken=opaque-next`;
const DELTA_LINK = `https://graph.microsoft.com/v1.0/me/mailFolders/${FOLDER_ID}/messages/delta?$deltatoken=opaque-delta`;

class FixtureHttp implements OutlookBoundedHttpClientPort {
  public readonly requests: OutlookBoundedHttpRequest[] = [];
  public readonly responses: OutlookBoundedHttpResponse[] = [];

  public async request(request: OutlookBoundedHttpRequest) {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error('missing fixture response');
    return response;
  }
}

function response(status: number, body: unknown): OutlookBoundedHttpResponse {
  return { status, headers: {}, body: JSON.stringify(body) };
}

function authorization(initial = FUTURE_TOKENS) {
  let tokens = initial;
  const order: string[] = [];
  const onTokenRotation = vi.fn(async (rotated: OutlookOAuthTokenSet) => {
    order.push('persist');
    tokens = rotated;
  });
  const session: OutlookAuthorizationSession = {
    getTokens: () => tokens,
    onTokenRotation,
  };
  return { session, onTokenRotation, order };
}

function harness() {
  const http = new FixtureHttp();
  const adapter = new MicrosoftGraphOutlookAdapter(
    { clientId: 'server-client-id', clientSecret: 'server-client-secret' },
    http,
    { now: () => NOW },
  );
  return { adapter, http };
}

describe('MicrosoftGraphOutlookAdapter', () => {
  it('exchangeAuthorizationCode_usesCommonTokenEndpointExactRedirectPkceAndBounds', async () => {
    const { adapter, http } = harness();
    http.responses.push(
      response(200, {
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
        scope: OUTLOOK_SCOPE,
        token_type: 'Bearer',
      }),
    );

    await adapter.exchangeAuthorizationCode({
      code: 'provider-code',
      codeVerifier: 'pkce-verifier',
      redirectUri: 'https://api.botmem.test/v2/connectors/outlook/callback',
    });

    expect(http.requests[0]).toMatchObject({
      method: 'POST',
      url: MICROSOFT_TOKEN_ENDPOINT,
      timeoutMs: 15_000,
      maxResponseBytes: 65_536,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const body = new URLSearchParams(http.requests[0]?.body);
    expect(body.get('client_id')).toBe('server-client-id');
    expect(body.get('client_secret')).toBe('server-client-secret');
    expect(body.get('code_verifier')).toBe('pkce-verifier');
    expect(body.get('redirect_uri')).toBe('https://api.botmem.test/v2/connectors/outlook/callback');
    expect(body.get('scope')).toBe(OUTLOOK_SCOPE);
  });

  it('discoverMailFolders_paginatesTopLevelAndRecursesThroughHiddenChildren', async () => {
    const { adapter, http } = harness();
    const topNext = 'https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken=top-2';
    http.responses.push(
      response(200, {
        value: [{ id: 'folder-parent', childFolderCount: 1 }],
        '@odata.nextLink': topNext,
      }),
      response(200, { value: [{ id: 'folder-child', childFolderCount: 0 }] }),
      response(200, { value: [{ id: 'folder-peer', childFolderCount: 0 }] }),
    );

    const folders = await adapter.discoverMailFolders(authorization().session, {
      timeoutMs: 12_000,
      maxResponseBytes: 512_000,
    });

    expect(folders.map((folder) => folder.id)).toEqual([
      'folder-child',
      'folder-parent',
      'folder-peer',
    ]);
    expect(new URL(http.requests[0]!.url).searchParams.get('includeHiddenFolders')).toBe('true');
    expect(http.requests[1]?.url).toContain('/mailFolders/folder-parent/childFolders');
    expect(new URL(http.requests[1]!.url).searchParams.get('includeHiddenFolders')).toBe('true');
    expect(http.requests[2]?.url).toBe(topNext);
  });

  it('discoverMailFolders_rejectsProviderPaginationCycles', async () => {
    const { adapter, http } = harness();
    const repeated = 'https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken=repeated';
    http.responses.push(
      response(200, { value: [], '@odata.nextLink': repeated }),
      response(200, { value: [], '@odata.nextLink': repeated }),
    );

    await expect(
      adapter.discoverMailFolders(authorization().session, {
        timeoutMs: 12_000,
        maxResponseBytes: 512_000,
      }),
    ).rejects.toEqual(
      expect.objectContaining<OutlookProviderError>({ failure: 'invalid_response' }),
    );
    expect(http.requests).toHaveLength(2);
  });

  it('listMessageDelta_initialRequestIngestsAllMailWithNoSearchOrFilterAndMetadataOnlyMedia', async () => {
    const { adapter, http } = harness();
    http.responses.push(
      response(200, {
        value: [
          {
            id: 'message-1',
            subject: 'OTP promotion unsubscribe text is not filtered',
            attachments: [{ id: 'attachment-1', name: 'invoice.pdf' }],
          },
        ],
        '@odata.nextLink': NEXT_LINK,
      }),
    );

    const page = await adapter.listMessageDelta(authorization().session, FOLDER_ID, null, {
      timeoutMs: 12_345,
      maxResponseBytes: 123_456,
    });

    const request = http.requests[0]!;
    const url = new URL(request.url);
    expect(url.origin).toBe('https://graph.microsoft.com');
    expect(url.pathname).toBe(`/v1.0/me/mailFolders/${FOLDER_ID}/messages/delta`);
    expect(url.searchParams.has('$filter')).toBe(false);
    expect(url.searchParams.has('$search')).toBe(false);
    expect(url.searchParams.get('$top')).toBe('100');
    expect(url.searchParams.get('$select')).toContain('body');
    expect(url.searchParams.get('$expand')).toContain('attachments');
    expect(url.searchParams.get('$expand')).not.toContain('contentBytes');
    expect(request).toMatchObject({
      timeoutMs: 12_345,
      maxResponseBytes: 123_456,
      headers: { authorization: 'Bearer access-1' },
    });
    expect(request.headers.prefer).toContain('IdType="ImmutableId"');
    expect(page.messages[0]?.subject).toContain('OTP');
    expect(page.nextLink).toBe(NEXT_LINK);
  });

  it('listMessageDelta_forwardsOpaqueGraphCursorButRejectsTokenExfiltrationOrigins', async () => {
    const { adapter, http } = harness();
    http.responses.push(response(200, { value: [], '@odata.deltaLink': DELTA_LINK }));

    await adapter.listMessageDelta(authorization().session, FOLDER_ID, NEXT_LINK, {
      timeoutMs: 15_000,
      maxResponseBytes: 1_000_000,
    });
    expect(http.requests[0]?.url).toBe(NEXT_LINK);

    await expect(
      adapter.listMessageDelta(
        authorization().session,
        FOLDER_ID,
        'https://attacker.invalid/steal?$deltatoken=secret',
        { timeoutMs: 15_000, maxResponseBytes: 1_000_000 },
      ),
    ).rejects.toEqual(
      expect.objectContaining<OutlookProviderError>({
        failure: 'invalid_response',
      }),
    );
    expect(http.requests).toHaveLength(1);
  });

  it('listMessageDelta_whenGraphInvalidatesDelta_mapsToExplicitRecoverySignal', async () => {
    const { adapter, http } = harness();
    http.responses.push(response(410, { error: { code: 'syncStateNotFound' } }));

    await expect(
      adapter.listMessageDelta(authorization().session, FOLDER_ID, DELTA_LINK, {
        timeoutMs: 15_000,
        maxResponseBytes: 1_000_000,
      }),
    ).rejects.toEqual(
      expect.objectContaining<OutlookProviderError>({ failure: 'invalid_delta', status: 410 }),
    );
  });

  it('getProfile_whenTokenExpires_persistsRefreshRotationBeforeUsingNewAccessToken', async () => {
    const { adapter, http } = harness();
    const expired: OutlookOAuthTokenSet = {
      ...FUTURE_TOKENS,
      expiresAt: '2026-07-13T09:59:00.000Z',
    };
    const auth = authorization(expired);
    http.responses.push(
      response(200, {
        access_token: 'access-2',
        refresh_token: 'refresh-2',
        expires_in: 3600,
        scope: OUTLOOK_SCOPE,
        token_type: 'Bearer',
      }),
      response(200, { id: 'provider-id', mail: null, userPrincipalName: 'owner@example.test' }),
    );

    const profile = await adapter.getProfile(auth.session, {
      timeoutMs: 15_000,
      maxResponseBytes: 65_536,
    });

    expect(profile.id).toBe('provider-id');
    expect(auth.onTokenRotation).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'access-2', refreshToken: 'refresh-2' }),
    );
    expect(http.requests[0]?.body).toContain('grant_type=refresh_token');
    expect(http.requests[1]?.headers).toEqual({ authorization: 'Bearer access-2' });
  });

  it('getProfile_whenRefreshGrantIsRevoked_neverUsesStaleAccessToken', async () => {
    const { adapter, http } = harness();
    const expired: OutlookOAuthTokenSet = {
      ...FUTURE_TOKENS,
      expiresAt: '2026-07-13T09:59:00.000Z',
    };
    http.responses.push(response(400, { error: { code: 'invalid_grant' } }));

    await expect(
      adapter.getProfile(authorization(expired).session, {
        timeoutMs: 15_000,
        maxResponseBytes: 65_536,
      }),
    ).rejects.toEqual(expect.objectContaining<OutlookProviderError>({ failure: 'revoked' }));
    expect(http.requests).toHaveLength(1);
  });
});

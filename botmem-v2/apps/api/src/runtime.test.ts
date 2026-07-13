import type { SearchResponse } from '@botmem-v2/contracts';
import { describe, expect, it } from 'vitest';
import type { RuntimeConfig } from './config.js';
import type {
  AuthenticatedPrincipal,
  CredentialKind,
  CredentialSnapshot,
} from './identity/domain.js';
import { NodeTokenSecurity } from './identity/token-security.js';
import type { CredentialRepositoryPort } from './identity/ports.js';
import { buildRuntimeApp, requestPathForLog, type RuntimeDependencies } from './runtime.js';
import { WorkspaceAuthorizationError } from './search-api.js';
import type { WorkspaceAuthorizer } from './search-api.js';
import type { SqlClientPort, SqlPoolPort, SqlQueryResult } from './search/postgres-ports.js';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const SESSION = `bms_v2.${'A'.repeat(43)}`;
const PAT = `bmp_v2.${'B'.repeat(43)}`;
const PEPPER = new Uint8Array(32).fill(7);

class RuntimeCredentials implements CredentialRepositoryPort {
  readonly records = new Map<string, AuthenticatedPrincipal>();
  readonly inserted: CredentialSnapshot[] = [];
  rotations = 0;
  async authenticate(input: {
    secretHashHex: string;
    expectedKind: CredentialKind;
  }): Promise<AuthenticatedPrincipal | null> {
    const record = this.records.get(input.secretHashHex) ?? null;
    return record?.credentialKind === input.expectedKind ? record : null;
  }
  async issue(credential: CredentialSnapshot): Promise<void> {
    this.inserted.push(credential);
  }
  async rotate(): Promise<void> {
    this.rotations += 1;
  }
  async revoke(): Promise<boolean> {
    return true;
  }
  async listPersonalAccessTokens() {
    return [];
  }
  async revokePersonalAccessToken(): Promise<boolean> {
    return true;
  }
}

class ReadinessClient implements SqlClientPort {
  async query<Row>(): Promise<SqlQueryResult<Row>> {
    return { rows: [], rowCount: null };
  }
  release(): void {}
}

const config: RuntimeConfig = {
  environment: 'test',
  host: '127.0.0.1',
  port: 12_412,
  databaseUrl: 'postgresql://localhost/botmem',
  publicBaseUrl: 'http://127.0.0.1:12412',
  publicWebBaseUrl: 'http://127.0.0.1:12412',
  trustedOrigins: ['http://127.0.0.1:12412'],
  tokenPepper: PEPPER,
  sessionCookieName: 'botmem_session',
  secureCookies: false,
  sessionTtlMs: 86_400_000,
  patMaxTtlMs: 7 * 86_400_000,
  databasePoolMax: 2,
  databaseConnectTimeoutMs: 1_000,
  publicReleases: {
    version: 2,
    apiBaseUrl: 'http://127.0.0.1:12412/',
    macos: { available: false },
    cli: { available: false },
  },
};

function principal(kind: CredentialKind, id: string): AuthenticatedPrincipal {
  return {
    tenantId: WORKSPACE_ID,
    workspaceId: WORKSPACE_ID,
    userId: '20000000-0000-4000-8000-000000000001',
    membershipRole: 'owner',
    credentialId: id,
    credentialKind: kind,
    scopes: kind === 'browser_session' ? ['browser'] : ['botmem:search'],
    expiresAt: '2026-07-20T10:00:00.000Z',
  };
}

async function fixture(
  loginDelivery?: {
    readiness(): Promise<boolean>;
    deliverSignInLink(): Promise<void>;
  },
  runtimeConfig: RuntimeConfig = config,
  overrides: Partial<RuntimeDependencies> = {},
) {
  const repository = new RuntimeCredentials();
  const security = new NodeTokenSecurity(PEPPER);
  repository.records.set(
    await security.hash(SESSION),
    principal('browser_session', '30000000-0000-4000-8000-000000000001'),
  );
  repository.records.set(
    await security.hash(PAT),
    principal('personal_access_token', '30000000-0000-4000-8000-000000000002'),
  );
  const response: SearchResponse = {
    version: 2,
    queryId: '40000000-0000-4000-8000-000000000001',
    items: [],
    coverage: {
      partial: false,
      lanes: [
        {
          laneId: 'hosted',
          placement: 'hosted',
          status: 'complete',
          retryable: false,
          returned: 0,
          tookMs: 1,
        },
      ],
    },
    found: 0,
    tookMs: 1,
  };
  const sqlPool: SqlPoolPort = { connect: async () => new ReadinessClient() };
  const searchCalls = { count: 0 };
  const deviceLifecycle = { registered: 0, closed: 0 };
  let deviceAuthorizer: WorkspaceAuthorizer | undefined;
  const app = buildRuntimeApp(runtimeConfig, {
    sqlPool,
    credentialRepository: repository,
    clock: { nowMs: () => Date.parse('2026-07-13T10:00:00.000Z') },
    ...(loginDelivery ? { loginDelivery } : {}),
    search: {
      search: async () => {
        searchCalls.count += 1;
        return response;
      },
    },
    sourceStatuses: { list: async () => [] },
    connections: {
      listConnections: async () => ({ version: 2, connections: [] }),
      beginOAuthConnection: async () => {
        throw new Error('not used');
      },
      connectOwnTracks: async () => {
        throw new Error('not used');
      },
      actOnConnection: async () => {
        throw new Error('not used');
      },
    },
    oauthCallbacks: {
      completeGmail: async () => undefined,
      completeOutlook: async () => undefined,
    },
    connectionSuccessRedirectUrl: 'http://localhost:12412/connections',
    deviceRuntime: {
      devices: { listDevices: async () => ({ version: 2, devices: [] }) },
      register: async (_app, _browserAuthorizer, readAuthorizer) => {
        deviceLifecycle.registered += 1;
        deviceAuthorizer = readAuthorizer;
      },
      close: async () => {
        deviceLifecycle.closed += 1;
      },
    },
    ...overrides,
  });
  return {
    app,
    repository,
    searchCalls,
    deviceLifecycle,
    getDeviceAuthorizer: () => deviceAuthorizer,
  };
}

describe('Botmem v2 runtime HTTP boundary', () => {
  it('publicReleaseMetadata_isRuntimeConfiguredAndRequiresNoSession', async () => {
    const { app } = await fixture(undefined, {
      ...config,
      publicReleases: {
        version: 2,
        apiBaseUrl: 'http://127.0.0.1:12412/',
        macos: {
          available: true,
          url: 'https://github.com/botmem/botmem/releases/download/botmem-v2-v2.4.1/Botmem.dmg',
          releaseVersion: '2.4.1',
          sha256: 'a'.repeat(64),
        },
        cli: { available: false },
      },
    });
    const response = await app.inject({ method: 'GET', url: '/v2/public/releases' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: 2,
      macos: { available: true, releaseVersion: '2.4.1' },
      cli: { available: false },
    });
    await app.close();
  });

  it('operationalRequestPath_neverIncludesOAuthQuerySecrets', () => {
    expect(
      requestPathForLog('/v2/connections/oauth/callback?code=provider-secret&state=capability'),
    ).toBe('/v2/connections/oauth/callback');
    expect(
      requestPathForLog(
        `/v2/workspaces/${WORKSPACE_ID}/lifecycle/exports/880a97f8-d069-4031-a26a-aa56baeb465e/download?capability=secret`,
      ),
    ).toBe('/v2/workspaces/:id/lifecycle/exports/:id/download');
  });

  it('runtime_registersAndClosesTheSharedDeviceRuntime', async () => {
    const { app, deviceLifecycle } = await fixture();
    await app.ready();
    expect(deviceLifecycle.registered).toBe(1);
    await app.close();
    expect(deviceLifecycle.closed).toBe(1);
  });

  it('session_withOpaqueHttpOnlyCookie_returnsNoBearerMaterial', async () => {
    const { app } = await fixture();
    const response = await app.inject({
      method: 'GET',
      url: '/v2/session',
      headers: { cookie: `botmem_session=${SESSION}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ version: 2, workspaceId: WORKSPACE_ID });
    expect(response.body).not.toContain(SESSION);
    expect(response.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it('search_withCookie_requiresTrustedOrigin_butPatDoesNotUseBrowserCsrf', async () => {
    const { app, searchCalls } = await fixture();
    const body = { version: 2, query: 'launch' };
    const rejected = await app.inject({
      method: 'POST',
      url: `/v2/workspaces/${WORKSPACE_ID}/search`,
      headers: { cookie: `botmem_session=${SESSION}` },
      payload: body,
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json()).toMatchObject({ error: { code: 'csrf_rejected' } });
    expect(searchCalls.count).toBe(0);

    const browser = await app.inject({
      method: 'POST',
      url: `/v2/workspaces/${WORKSPACE_ID}/search`,
      headers: {
        cookie: `botmem_session=${SESSION}`,
        origin: 'http://127.0.0.1:12412',
      },
      payload: body,
    });
    expect(browser.statusCode).toBe(200);
    expect(searchCalls.count).toBe(1);

    const cli = await app.inject({
      method: 'POST',
      url: `/v2/workspaces/${WORKSPACE_ID}/search`,
      headers: { authorization: `Bearer ${PAT}` },
      payload: body,
    });
    expect(cli.statusCode).toBe(200);
    expect(searchCalls.count).toBe(2);
    await app.close();
  });

  it('patCreation_returnsSecretOnceAndNeverPersistsPlaintext', async () => {
    const { app, repository } = await fixture();
    const response = await app.inject({
      method: 'POST',
      url: `/v2/workspaces/${WORKSPACE_ID}/pats`,
      headers: {
        cookie: `botmem_session=${SESSION}`,
        origin: 'http://127.0.0.1:12412',
      },
      payload: { version: 2, label: 'Codex CLI', ttlSeconds: 3_600 },
    });
    expect(response.statusCode).toBe(201);
    const accessToken = response.json<{ accessToken: string }>().accessToken;
    expect(accessToken).toMatch(/^bmp_v2\.[A-Za-z0-9_-]{43}$/u);
    expect(JSON.stringify(repository.inserted)).not.toContain(accessToken);
    expect(repository.inserted[0]?.secretHashHex).toMatch(/^[0-9a-f]{64}$/u);
    await app.close();
  });

  it('searchPat_isDeniedByManagementAndStatusAuthorizers', async () => {
    const { app, getDeviceAuthorizer } = await fixture();
    await app.ready();
    const authorization = `Bearer ${PAT}`;
    for (const url of [
      `/v2/workspaces/${WORKSPACE_ID}/connections`,
      `/v2/workspaces/${WORKSPACE_ID}/sources`,
      `/v2/workspaces/${WORKSPACE_ID}/pats`,
    ]) {
      const response = await app.inject({ method: 'GET', url, headers: { authorization } });
      expect(response.statusCode, url).toBe(403);
      expect(response.headers['cache-control'], url).toBe('no-store');
      expect(response.headers.pragma, url).toBe('no-cache');
    }
    await expect(
      getDeviceAuthorizer()?.authorize(WORKSPACE_ID, {
        authorizationHeader: authorization,
      }),
    ).rejects.toMatchObject({ status: 403, code: 'workspace_forbidden' });
    await app.close();
  });

  it('statusPat_canReadConnectionsAndDevices_butCannotUseBrowserManagement', async () => {
    const { app, repository, getDeviceAuthorizer } = await fixture();
    const security = new NodeTokenSecurity(PEPPER);
    repository.records.set(await security.hash(PAT), {
      ...principal('personal_access_token', '30000000-0000-4000-8000-000000000002'),
      scopes: ['botmem:search', 'botmem:connections:read', 'botmem:devices:read'],
    });
    await app.ready();
    const authorizationHeader = `Bearer ${PAT}`;

    const connections = await app.inject({
      method: 'GET',
      url: `/v2/workspaces/${WORKSPACE_ID}/connections`,
      headers: { authorization: authorizationHeader },
    });
    expect(connections.statusCode).toBe(200);
    await expect(
      getDeviceAuthorizer()?.authorize(WORKSPACE_ID, { authorizationHeader }),
    ).resolves.toBe(WORKSPACE_ID);

    const tokens = await app.inject({
      method: 'GET',
      url: `/v2/workspaces/${WORKSPACE_ID}/pats`,
      headers: { authorization: authorizationHeader },
    });
    expect(tokens.statusCode).toBe(403);
    await app.close();
  });

  it('patRotation_withWrongWorkspace_neverRevokesThePresentedToken', async () => {
    const { app, repository } = await fixture();
    const response = await app.inject({
      method: 'POST',
      url: '/v2/workspaces/10000000-0000-4000-8000-000000000002/pats/current/rotate',
      headers: { authorization: `Bearer ${PAT}` },
    });
    expect(response.statusCode).toBe(404);
    expect(repository.rotations).toBe(0);
    await app.close();
  });

  it('readiness_neverClaimsAuthenticationReadyWithoutLoginDelivery', async () => {
    const { app } = await fixture();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'not_ready',
      reason: 'login_delivery_unconfigured',
    });
    await app.close();
  });

  it('readiness_withExplicitReadyLoginDeliveryAndDatabase_isReady', async () => {
    const { app } = await fixture({
      readiness: async () => true,
      deliverSignInLink: async () => undefined,
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
    await app.close();
  });

  it('readiness_withAnUnavailableRuntimeComponent_failsWithStableReasonCode', async () => {
    const { app } = await fixture(
      {
        readiness: async () => true,
        deliverSignInLink: async () => undefined,
      },
      config,
      {
        readinessProbes: [{ name: 'hosted_sync', isReady: async () => false }],
      },
    );
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'not_ready',
      reason: 'hosted_sync_unavailable',
    });
    await app.close();
  });

  it('workspaceAuthorizerDecorator_gatesDataRoutesWithoutBlockingIdentitySetup', async () => {
    let registered = false;
    const { app, searchCalls } = await fixture(undefined, config, {
      workspaceAuthorizerDecorator: (authorizer) => ({
        authorize: async (workspaceId, credentials) => {
          await authorizer.authorize(workspaceId, credentials);
          throw new WorkspaceAuthorizationError(
            403,
            'workspace_forbidden',
            'Subscription required',
          );
        },
      }),
      registrars: [
        {
          register: (_app, authorizer) => {
            registered = typeof authorizer.authorize === 'function';
          },
        },
      ],
    });
    await app.ready();
    expect(registered).toBe(true);

    const session = await app.inject({
      method: 'GET',
      url: '/v2/session',
      headers: { cookie: `botmem_session=${SESSION}` },
    });
    expect(session.statusCode).toBe(200);

    const search = await app.inject({
      method: 'POST',
      url: `/v2/workspaces/${WORKSPACE_ID}/search`,
      headers: {
        cookie: `botmem_session=${SESSION}`,
        origin: 'http://127.0.0.1:12412',
      },
      payload: { version: 2, query: 'launch' },
    });
    expect(search.statusCode).toBe(403);
    expect(searchCalls.count).toBe(0);
    await app.close();
  });

  it('readiness_withConfiguredResendAdapter_isReadyWithoutAnInjectedFake', async () => {
    const { app } = await fixture(undefined, {
      ...config,
      resendLogin: {
        apiKey: 're_123456789_runtime',
        from: 'Botmem <login@botmem.example>',
      },
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
    await app.close();
  });

  it('emailLogin_withoutRealDelivery_fails503ForEveryAddress', async () => {
    const { app } = await fixture();
    const response = await app.inject({
      method: 'POST',
      url: '/v2/auth/email/start',
      headers: { origin: 'http://127.0.0.1:12412' },
      payload: { version: 2, email: 'nobody@example.com' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: 'login_delivery_unavailable' },
    });
    await app.close();
  });

  it('emailLoginStart_withoutCanonicalVersion_failsClosedBeforeDelivery', async () => {
    const { app } = await fixture({
      readiness: async () => true,
      deliverSignInLink: async () => undefined,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v2/auth/email/start',
      headers: { origin: 'http://127.0.0.1:12412' },
      payload: { workspaceId: WORKSPACE_ID, email: 'owner@example.com' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_request' } });
    await app.close();
  });
});

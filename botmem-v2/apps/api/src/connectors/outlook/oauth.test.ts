import { connectorAccountId, tenantId } from '@botmem-v2/connector-domain';
import { describe, expect, it, vi } from 'vitest';
import {
  MICROSOFT_AUTHORIZATION_ENDPOINT,
  OUTLOOK_MAIL_READ_SCOPE,
  OUTLOOK_OFFLINE_ACCESS_SCOPE,
  OUTLOOK_SCOPE,
  OUTLOOK_USER_READ_SCOPE,
  OutlookOAuthCallbackError,
  OutlookOAuthService,
  OutlookOAuthStateError,
  OutlookProviderError,
  type OutlookClockPort,
  type OutlookCredentialVaultPort,
  type OutlookCryptoPort,
  type OutlookGraphApiPort,
  type OutlookOAuthProviderPort,
  type OutlookOAuthStateRepository,
  type OutlookOAuthTokenSet,
  type PendingOutlookOAuthState,
} from './index.js';

const TENANT_ID = tenantId('10000000-0000-4000-8000-000000000001');
const ACCOUNT_ID = connectorAccountId('20000000-0000-4000-8000-000000000001');
const REDIRECT_URI = 'https://api.botmem.test/v2/connectors/outlook/callback';
const TOKENS: OutlookOAuthTokenSet = Object.freeze({
  accessToken: 'access-token-fixture',
  refreshToken: 'refresh-token-fixture',
  expiresAt: '2026-07-13T11:00:00.000Z',
  grantedScopes: ['https://graph.microsoft.com/mail.read', 'https://graph.microsoft.com/user.read'],
  tokenType: 'Bearer',
});

class StateRepository implements OutlookOAuthStateRepository {
  public readonly records = new Map<string, PendingOutlookOAuthState>();

  public async save(state: PendingOutlookOAuthState) {
    if (this.records.has(state.stateDigest)) throw new Error('state collision');
    this.records.set(state.stateDigest, state);
  }

  public async consume(stateDigest: string, now: string) {
    const state = this.records.get(stateDigest) ?? null;
    this.records.delete(stateDigest);
    return state && Date.parse(state.expiresAt) > Date.parse(now) ? state : null;
  }
}

class FixtureCrypto implements OutlookCryptoPort {
  private randomIndex = 0;

  public async randomUrlSafe() {
    return ['raw-state', 'pkce-verifier'][this.randomIndex++] ?? 'unused-random';
  }

  public async sha256Base64Url(value: string) {
    return `challenge-${value}`;
  }

  public async sha256Hex(value: string) {
    if (value === 'raw-state') return '1'.repeat(64);
    if (value.startsWith('outlook:graph-user:')) return '2'.repeat(64);
    return '3'.repeat(64);
  }

  public async sealEphemeral(value: string) {
    return `sealed:${value}`;
  }

  public async openEphemeral(value: string) {
    return value.replace(/^sealed:/, '');
  }
}

function harness(tokens = TOKENS) {
  const states = new StateRepository();
  const clock: OutlookClockPort & { current: string } = {
    current: '2026-07-13T10:00:00.000Z',
    now() {
      return this.current;
    },
  };
  const provider: OutlookOAuthProviderPort = {
    exchangeAuthorizationCode: vi.fn().mockResolvedValue(tokens),
  };
  const graph: OutlookGraphApiPort = {
    getProfile: vi.fn().mockResolvedValue({
      id: 'provider-object-id-7',
      mail: 'Owner@Example.test',
      userPrincipalName: 'fallback@example.test',
    }),
    discoverMailFolders: vi.fn(),
    listMessageDelta: vi.fn(),
  };
  const vault: OutlookCredentialVaultPort = {
    store: vi.fn().mockResolvedValue('vault://outlook/account-1'),
    read: vi.fn(),
    rotate: vi.fn(),
    revoke: vi.fn(),
  };
  const service = new OutlookOAuthService(
    { clientId: 'server-owned-client-id', redirectUri: REDIRECT_URI },
    states,
    new FixtureCrypto(),
    clock,
    provider,
    graph,
    vault,
  );
  return { service, states, clock, provider, graph, vault };
}

async function begin(service: OutlookOAuthService) {
  return service.beginAuthorization({ tenantId: TENANT_ID, accountId: ACCOUNT_ID });
}

describe('OutlookOAuthService', () => {
  it('beginAuthorization_usesCommonAuthorityExactRedirectFixedMinimalScopesAndPkce', async () => {
    const { service, states } = harness();
    const result = await begin(service);
    const url = new URL(result.authorizationUrl);

    expect(`${url.origin}${url.pathname}`).toBe(MICROSOFT_AUTHORIZATION_ENDPOINT);
    expect(url.searchParams.get('client_id')).toBe('server-owned-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('scope')).toBe(OUTLOOK_SCOPE);
    expect(new Set(url.searchParams.get('scope')?.split(' '))).toEqual(
      new Set([OUTLOOK_OFFLINE_ACCESS_SCOPE, OUTLOOK_MAIL_READ_SCOPE, OUTLOOK_USER_READ_SCOPE]),
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-pkce-verifier');
    expect(url.searchParams.get('state')).toBe('raw-state');
    expect([...states.records.values()][0]).toMatchObject({
      authority: 'common',
      redirectUri: REDIRECT_URI,
      scope: OUTLOOK_SCOPE,
      sealedPkceVerifier: 'sealed:pkce-verifier',
    });
  });

  it('completeAuthorization_consumesStateOnceAndStoresOnlyVaultReference', async () => {
    const { service, provider, graph, vault } = harness();
    await begin(service);
    const result = await service.completeAuthorization({ state: 'raw-state', code: 'code-1' });

    expect(provider.exchangeAuthorizationCode).toHaveBeenCalledWith({
      code: 'code-1',
      codeVerifier: 'pkce-verifier',
      redirectUri: REDIRECT_URI,
    });
    expect(graph.getProfile).toHaveBeenCalledOnce();
    expect(vault.store).toHaveBeenCalledWith(
      { tenantId: TENANT_ID, accountId: ACCOUNT_ID },
      TOKENS,
    );
    expect(result).toEqual({
      tenantId: TENANT_ID,
      accountId: ACCOUNT_ID,
      credentialRef: 'vault://outlook/account-1',
      providerSubjectHash: '2'.repeat(64),
      providerUserId: 'provider-object-id-7',
      displayAddress: 'Owner@Example.test',
      initialCursor: { connector: 'outlook', version: 1, folders: [] },
    });
    await expect(
      service.completeAuthorization({ state: 'raw-state', code: 'code-2' }),
    ).rejects.toBeInstanceOf(OutlookOAuthStateError);
    expect(provider.exchangeAuthorizationCode).toHaveBeenCalledTimes(1);
  });

  it('completeAuthorization_whenExpiredOrDenied_burnsStateBeforeExchange', async () => {
    const expired = harness();
    await begin(expired.service);
    expired.clock.current = '2026-07-13T10:10:01.000Z';
    await expect(
      expired.service.completeAuthorization({ state: 'raw-state', code: 'late' }),
    ).rejects.toBeInstanceOf(OutlookOAuthStateError);
    expect(expired.provider.exchangeAuthorizationCode).not.toHaveBeenCalled();

    const denied = harness();
    await begin(denied.service);
    await expect(
      denied.service.completeAuthorization({ state: 'raw-state', error: 'access_denied' }),
    ).rejects.toBeInstanceOf(OutlookOAuthCallbackError);
    await expect(
      denied.service.completeAuthorization({ state: 'raw-state', code: 'replay' }),
    ).rejects.toBeInstanceOf(OutlookOAuthStateError);
    expect(denied.provider.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it('completeAuthorization_whenStoredBoundaryOrGrantedScopesDiffer_failsClosed', async () => {
    const altered = harness();
    await begin(altered.service);
    const [digest, state] = [...altered.states.records.entries()][0]!;
    altered.states.records.set(digest, {
      ...state,
      redirectUri: 'https://attacker.invalid/callback',
    });
    await expect(
      altered.service.completeAuthorization({ state: 'raw-state', code: 'code-1' }),
    ).rejects.toBeInstanceOf(OutlookOAuthCallbackError);
    expect(altered.provider.exchangeAuthorizationCode).not.toHaveBeenCalled();

    const missingScopeTokens: OutlookOAuthTokenSet = {
      ...TOKENS,
      grantedScopes: [OUTLOOK_USER_READ_SCOPE],
    };
    const missingScope = harness(missingScopeTokens);
    await begin(missingScope.service);
    await expect(
      missingScope.service.completeAuthorization({ state: 'raw-state', code: 'code-1' }),
    ).rejects.toBeInstanceOf(OutlookOAuthCallbackError);
    expect(missingScope.graph.getProfile).not.toHaveBeenCalled();
    expect(missingScope.vault.store).not.toHaveBeenCalled();
  });

  it('completeAuthorization_whenPkceGrantIsRejected_burnsStateWithoutStoringTokens', async () => {
    const { service, provider, vault } = harness();
    await begin(service);
    vi.mocked(provider.exchangeAuthorizationCode).mockRejectedValue(
      new OutlookProviderError('invalid_grant', 400),
    );

    await expect(
      service.completeAuthorization({ state: 'raw-state', code: 'wrong-verifier-code' }),
    ).rejects.toBeInstanceOf(OutlookOAuthCallbackError);
    await expect(
      service.completeAuthorization({ state: 'raw-state', code: 'replayed-code' }),
    ).rejects.toBeInstanceOf(OutlookOAuthStateError);
    expect(vault.store).not.toHaveBeenCalled();
  });
});

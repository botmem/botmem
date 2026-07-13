import { describe, expect, it, vi } from 'vitest';
import { connectorAccountId, tenantId } from '@botmem-v2/connector-domain';
import {
  GMAIL_OAUTH_SCOPE,
  GmailOAuthCallbackError,
  GmailOAuthService,
  GmailOAuthStateError,
  type GmailApiPort,
  type GmailClockPort,
  type GmailCredentialVaultPort,
  type GmailCryptoPort,
  type GmailOAuthProviderPort,
  type GmailOAuthStateRepository,
  type OAuthTokenSet,
  type PendingGmailOAuthState,
} from './index.js';

const TENANT_ID = tenantId('10000000-0000-4000-8000-000000000001');
const ACCOUNT_ID = connectorAccountId('20000000-0000-4000-8000-000000000001');
const REDIRECT_URI = 'https://api.botmem.test/v2/connectors/gmail/callback';
const TOKENS: OAuthTokenSet = Object.freeze({
  accessToken: 'access-token-fixture',
  refreshToken: 'refresh-token-fixture',
  expiresAt: '2026-07-13T11:00:00.000Z',
  grantedScopes: GMAIL_OAUTH_SCOPE.split(' '),
  tokenType: 'Bearer',
});

class StateRepository implements GmailOAuthStateRepository {
  public readonly records = new Map<string, PendingGmailOAuthState>();

  public async save(state: PendingGmailOAuthState) {
    if (this.records.has(state.stateDigest)) throw new Error('state collision');
    this.records.set(state.stateDigest, state);
  }

  public async consume(stateDigest: string, now: string) {
    const state = this.records.get(stateDigest) ?? null;
    this.records.delete(stateDigest);
    return state && Date.parse(state.expiresAt) > Date.parse(now) ? state : null;
  }
}

class FixtureCrypto implements GmailCryptoPort {
  private randomIndex = 0;
  public async randomUrlSafe() {
    return ['raw-state', 'pkce-verifier'][this.randomIndex++] ?? 'unused-random';
  }
  public async sha256Base64Url(value: string) {
    return `challenge-${value}`;
  }
  public async sha256Hex(value: string) {
    return value === 'raw-state' ? '1'.repeat(64) : '2'.repeat(64);
  }
  public async sealEphemeral(value: string) {
    return `sealed:${value}`;
  }
  public async openEphemeral(value: string) {
    return value.replace(/^sealed:/, '');
  }
}

function harness() {
  const states = new StateRepository();
  const clock: GmailClockPort & { current: string } = {
    current: '2026-07-13T10:00:00.000Z',
    now() {
      return this.current;
    },
  };
  const provider: GmailOAuthProviderPort = {
    exchangeAuthorizationCode: vi.fn().mockResolvedValue(TOKENS),
  };
  const gmail: GmailApiPort = {
    getIdentity: vi.fn().mockResolvedValue({
      subject: 'google-subject-123',
      emailAddress: 'Owner@Example.com',
      emailVerified: true,
    }),
    getProfile: vi.fn().mockResolvedValue({
      emailAddress: 'Owner@Example.com',
      historyId: 'history-100',
      messagesTotal: 5,
    }),
    listMessages: vi.fn(),
    listHistory: vi.fn(),
    getMessage: vi.fn(),
  };
  const vault: GmailCredentialVaultPort = {
    store: vi.fn().mockResolvedValue('vault://gmail/account-1'),
    read: vi.fn(),
    rotate: vi.fn(),
    revoke: vi.fn(),
  };
  const service = new GmailOAuthService(
    { clientId: 'server-owned-client-id', redirectUri: REDIRECT_URI },
    states,
    new FixtureCrypto(),
    clock,
    provider,
    gmail,
    vault,
  );
  return { service, states, clock, provider, gmail, vault };
}

async function begin(service: GmailOAuthService) {
  return service.beginAuthorization({ tenantId: TENANT_ID, accountId: ACCOUNT_ID });
}

describe('GmailOAuthService', () => {
  it('beginAuthorization_usesExactServerRedirectAndMinimalMailIdentityScopesWithPkce', async () => {
    const { service, states } = harness();
    const result = await begin(service);
    const url = new URL(result.authorizationUrl);

    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('server-owned-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.getAll('scope')).toEqual([GMAIL_OAUTH_SCOPE]);
    expect(result.authorizationUrl).not.toContain('contacts.readonly');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-pkce-verifier');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('state')).toBe('raw-state');
    expect([...states.records.values()][0]).toMatchObject({
      redirectUri: REDIRECT_URI,
      scope: GMAIL_OAUTH_SCOPE,
      sealedPkceVerifier: 'sealed:pkce-verifier',
    });
  });

  it('completeAuthorization_consumesStateOnceAndPersistsOnlyVaultReference', async () => {
    const { service, provider, vault } = harness();
    await begin(service);
    const completed = await service.completeAuthorization({ state: 'raw-state', code: 'code-1' });

    expect(provider.exchangeAuthorizationCode).toHaveBeenCalledWith({
      code: 'code-1',
      codeVerifier: 'pkce-verifier',
      redirectUri: REDIRECT_URI,
    });
    expect(vault.store).toHaveBeenCalledWith(
      { tenantId: TENANT_ID, accountId: ACCOUNT_ID },
      TOKENS,
    );
    expect(completed).toMatchObject({
      tenantId: TENANT_ID,
      accountId: ACCOUNT_ID,
      credentialRef: 'vault://gmail/account-1',
      providerSubjectHash: '2'.repeat(64),
      emailAddress: 'Owner@Example.com',
      initialCursor: { mode: 'full', pageToken: null, anchorHistoryId: null },
    });
    await expect(
      service.completeAuthorization({ state: 'raw-state', code: 'code-2' }),
    ).rejects.toBeInstanceOf(GmailOAuthStateError);
    expect(provider.exchangeAuthorizationCode).toHaveBeenCalledTimes(1);
  });

  it('completeAuthorization_whenStateExpired_failsClosedBeforeProviderExchange', async () => {
    const { service, clock, provider } = harness();
    await begin(service);
    clock.current = '2026-07-13T10:10:01.000Z';

    await expect(
      service.completeAuthorization({ state: 'raw-state', code: 'late-code' }),
    ).rejects.toBeInstanceOf(GmailOAuthStateError);
    expect(provider.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it('completeAuthorization_whenCallbackDenied_burnsStateAndCannotReplay', async () => {
    const { service, provider } = harness();
    await begin(service);

    await expect(
      service.completeAuthorization({ state: 'raw-state', error: 'access_denied' }),
    ).rejects.toBeInstanceOf(GmailOAuthCallbackError);
    await expect(
      service.completeAuthorization({ state: 'raw-state', code: 'replayed-code' }),
    ).rejects.toBeInstanceOf(GmailOAuthStateError);
    expect(provider.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it('completeAuthorization_whenStoredScopeOrRedirectChanges_failsBeforeExchange', async () => {
    const { service, states, provider } = harness();
    await begin(service);
    const [digest, pending] = [...states.records.entries()][0]!;
    states.records.set(digest, {
      ...pending,
      redirectUri: 'https://attacker.invalid/callback',
      scope: 'https://www.googleapis.com/auth/gmail.modify',
    });

    await expect(
      service.completeAuthorization({ state: 'raw-state', code: 'code-1' }),
    ).rejects.toBeInstanceOf(GmailOAuthCallbackError);
    expect(provider.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it('completeAuthorization_whenOpenIdIdentityDoesNotMatchMailbox_rejectsBeforeVaultWrite', async () => {
    const { service, gmail, vault } = harness();
    vi.mocked(gmail.getIdentity).mockResolvedValue({
      subject: 'google-subject-123',
      emailAddress: 'different@example.com',
      emailVerified: true,
    });
    await begin(service);

    await expect(
      service.completeAuthorization({ state: 'raw-state', code: 'code-1' }),
    ).rejects.toBeInstanceOf(GmailOAuthCallbackError);
    expect(vault.store).not.toHaveBeenCalled();
  });
});

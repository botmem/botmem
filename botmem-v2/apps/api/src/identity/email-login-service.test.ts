import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OpaqueCredentialService } from './credential-service.js';
import {
  EmailLoginService,
  LoginChallengeRejectedError,
  LoginDeliveryUnavailableError,
} from './email-login-service.js';
import type { AuthenticatedPrincipal, CredentialKind, CredentialSnapshot } from './domain.js';
import type {
  CredentialRepositoryPort,
  LoginChallengePrincipal,
  LoginChallengeRepositoryPort,
  LoginDeliveryPort,
  TokenSecurityPort,
} from './ports.js';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const USER_ID = '20000000-0000-4000-8000-000000000001';
const CHALLENGE_ID = '30000000-0000-4000-8000-000000000001';
const LOGIN_TOKEN = `bml_v2.${'L'.repeat(43)}`;
const SESSION_TOKEN = `bms_v2.${'S'.repeat(43)}`;

class LoginTokens implements TokenSecurityPort {
  async issue(kind: CredentialKind) {
    const value = kind === 'browser_session' ? SESSION_TOKEN : `bmp_v2.${'P'.repeat(43)}`;
    return { value, hashHex: await this.hash(value), prefix: 'SessionToken' };
  }
  async issueLoginToken() {
    return { value: LOGIN_TOKEN, hashHex: await this.hash(LOGIN_TOKEN) };
  }
  async hash(value: string): Promise<string> {
    return createHash('sha256').update(value).digest('hex');
  }
  uuid(): string {
    return CHALLENGE_ID;
  }
}

class LoginChallenges implements LoginChallengeRepositoryPort {
  beginInputs: Parameters<LoginChallengeRepositoryPort['begin']>[0][] = [];
  rateInputs: Parameters<LoginChallengeRepositoryPort['consumeRateLimit']>[0][] = [];
  cancelled: string[] = [];
  available = true;
  consumed = false;
  async begin(input: Parameters<LoginChallengeRepositoryPort['begin']>[0]) {
    this.beginInputs.push(input);
    return this.available;
  }
  async consumeRateLimit(input: Parameters<LoginChallengeRepositoryPort['consumeRateLimit']>[0]) {
    this.rateInputs.push(input);
    return true;
  }
  async consume(): Promise<LoginChallengePrincipal | null> {
    if (this.consumed) return null;
    this.consumed = true;
    return loginPrincipal();
  }
  async cancel(input: { secretHashHex: string }): Promise<void> {
    this.cancelled.push(input.secretHashHex);
  }
}

class Delivery implements LoginDeliveryPort {
  ready = true;
  fail = false;
  sent: Parameters<LoginDeliveryPort['deliverSignInLink']>[0][] = [];
  async readiness(): Promise<boolean> {
    return this.ready;
  }
  async deliverSignInLink(input: Parameters<LoginDeliveryPort['deliverSignInLink']>[0]) {
    if (this.fail) throw new Error('provider unavailable');
    this.sent.push(input);
  }
}

class Credentials implements CredentialRepositoryPort {
  issued: CredentialSnapshot[] = [];
  async authenticate(): Promise<AuthenticatedPrincipal | null> {
    return null;
  }
  async issue(input: CredentialSnapshot): Promise<void> {
    this.issued.push(input);
  }
  async rotate(): Promise<void> {}
  async revoke(): Promise<boolean> {
    return false;
  }
  async listPersonalAccessTokens() {
    return [];
  }
  async revokePersonalAccessToken(): Promise<boolean> {
    return false;
  }
}

function fixture() {
  const challenges = new LoginChallenges();
  const delivery = new Delivery();
  const credentialRepository = new Credentials();
  const tokens = new LoginTokens();
  const clock = { nowMs: () => Date.parse('2026-07-13T10:00:00.000Z') };
  const credentialService = new OpaqueCredentialService(credentialRepository, tokens, clock, {
    cookieName: 'botmem_session',
    sessionTtlMs: 86_400_000,
    patMaxTtlMs: 86_400_000,
  });
  const login = new EmailLoginService(challenges, delivery, credentialService, tokens, clock, {
    publicWebBaseUrl: 'https://app.botmem.example',
  });
  return { login, challenges, delivery, credentialRepository, tokens };
}

describe('EmailLoginService', () => {
  it('begin_withReadyDelivery_storesOnlyHashesAndPutsTokenInUrlFragment', async () => {
    const { login, challenges, delivery, tokens } = fixture();
    await login.begin(' Owner@Example.com ', '203.0.113.10');
    expect(challenges.beginInputs[0]).toMatchObject({
      emailLookupHashHex: await tokens.hash('email:owner@example.com'),
      secretHashHex: await tokens.hash(LOGIN_TOKEN),
    });
    expect(JSON.stringify(challenges.beginInputs)).not.toContain(LOGIN_TOKEN);
    expect(challenges.rateInputs.map((input) => input.bucketHashHex)).toEqual([
      await tokens.hash('email-login-rate:email:owner@example.com'),
      await tokens.hash('email-login-rate:client:203.0.113.10'),
      await tokens.hash('email-login-rate:global'),
    ]);
    expect(JSON.stringify(challenges.rateInputs)).not.toContain('owner@example.com');
    expect(JSON.stringify(challenges.rateInputs)).not.toContain('203.0.113.10');
    expect(delivery.sent[0]?.email).toBe('owner@example.com');
    const url = new URL(delivery.sent[0]?.url ?? '');
    expect(url.search).toBe('');
    expect(url.hash).toContain(encodeURIComponent(LOGIN_TOKEN));
  });

  it('begin_whenDeliveryIsUnconfigured_failsBeforeAccountLookup', async () => {
    const { login, challenges, delivery } = fixture();
    delivery.ready = false;
    await expect(login.begin('owner@example.com', '203.0.113.10')).rejects.toBeInstanceOf(
      LoginDeliveryUnavailableError,
    );
    expect(challenges.beginInputs).toEqual([]);
  });

  it('begin_whenProviderFails_cancelsChallengeButHidesOutcomeFromCaller', async () => {
    const { login, challenges, delivery, tokens } = fixture();
    delivery.fail = true;
    await expect(login.begin('owner@example.com', '203.0.113.10')).resolves.toBeUndefined();
    expect(challenges.cancelled).toEqual([await tokens.hash(LOGIN_TOKEN)]);
  });

  it('complete_consumesChallengeOnceAndIssuesOpaqueSession', async () => {
    const { login, credentialRepository } = fixture();
    await expect(login.complete(LOGIN_TOKEN)).resolves.toMatchObject({ value: SESSION_TOKEN });
    expect(credentialRepository.issued[0]).toMatchObject({
      kind: 'browser_session',
      scopes: ['browser'],
      workspaceId: WORKSPACE_ID,
    });
    expect(JSON.stringify(credentialRepository.issued)).not.toContain(SESSION_TOKEN);
    await expect(login.complete(LOGIN_TOKEN)).rejects.toBeInstanceOf(LoginChallengeRejectedError);
  });
});

function loginPrincipal(): LoginChallengePrincipal {
  return {
    tenantId: WORKSPACE_ID,
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    membershipRole: 'owner',
    challengeId: CHALLENGE_ID,
  };
}

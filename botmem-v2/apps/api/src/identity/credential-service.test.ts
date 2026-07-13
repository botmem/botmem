import { describe, expect, it } from 'vitest';
import { WorkspaceAuthorizationError } from '../search-api.js';
import { OpaqueCredentialService } from './credential-service.js';
import type { AuthenticatedPrincipal, CredentialKind, CredentialSnapshot } from './domain.js';
import type { CredentialRepositoryPort, TokenSecurityPort } from './ports.js';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const SESSION = `bms_v2.${'A'.repeat(43)}`;
const PAT = `bmp_v2.${'B'.repeat(43)}`;

class MemoryCredentials implements CredentialRepositoryPort {
  readonly issued: CredentialSnapshot[] = [];
  readonly rotated: CredentialSnapshot[] = [];
  readonly rotatedFromHashes: string[] = [];
  readonly revoked: string[] = [];
  constructor(readonly principals = new Map<string, AuthenticatedPrincipal>()) {}
  async authenticate(input: {
    secretHashHex: string;
    expectedKind: CredentialKind;
  }): Promise<AuthenticatedPrincipal | null> {
    const principal = this.principals.get(input.secretHashHex) ?? null;
    return principal?.credentialKind === input.expectedKind ? principal : null;
  }
  async issue(credential: CredentialSnapshot): Promise<void> {
    this.issued.push(credential);
  }
  async rotate(input: {
    currentSecretHashHex: string;
    replacement: CredentialSnapshot;
  }): Promise<void> {
    this.rotatedFromHashes.push(input.currentSecretHashHex);
    this.rotated.push(input.replacement);
  }
  async revoke(input: { secretHashHex: string }): Promise<boolean> {
    this.revoked.push(input.secretHashHex);
    return this.principals.delete(input.secretHashHex);
  }
}

class FixedTokenSecurity implements TokenSecurityPort {
  sequence = 1;
  async issue(kind: CredentialKind) {
    const value = kind === 'browser_session' ? `bms_v2.${'C'.repeat(43)}` : PAT;
    return {
      value,
      hashHex: kind === 'browser_session' ? 'c'.repeat(64) : 'd'.repeat(64),
      prefix: 'AbCdEfGh1234',
    };
  }
  async issueLoginToken() {
    const value = `bml_v2.${'L'.repeat(43)}`;
    return { value, hashHex: `hash:${value}` };
  }
  async hash(value: string): Promise<string> {
    return `hash:${value}`;
  }
  uuid(): string {
    return `40000000-0000-4000-8000-${String(this.sequence++).padStart(12, '0')}`;
  }
}

function principal(kind: CredentialKind = 'browser_session'): AuthenticatedPrincipal {
  return {
    tenantId: WORKSPACE_ID,
    workspaceId: WORKSPACE_ID,
    userId: '20000000-0000-4000-8000-000000000001',
    membershipRole: 'owner',
    credentialId: '30000000-0000-4000-8000-000000000001',
    credentialKind: kind,
    scopes: kind === 'browser_session' ? ['browser'] : ['botmem:search'],
    expiresAt: '2026-07-20T10:00:00.000Z',
  };
}

function service(repository: MemoryCredentials): OpaqueCredentialService {
  return new OpaqueCredentialService(
    repository,
    new FixedTokenSecurity(),
    { nowMs: () => Date.parse('2026-07-13T10:00:00.000Z') },
    { cookieName: 'botmem_session', sessionTtlMs: 86_400_000, patMaxTtlMs: 7 * 86_400_000 },
  );
}

describe('OpaqueCredentialService', () => {
  it('authorize_withOpaqueSession_returnsOnlyItsWorkspace', async () => {
    const repository = new MemoryCredentials(new Map([[`hash:${SESSION}`, principal()]]));
    const credentials = service(repository);
    await expect(
      credentials.authorize(WORKSPACE_ID, { cookieHeader: `botmem_session=${SESSION}` }),
    ).resolves.toBe(WORKSPACE_ID);
    await expect(
      credentials.authorize('10000000-0000-4000-8000-000000000002', {
        cookieHeader: `botmem_session=${SESSION}`,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('authorize_withMalformedOrAmbiguousCredential_returnsUniform401', async () => {
    const credentials = service(new MemoryCredentials());
    for (const structured of [
      {},
      { authorizationHeader: `Bearer ${PAT}`, cookieHeader: `botmem_session=${SESSION}` },
      { authorizationHeader: `Bearer ${SESSION}` },
    ]) {
      await expect(credentials.authorize(WORKSPACE_ID, structured)).rejects.toBeInstanceOf(
        WorkspaceAuthorizationError,
      );
      await expect(credentials.authorize(WORKSPACE_ID, structured)).rejects.toMatchObject({
        status: 401,
      });
    }
  });

  it('issuePat_fromBrowserSession_persistsOnlyHashAndReturnsSecretOnce', async () => {
    const repository = new MemoryCredentials();
    const issued = await service(repository).issuePersonalAccessToken(
      principal(),
      'Codex CLI',
      86_400_000,
    );
    expect(issued.value).toBe(PAT);
    expect(repository.issued[0]).toMatchObject({
      kind: 'personal_access_token',
      secretHashHex: 'd'.repeat(64),
      label: 'Codex CLI',
    });
    expect(JSON.stringify(repository.issued[0])).not.toContain(PAT);
  });

  it('rotateSession_preservesAuthorityAndAtomicallyReplacesPresentedHash', async () => {
    const repository = new MemoryCredentials(new Map([[`hash:${SESSION}`, principal()]]));
    const rotated = await service(repository).rotate({
      cookieHeader: `botmem_session=${SESSION}`,
    });
    expect(rotated.credential.value).toBe(`bms_v2.${'C'.repeat(43)}`);
    expect(repository.rotatedFromHashes).toEqual([`hash:${SESSION}`]);
    expect(repository.rotated[0]).toMatchObject({
      kind: 'browser_session',
      rotatedFromCredentialId: '30000000-0000-4000-8000-000000000001',
      scopes: ['browser'],
    });
  });
});

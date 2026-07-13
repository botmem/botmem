import { describe, expect, it } from 'vitest';
import { CredentialAggregate } from './domain.js';

const BASE = {
  credentialId: '10000000-0000-4000-8000-000000000001',
  tenantId: '20000000-0000-4000-8000-000000000001',
  workspaceId: '20000000-0000-4000-8000-000000000001',
  userId: '30000000-0000-4000-8000-000000000001',
  secretHashHex: 'a'.repeat(64),
  tokenPrefix: 'AbCdEfGh1234',
  label: 'Browser session',
  createdAt: '2026-07-13T10:00:00.000Z',
  expiresAt: '2026-07-20T10:00:00.000Z',
} as const;

describe('CredentialAggregate', () => {
  it('issue_withBrowserAuthority_createsImmutableSnapshot', () => {
    const snapshot = CredentialAggregate.issue({
      ...BASE,
      kind: 'browser_session',
      scopes: ['browser'],
    }).view();
    expect(snapshot.kind).toBe('browser_session');
    expect(Object.isFrozen(snapshot.scopes)).toBe(true);
  });

  it('issue_withWrongScopeOrExpiry_rejectsAuthorityEscalation', () => {
    expect(() =>
      CredentialAggregate.issue({
        ...BASE,
        kind: 'browser_session',
        scopes: ['botmem:search'],
      }),
    ).toThrow(/browser scope/u);
    expect(() =>
      CredentialAggregate.issue({
        ...BASE,
        kind: 'personal_access_token',
        scopes: ['botmem:search'],
        expiresAt: BASE.createdAt,
      }),
    ).toThrow(/expiry/u);
  });
});

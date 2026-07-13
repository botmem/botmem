import { describe, expect, it } from 'vitest';
import {
  PersonalAccessTokenIssueResponseSchema,
  PersonalAccessTokenMetadataSchema,
} from './credentials.js';

describe('personal access token contracts', () => {
  it('keeps list metadata free of reusable or hashed secret material', () => {
    const metadata = PersonalAccessTokenMetadataSchema.parse({
      version: 2,
      credentialId: '10000000-0000-4000-8000-000000000001',
      label: 'Codex CLI',
      tokenPrefix: 'AbCdEfGh1234',
      scopes: ['botmem:search'],
      createdAt: '2026-07-13T10:00:00.000Z',
      expiresAt: '2026-08-13T10:00:00.000Z',
      lastUsedAt: null,
    });
    expect(metadata).not.toHaveProperty('accessToken');
    expect(metadata).not.toHaveProperty('secretHash');
  });

  it('accepts the opaque secret only on the one-time issue response', () => {
    expect(() =>
      PersonalAccessTokenIssueResponseSchema.parse({
        version: 2,
        credentialId: '10000000-0000-4000-8000-000000000001',
        accessToken: `bmp_v2.${'A'.repeat(43)}`,
        expiresAt: '2026-08-13T10:00:00.000Z',
      }),
    ).not.toThrow();
  });
});

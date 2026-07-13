import { describe, expect, it } from 'vitest';
import { EmailLoginCompleteRequestSchema, EmailLoginStartRequestSchema } from './auth.js';

describe('email login contracts', () => {
  it('EmailLoginStartRequestSchema_acceptsOnlyAnEmailAndDoesNotAcceptRedirectsOrWorkspaceHints', () => {
    expect(() =>
      EmailLoginStartRequestSchema.parse({
        version: 2,
        email: 'owner@example.com',
        redirectUri: 'https://evil.example.test',
      }),
    ).toThrow();
    expect(
      EmailLoginStartRequestSchema.parse({
        version: 2,
        email: 'owner@example.com',
      }),
    ).toMatchObject({ email: 'owner@example.com' });
    expect(() =>
      EmailLoginStartRequestSchema.parse({
        version: 2,
        workspaceId: '8e5ffcc7-8e8f-4aaa-9c77-b87a979c60cf',
        email: 'owner@example.com',
      }),
    ).toThrow();
  });

  it('EmailLoginCompleteRequestSchema_acceptsOnlyTheVersionedOpaqueTokenShape', () => {
    expect(
      EmailLoginCompleteRequestSchema.parse({
        token: 'bml_v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      }),
    ).toBeDefined();
    expect(() => EmailLoginCompleteRequestSchema.parse({ token: 'bad' })).toThrow();
  });
});

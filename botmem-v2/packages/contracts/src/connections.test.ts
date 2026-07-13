import { describe, expect, it } from 'vitest';
import {
  BeginOAuthConnectionResponseSchema,
  HostedConnectionSchema,
  OwnTracksConnectionRequestSchema,
} from './connections.js';

describe('connection contracts', () => {
  it('HostedConnectionSchema_rejectsMismatchedSourceAndAuthType', () => {
    expect(() =>
      HostedConnectionSchema.parse({
        id: '10000000-0000-4000-8000-000000000001',
        connector: 'gmail',
        authType: 'basic',
        label: 'owner@example.com',
        state: 'ready',
        source: { connector: 'outlook', readiness: 'connected', searchable: false },
      }),
    ).toThrow();
  });

  it('BeginOAuthConnectionResponseSchema_rejectsHttpCredentialsAndFragments', () => {
    const base = {
      version: 2,
      connector: 'gmail',
      accountId: '10000000-0000-4000-8000-000000000001',
      expiresAt: '2026-07-13T10:10:00.000Z',
    } as const;
    expect(() =>
      BeginOAuthConnectionResponseSchema.parse({
        ...base,
        authorizationUrl: 'http://accounts.example.test/oauth',
      }),
    ).toThrow();
    expect(() =>
      BeginOAuthConnectionResponseSchema.parse({
        ...base,
        authorizationUrl: 'https://user:secret@accounts.example.test/oauth#token',
      }),
    ).toThrow();
  });

  it('OwnTracksConnectionRequestSchema_acceptsOnlyHttpsAndNeverDefinesAResponseSecret', () => {
    expect(() =>
      OwnTracksConnectionRequestSchema.parse({
        version: 2,
        endpoint: 'http://recorder.example.test',
        username: 'owner',
        password: 'secret',
      }),
    ).toThrow();
    expect(
      OwnTracksConnectionRequestSchema.parse({
        version: 2,
        endpoint: 'https://recorder.example.test',
        username: 'owner',
        password: 'secret',
      }),
    ).toMatchObject({ endpoint: 'https://recorder.example.test' });
  });
});

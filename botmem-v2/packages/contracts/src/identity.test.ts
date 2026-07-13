import { describe, expect, it } from 'vitest';
import { parseBrowserSession, parseWorkspaceId } from './identity.js';

describe('workspace identity contract', () => {
  it('parseWorkspaceId_whenUuidIsValid_acceptsCanonicalIdentity', () => {
    expect(parseWorkspaceId('8e5ffcc7-8e8f-4aaa-9c77-b87a979c60cf')).toBe(
      '8e5ffcc7-8e8f-4aaa-9c77-b87a979c60cf',
    );
  });

  it('parseWorkspaceId_whenValueIsArbitraryText_rejectsIdentity', () => {
    expect(() => parseWorkspaceId('sentinel-workspace')).toThrow();
  });
});

describe('browser session contract', () => {
  it('parseBrowserSession_whenBearerTokenIsInjected_rejectsSecretMaterial', () => {
    expect(() =>
      parseBrowserSession({
        version: 2,
        workspaceId: '8e5ffcc7-8e8f-4aaa-9c77-b87a979c60cf',
        accessToken: 'must-not-be-browser-readable',
      }),
    ).toThrow();
  });
});

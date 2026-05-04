import { describe, expect, it } from 'vitest';
import { resolveBuildMetadata } from '../version.controller';

describe('VersionController build metadata', () => {
  it('uses explicit production build metadata', () => {
    expect(
      resolveBuildMetadata({
        BOTMEM_BUILD_VERSION: 'v1.2.3',
        BOTMEM_BUILD_SHA: '1234567890abcdef',
      }),
    ).toEqual({ version: 'v1.2.3', gitHash: '1234567890ab' });
  });

  it('does not emit unknown metadata placeholders', () => {
    const metadata = resolveBuildMetadata({
      BOTMEM_BUILD_VERSION: '',
      BOTMEM_BUILD_SHA: '',
      GITHUB_SHA: '',
      PATH: '',
    });

    expect(metadata.version).toBeUndefined();
    expect(metadata.gitHash).not.toBe('unknown');
  });
});

import { describe, expect, it } from 'vitest';
import { PublicReleaseConfigurationSchema } from './releases.js';

const SHA256 = 'a'.repeat(64);

describe('public release configuration', () => {
  it('accepts immutable versioned macOS and CLI artifacts', () => {
    expect(
      PublicReleaseConfigurationSchema.parse({
        version: 2,
        apiBaseUrl: 'https://api.botmem.example/',
        macos: {
          available: true,
          url: 'https://github.com/botmem/botmem/releases/download/botmem-v2-v2.4.1/Botmem.dmg',
          releaseVersion: '2.4.1',
          sha256: SHA256,
        },
        cli: {
          available: true,
          url: 'https://github.com/botmem/botmem/releases/download/botmem-v2-v2.4.1/botmem-v2-cli-2.4.1.tgz',
          releaseVersion: '2.4.1',
          sha256: SHA256,
        },
      }).cli,
    ).toMatchObject({ available: true, releaseVersion: '2.4.1' });
  });

  it.each([
    'http://downloads.example.test/v2.4.1/Botmem.dmg',
    'https://downloads.example.test/latest/Botmem.dmg',
    'https://downloads.example.test/v2.4.1/Botmem.dmg?mutable=1',
    'https://downloads.example.test/v2.4.1/Botmem.zip',
  ])('rejects unsafe or mutable Mac artifact URL %s', (url) => {
    expect(() =>
      PublicReleaseConfigurationSchema.parse({
        version: 2,
        apiBaseUrl: 'https://api.botmem.example/',
        macos: { available: true, url, releaseVersion: '2.4.1', sha256: SHA256 },
        cli: { available: false },
      }),
    ).toThrow();
  });
});

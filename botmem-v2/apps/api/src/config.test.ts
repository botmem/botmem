import { describe, expect, it } from 'vitest';
import { parseRuntimeConfig } from './config.js';

const PEPPER = Buffer.alloc(32, 7).toString('base64url');

describe('parseRuntimeConfig', () => {
  it('production_withCompleteSecureEnvironment_returnsNormalizedConfig', () => {
    const config = parseRuntimeConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://api:secret@db.internal/botmem?sslmode=require',
      PUBLIC_BASE_URL: 'https://api.botmem.example',
      PUBLIC_WEB_URL: 'https://app.botmem.example',
      AUTH_TOKEN_PEPPER: PEPPER,
      TRUSTED_ORIGINS: 'https://app.botmem.example,https://api.botmem.example',
    });

    expect(config).toMatchObject({
      secureCookies: true,
      sessionCookieName: '__Host-botmem_session',
      publicBaseUrl: 'https://api.botmem.example',
      publicWebBaseUrl: 'https://app.botmem.example',
      publicReleases: {
        macos: { available: false },
        cli: { available: false },
      },
    });
    expect(config.trustedOrigins).toEqual([
      'https://api.botmem.example',
      'https://app.botmem.example',
    ]);
    expect(config.tokenPepper).toHaveLength(32);
  });

  it('releaseArtifacts_requireCompleteImmutableRuntimeMetadata', () => {
    const base = {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost/botmem',
      PUBLIC_BASE_URL: 'http://127.0.0.1:12412',
      PUBLIC_WEB_URL: 'http://127.0.0.1:12412',
      AUTH_TOKEN_PEPPER: PEPPER,
    };
    const config = parseRuntimeConfig({
      ...base,
      BOTMEM_MAC_DMG_URL:
        'https://github.com/botmem/botmem/releases/download/botmem-v2-v2.4.1/Botmem.dmg',
      BOTMEM_MAC_DMG_VERSION: '2.4.1',
      BOTMEM_MAC_DMG_SHA256: 'a'.repeat(64),
      BOTMEM_CLI_TGZ_URL:
        'https://github.com/botmem/botmem/releases/download/botmem-v2-v2.4.1/botmem-v2-cli-2.4.1.tgz',
      BOTMEM_CLI_TGZ_VERSION: '2.4.1',
      BOTMEM_CLI_TGZ_SHA256: 'b'.repeat(64),
    });
    expect(config.publicReleases).toMatchObject({
      macos: { available: true, releaseVersion: '2.4.1' },
      cli: { available: true, releaseVersion: '2.4.1' },
    });
    expect(() =>
      parseRuntimeConfig({
        ...base,
        BOTMEM_MAC_DMG_URL: 'https://downloads.example.test/latest/Botmem.dmg',
        BOTMEM_MAC_DMG_VERSION: '2.4.1',
        BOTMEM_MAC_DMG_SHA256: 'a'.repeat(64),
      }),
    ).toThrow(/invalid or mutable/u);
    expect(() =>
      parseRuntimeConfig({
        ...base,
        BOTMEM_CLI_TGZ_VERSION: '2.4.1',
      }),
    ).toThrow(/configured together/u);
  });

  it('resendConfiguration_requiresKeyAndSenderTogether', () => {
    expect(() =>
      parseRuntimeConfig({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://localhost/botmem',
        PUBLIC_BASE_URL: 'http://127.0.0.1:12412',
        PUBLIC_WEB_URL: 'http://127.0.0.1:12412',
        AUTH_TOKEN_PEPPER: PEPPER,
        RESEND_API_KEY: 're_configured_key',
      }),
    ).toThrow(/configured together/u);
  });

  it('resendConfiguration_withKeyAndSender_enablesRealDeliveryAdapterConfiguration', () => {
    const config = parseRuntimeConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost/botmem',
      PUBLIC_BASE_URL: 'http://127.0.0.1:12412',
      PUBLIC_WEB_URL: 'http://127.0.0.1:12412',
      AUTH_TOKEN_PEPPER: PEPPER,
      RESEND_API_KEY: 're_configured_key',
      LOGIN_EMAIL_FROM: 'Botmem <login@botmem.example>',
    });

    expect(config.resendLogin).toEqual({
      apiKey: 're_configured_key',
      from: 'Botmem <login@botmem.example>',
    });
  });

  it('production_withInsecureOrigin_failsClosed', () => {
    expect(() =>
      parseRuntimeConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://api:secret@db.internal/botmem',
        PUBLIC_BASE_URL: 'http://api.botmem.example',
        PUBLIC_WEB_URL: 'https://app.botmem.example',
        AUTH_TOKEN_PEPPER: PEPPER,
      }),
    ).toThrow(/HTTPS/u);
  });

  it('production_withoutDatabaseTls_failsClosed', () => {
    expect(() =>
      parseRuntimeConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://api:secret@db.internal/botmem',
        PUBLIC_BASE_URL: 'https://api.botmem.example',
        PUBLIC_WEB_URL: 'https://app.botmem.example',
        AUTH_TOKEN_PEPPER: PEPPER,
      }),
    ).toThrow(/sslmode/u);
  });

  it('environment_withShortPepperOrNonPostgresDatabase_failsClosed', () => {
    const base = {
      NODE_ENV: 'test',
      PUBLIC_BASE_URL: 'http://127.0.0.1:12412',
      PUBLIC_WEB_URL: 'http://127.0.0.1:12412',
    };
    expect(() =>
      parseRuntimeConfig({
        ...base,
        DATABASE_URL: 'sqlite:///tmp/test',
        AUTH_TOKEN_PEPPER: PEPPER,
      }),
    ).toThrow(/DATABASE_URL/u);
    expect(() =>
      parseRuntimeConfig({
        ...base,
        DATABASE_URL: 'postgresql://localhost/botmem',
        AUTH_TOKEN_PEPPER: 'short',
      }),
    ).toThrow(/32 bytes/u);
  });

  it('malformedDatabaseUrl_neverRetainsThePresentedSecretInTheError', () => {
    const secret = 'do-not-log-this-password';
    let caught: unknown;
    try {
      parseRuntimeConfig({
        NODE_ENV: 'test',
        DATABASE_URL: `postgresql://api:${secret}@[invalid/botmem`,
        PUBLIC_BASE_URL: 'http://127.0.0.1:12412',
        PUBLIC_WEB_URL: 'http://127.0.0.1:12412',
        AUTH_TOKEN_PEPPER: PEPPER,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toBe('RuntimeConfigError: DATABASE_URL must be a valid URL');
    expect(JSON.stringify(caught)).not.toContain(secret);
  });
});

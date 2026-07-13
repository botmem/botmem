import { describe, expect, it } from 'vitest';

import { parseMigratorConfig } from './config.js';

const PASSWORD = 'A'.repeat(32);

describe('parseMigratorConfig', () => {
  it('accepts only the secret-separated production connection contract', () => {
    const config = parseMigratorConfig({
      NODE_ENV: 'production',
      DATABASE_URL:
        'postgresql://botmem_v2_migrator_login@postgres:5432/botmem_v2?sslmode=verify-full&sslrootcert=%2Frun%2Fsecrets%2Finternal_ca_crt',
      DATABASE_PASSWORD: PASSWORD,
    });

    expect(config.expectedLogin).toBe('botmem_v2_migrator_login');
    expect(config.databasePassword).toBe(PASSWORD);
    expect(config.databaseUrl).not.toContain(PASSWORD);
  });

  it.each([
    [{ NODE_ENV: 'production', DATABASE_PASSWORD: PASSWORD }, 'database_url_missing'],
    [
      {
        NODE_ENV: 'production',
        DATABASE_URL: 'https://example.test/x',
        DATABASE_PASSWORD: PASSWORD,
      },
      'database_url_invalid',
    ],
    [
      {
        NODE_ENV: 'production',
        DATABASE_URL:
          'postgresql://wrong@postgres/botmem_v2?sslmode=verify-full&sslrootcert=%2Frun%2Fsecrets%2Finternal_ca_crt',
        DATABASE_PASSWORD: PASSWORD,
      },
      'database_login_invalid',
    ],
    [
      {
        NODE_ENV: 'production',
        DATABASE_URL:
          'postgresql://botmem_v2_migrator_login:leak@postgres/botmem_v2?sslmode=verify-full&sslrootcert=%2Frun%2Fsecrets%2Finternal_ca_crt',
        DATABASE_PASSWORD: PASSWORD,
      },
      'database_login_invalid',
    ],
    [
      {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://botmem_v2_migrator_login@postgres/botmem_v2',
        DATABASE_PASSWORD: PASSWORD,
      },
      'database_tls_invalid',
    ],
    [
      {
        NODE_ENV: 'production',
        DATABASE_URL:
          'postgresql://botmem_v2_migrator_login@postgres/botmem_v2?sslmode=verify-full&sslrootcert=%2Frun%2Fsecrets%2Finternal_ca_crt',
        DATABASE_PASSWORD: 'short',
      },
      'database_password_invalid',
    ],
    [
      {
        NODE_ENV: 'production',
        MIGRATOR_EXPECTED_LOGIN: 'override',
        DATABASE_URL:
          'postgresql://override@postgres/botmem_v2?sslmode=verify-full&sslrootcert=%2Frun%2Fsecrets%2Finternal_ca_crt',
        DATABASE_PASSWORD: PASSWORD,
      },
      'production_login_override_rejected',
    ],
    [
      {
        NODE_ENV: 'production',
        MIGRATIONS_DIR: '/tmp/migrations',
        DATABASE_URL:
          'postgresql://botmem_v2_migrator_login@postgres/botmem_v2?sslmode=verify-full&sslrootcert=%2Frun%2Fsecrets%2Finternal_ca_crt',
        DATABASE_PASSWORD: PASSWORD,
      },
      'production_migration_directory_override_rejected',
    ],
  ] as const)('rejects unsafe production configuration with %s', (environment, code) => {
    expect(() => parseMigratorConfig(environment)).toThrow(code);
  });
});

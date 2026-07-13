import { resolve } from 'node:path';

export interface MigratorConfig {
  readonly databaseUrl: string;
  readonly databasePassword?: string;
  readonly expectedLogin: string;
  readonly migrationsDirectory: string;
  readonly lockTimeoutMs: number;
  readonly connectAttempts: number;
  readonly connectRetryMs: number;
}

export function parseMigratorConfig(
  environment: Readonly<Record<string, string | undefined>>,
): MigratorConfig {
  const production = (environment['NODE_ENV'] ?? 'production') === 'production';
  const expectedLogin =
    environment['MIGRATOR_EXPECTED_LOGIN']?.trim() || 'botmem_v2_migrator_login';
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(expectedLogin)) {
    throw new MigratorConfigError('expected_login_invalid');
  }
  if (production && expectedLogin !== 'botmem_v2_migrator_login') {
    throw new MigratorConfigError('production_login_override_rejected');
  }

  const databaseValue = environment['DATABASE_URL']?.trim();
  if (!databaseValue) throw new MigratorConfigError('database_url_missing');
  let database: URL;
  try {
    database = new URL(databaseValue);
  } catch {
    throw new MigratorConfigError('database_url_invalid');
  }
  if (!['postgres:', 'postgresql:'].includes(database.protocol)) {
    throw new MigratorConfigError('database_url_invalid');
  }
  if (decodeURIComponent(database.username) !== expectedLogin || database.password) {
    throw new MigratorConfigError('database_login_invalid');
  }
  if (production && database.searchParams.get('sslmode') !== 'verify-full') {
    throw new MigratorConfigError('database_tls_invalid');
  }
  if (production) {
    const parameters = [...database.searchParams.keys()];
    if (
      parameters.length !== 2 ||
      new Set(parameters).size !== 2 ||
      parameters.some((parameter) => !['sslmode', 'sslrootcert'].includes(parameter)) ||
      database.searchParams.get('sslrootcert') !== '/run/secrets/internal_ca_crt'
    ) {
      throw new MigratorConfigError('database_tls_invalid');
    }
    if (database.pathname !== '/botmem_v2') {
      throw new MigratorConfigError('database_name_invalid');
    }
  }

  const password = environment['DATABASE_PASSWORD'];
  if (production && (!password || !/^[A-Za-z0-9_-]{32,128}$/u.test(password))) {
    throw new MigratorConfigError('database_password_invalid');
  }
  const configuredMigrationsDirectory = environment['MIGRATIONS_DIR']?.trim();
  if (
    production &&
    configuredMigrationsDirectory &&
    configuredMigrationsDirectory !== '/app/migrations'
  ) {
    throw new MigratorConfigError('production_migration_directory_override_rejected');
  }
  const migrationsDirectory = resolve(configuredMigrationsDirectory || '/app/migrations');
  return Object.freeze({
    databaseUrl: database.toString(),
    ...(password ? { databasePassword: password } : {}),
    expectedLogin,
    migrationsDirectory,
    lockTimeoutMs: integer(environment['MIGRATION_LOCK_TIMEOUT_MS'], 120_000, 1_000, 900_000),
    connectAttempts: integer(environment['MIGRATION_CONNECT_ATTEMPTS'], 30, 1, 100),
    connectRetryMs: integer(environment['MIGRATION_CONNECT_RETRY_MS'], 5_000, 100, 60_000),
  });
}

function integer(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new MigratorConfigError('numeric_config_invalid');
  }
  return parsed;
}

export class MigratorConfigError extends Error {
  override readonly name = 'MigratorConfigError';
  constructor(readonly code: string) {
    super(code);
  }
}

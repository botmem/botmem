#!/usr/bin/env node
import { MigratorConfigError, parseMigratorConfig } from './config.js';
import { discoverMigrations, MigrationInputError } from './migrations.js';
import { MigratorRuntimeError, runMigrations } from './runner.js';

function log(event: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify({ component: 'botmem-v2-migrator', ...event })}\n`);
}

try {
  const config = parseMigratorConfig(process.env);
  const migrations = await discoverMigrations(config.migrationsDirectory);
  log({ event: 'migration_set_verified', count: migrations.length });
  const result = await runMigrations(config, migrations, log);
  log({ event: 'migration_run_complete', ...result });
} catch (error) {
  const safe =
    error instanceof MigratorConfigError ||
    error instanceof MigrationInputError ||
    error instanceof MigratorRuntimeError
      ? {
          code: error.code,
          ...('script' in error && typeof error.script === 'string'
            ? { script: error.script }
            : {}),
        }
      : { code: 'migrator_unexpected_failure' };
  process.stderr.write(
    `${JSON.stringify({ component: 'botmem-v2-migrator', event: 'migration_run_failed', ...safe })}\n`,
  );
  process.exitCode = 1;
}
